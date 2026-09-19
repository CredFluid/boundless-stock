// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { OmniToken } from "../../../src/core/OmniToken.sol";
import { SwapRequest } from "../../../src/relay/SwapRequest.sol";
import { SwapTypes } from "../../../src/relay/SwapTypes.sol";
import { MockSwapRouter } from "../../helpers/MockSwapRouter.sol";
import { MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";

interface IRelayFixture {
    function deliverAll() external;

    function deliverPacketsOnly() external;
}

/**
 * @notice Drives random trading against the relay pair, including adversarial conditions.
 *
 * @dev The fuzzer controls the price, whether the venue reverts, and whether delivery
 *      completes — so the campaign explores fills, slippage rejections, router failures and
 *      half-delivered messages in arbitrary interleavings. Those are precisely the states
 *      where accounting bugs hide; a handler that only ever produces happy paths would prove
 *      very little.
 */
contract TradeHandler is Test {
    IRelayFixture internal immutable fixture;
    SwapRequest internal immutable request;
    OmniToken internal immutable mirrorStock;
    OmniToken internal immutable mirrorQuote;
    MockSwapRouter internal immutable router;

    address[] internal actors;

    uint64[] public createdIds;
    /// @notice Request ids the handler has already observed in a terminal state.
    mapping(uint64 => bool) public seenSettled;
    /// @notice Settlement timestamp first observed for a request, to detect re-settlement.
    mapping(uint64 => uint64) public firstSettledAt;

    uint256 public callsBuy;
    uint256 public callsSell;
    uint256 public callsDeliver;
    uint256 public callsStall;
    uint256 public tradesSubmitted;
    uint256 public fillsObserved;
    uint256 public refundsObserved;

    constructor(
        address _fixture,
        address _request,
        address _mirrorStock,
        address _mirrorQuote,
        address _router,
        address[] memory _actors
    ) {
        fixture = IRelayFixture(_fixture);
        request = SwapRequest(payable(_request));
        mirrorStock = OmniToken(_mirrorStock);
        mirrorQuote = OmniToken(_mirrorQuote);
        router = MockSwapRouter(_router);
        actors = _actors;
    }

    receive() external payable {}

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function createdCount() external view returns (uint256) {
        return createdIds.length;
    }

    function createdAt(uint256 i) external view returns (uint64) {
        return createdIds[i];
    }

    // ------------------------------------------------------------------ actions

    function buy(uint256 actorSeed, uint256 amountSeed, uint256 minOutSeed) public {
        callsBuy++;
        _trade(SwapTypes.Direction.BUY, actorSeed, amountSeed, minOutSeed);
    }

    function sell(uint256 actorSeed, uint256 amountSeed, uint256 minOutSeed) public {
        callsSell++;
        _trade(SwapTypes.Direction.SELL, actorSeed, amountSeed, minOutSeed);
    }

    /// @notice Settle everything currently in flight.
    function deliver() public {
        callsDeliver++;
        try fixture.deliverAll() {} catch {}
        _observeSettlements();
    }

    /// @notice Deliver packets but skip composes — leaves tokens sitting in the relay,
    ///         reproducing an under-gassed or failing composed call.
    function stallCompose() public {
        callsStall++;
        try fixture.deliverPacketsOnly() {} catch {}
    }

    /**
     * @notice Move the venue's price around under the fuzzer's control.
     * @dev Bounded to a realistic band (50-500 quote per stock). An unbounded price makes every
     *      swap either revert on the venue's float or produce a sub-quantum output, so the
     *      campaign never reaches a fill — the properties would hold vacuously.
     */
    function setPrice(uint256 priceSeed) public {
        router.setPrice(bound(priceSeed, 50e6, 500e6));
    }

    /**
     * @notice Make the venue fail, or recover it.
     * @dev Takes a seed rather than a bool on purpose. Foundry fuzzes a `bool` parameter from a
     *      random byte and treats anything non-zero as true, so a bool argument is true roughly
     *      255 times out of 256 — a failure switch fuzzed that way is stuck ON, the venue never
     *      works, and nothing ever fills. Weighting it explicitly keeps failures frequent
     *      enough to matter and rare enough to leave a working venue most of the time.
     */
    function setVenueFailing(uint256 seed) public {
        router.setForceRevert(bound(seed, 0, 4) == 0); // ~20% of the time
    }

    /// @notice Make the venue return nothing — pathological but legal. Same weighting rationale.
    function setVenueZero(uint256 seed) public {
        router.setReturnZero(bound(seed, 0, 9) == 0); // ~10% of the time
    }

    // ------------------------------------------------------------------ internals

    function _trade(SwapTypes.Direction dir, uint256 actorSeed, uint256 amountSeed, uint256 minOutSeed) internal {
        address actor = actors[actorSeed % actors.length];
        OmniToken tokenIn = dir == SwapTypes.Direction.BUY ? mirrorQuote : mirrorStock;

        uint256 bal = tokenIn.balanceOf(actor);
        if (bal == 0) return;

        // Cap trade size so a single order cannot drain the venue's float, which would make
        // every subsequent swap revert for a reason unrelated to the properties under test.
        uint256 cap = dir == SwapTypes.Direction.BUY ? 500_000e6 : 5_000e18;
        uint256 amount = bound(amountSeed, 1, bal < cap ? bal : cap);

        // Anchor the slippage floor to what the venue would actually pay, then range from 0%
        // to 150% of it. Above 100% is unsatisfiable, so roughly a third of orders are
        // rejected on slippage and the rest fill — both paths get exercised. The first version
        // bounded minOut over the whole uint range, which made EVERY order unsatisfiable and
        // left the success path untested.
        // The venue prices by the HOME-chain token; the mirror token is its counterpart.
        address homeTokenIn = dir == SwapTypes.Direction.BUY ? router.quote() : router.stock();
        uint256 expected = router.quoteSwap(homeTokenIn, amount);
        uint256 minOut = (expected * bound(minOutSeed, 0, 150)) / 100;

        MessagingFee memory fee;
        try request.quoteTrade(dir, amount, minOut) returns (MessagingFee memory f) {
            fee = f;
        } catch {
            return;
        }

        // The fee is paid by whoever supplies `{value:}` — this handler, not the pranked actor.
        vm.deal(address(this), address(this).balance + fee.nativeFee);

        vm.prank(actor);
        tokenIn.approve(address(request), amount);

        vm.prank(actor);
        if (dir == SwapTypes.Direction.BUY) {
            try request.buy{ value: fee.nativeFee }(amount, minOut) returns (uint64 id) {
                createdIds.push(id);
                tradesSubmitted++;
            } catch {}
        } else {
            try request.sell{ value: fee.nativeFee }(amount, minOut) returns (uint64 id) {
                createdIds.push(id);
                tradesSubmitted++;
            } catch {}
        }
    }

    /// @dev Record the first terminal state seen for each request, so re-settlement is visible.
    function _observeSettlements() internal {
        for (uint256 i = 0; i < createdIds.length; i++) {
            uint64 id = createdIds[i];
            (, , , , , , , , uint64 settledAt, SwapTypes.Status status, ) = request.requests(id);
            if (status == SwapTypes.Status.PENDING) continue;

            if (!seenSettled[id]) {
                seenSettled[id] = true;
                firstSettledAt[id] = settledAt;
                if (status == SwapTypes.Status.FILLED) fillsObserved++;
                else refundsObserved++;
            }
        }
    }
}
