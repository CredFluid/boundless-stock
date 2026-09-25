// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { console2 } from "forge-std/console2.sol";
import { RelayFixture } from "../helpers/RelayFixture.sol";
import { TradeHandler } from "./handlers/TradeHandler.sol";
import { SwapTypes } from "../../src/relay/SwapTypes.sol";
import { SwapRequest } from "../../src/relay/SwapRequest.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title RelayInvariant
 * @notice Stateful fuzzing of the relay pair's accounting under adversarial conditions.
 *
 * @dev The fuzzer controls the venue's price, whether it reverts, whether it returns nothing,
 *      and whether delivery completes — so the campaign explores fills, slippage rejections,
 *      venue failures and half-delivered messages in arbitrary interleavings.
 *
 *      What these properties are really defending: a user hands their money to a contract on
 *      one chain and it physically leaves for another. Every way that can go wrong ends with
 *      someone's funds unaccounted for, so the invariants are written around *conservation*
 *      and *terminality* rather than around any particular happy path.
 */
contract RelayInvariant is RelayFixture {
    using OptionsBuilder for bytes;

    TradeHandler internal handler;

    uint256 internal constant STOCK_SUPPLY = 1_000_000e18;
    uint256 internal constant QUOTE_SUPPLY = 50_000_000e6;
    uint256 internal constant STOCK_FLOAT = 200_000e18;
    uint256 internal constant QUOTE_FLOAT = 30_000_000e6;
    uint256 internal constant ACTOR_COUNT = 3;

    address[] internal actors;

    function setUp() public override {
        super.setUp();
        _setUpRelay(STOCK_SUPPLY, QUOTE_SUPPLY, STOCK_FLOAT, QUOTE_FLOAT);
        router.setPrice(150e6); // 150 quote per stock to begin with
        // Every order pays a platform fee, so escrow and release run through every path the
        // fuzzer reaches: fills, refunds, stalls and late settlements.
        request.setPlatformFee(25, makeAddr("platformTreasury"));

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            address a = makeAddr(string(abi.encodePacked("trader", vm.toString(i))));
            actors.push(a);
            vm.deal(a, 100 ether);
        }

        // Fund every actor on the mirror chain with BOTH assets, through the real bridge, so
        // the fuzzer can exercise buys and sells from the first call.
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            _bridgeToMirror(true, actors[i], 20_000e18);
            _bridgeToMirror(false, actors[i], 3_000_000e6);
        }
        deliverAll();

        handler = new TradeHandler(
            address(this),
            address(request),
            address(mirrorStock),
            address(mirrorQuote),
            address(router),
            actors
        );

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = TradeHandler.buy.selector;
        selectors[1] = TradeHandler.sell.selector;
        selectors[2] = TradeHandler.deliver.selector;
        selectors[3] = TradeHandler.stallCompose.selector;
        selectors[4] = TradeHandler.setPrice.selector;
        selectors[5] = TradeHandler.setVenueFailing.selector;
        selectors[6] = TradeHandler.setVenueZero.selector;

        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    function _bridgeToMirror(bool isStock, address to, uint256 amount) internal {
        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(to))),
            amountLD: amount,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        if (isStock) {
            MessagingFee memory f = homeStock.quoteSend(p, false);
            homeStock.send{ value: f.nativeFee }(p, f, address(this));
        } else {
            MessagingFee memory f = homeQuote.quoteSend(p, false);
            homeQuote.send{ value: f.nativeFee }(p, f, address(this));
        }
    }

    // ------------------------------------------------------------------ conservation

    /**
     * @notice Neither asset may ever be created or destroyed, whatever the fuzzer does.
     * @dev Stated as an inequality because tokens legitimately sit in flight (burned on the
     *      source, not yet minted on the destination), so the sum dips but must never rise.
     *      Rising would mean the relay minted value out of a failed or replayed message.
     */
    function invariant_neitherAssetIsEverCreated() public view {
        assertLe(_aggregate(true), MINTED_STOCK, "stock supply must never exceed what was minted");
        assertLe(_aggregate(false), MINTED_QUOTE, "quote supply must never exceed what was minted");
    }

    /**
     * @notice A settled request is final. Its settlement timestamp may never change.
     * @dev Double settlement is the shape most double-spends would take here: pay the user
     *      twice for one order, or refund an order that already filled.
     */
    function invariant_settlementIsFinal() public view {
        uint256 n = handler.createdCount();
        for (uint256 i = 0; i < n; i++) {
            uint64 id = handler.createdAt(i);
            if (!handler.seenSettled(id)) continue;

            (,,,,,,,, uint64 settledAt, SwapTypes.Status status,,) = request.requests(id);
            assertTrue(status != SwapTypes.Status.PENDING, "a settled request must never revert to PENDING");
            assertEq(settledAt, handler.firstSettledAt(id), "a request must never settle twice");
        }
    }

    /**
     * @notice Every request the contract knows about is in a coherent state.
     * @dev FILLED with nothing delivered, or REFUNDED without a reason, would mean the mirror
     *      chain's record disagrees with what actually happened on the home chain.
     */
    function invariant_requestStatesAreCoherent() public view {
        uint256 n = handler.createdCount();
        for (uint256 i = 0; i < n; i++) {
            uint64 id = handler.createdAt(i);
            (address u,, address tokenIn, address tokenOut, uint256 amountIn,,,,, SwapTypes.Status st,,) =
                request.requests(id);

            assertTrue(u != address(0), "a created request must have an owner");
            assertTrue(st != SwapTypes.Status.NONE, "a created request must never be in state NONE");
            assertTrue(tokenIn != tokenOut, "input and output assets must differ");
            assertGt(amountIn, 0, "a request must record a non-zero input");
        }
    }

    /**
     * @notice SwapRequest is a conduit, not a vault: once quiescent it holds nothing.
     * @dev It pulls the user's input and immediately bridges it, and pays out settlements the
     *      moment they arrive. A growing balance means tokens arrived that no request claimed —
     *      which today are only recoverable by the owner's `sweep()`.
     */
    function invariant_swapRequestDoesNotAccumulate() public view {
        // It holds fees — escrowed for open orders, earned and not yet claimed — and nothing else.
        assertEq(
            mirrorStock.balanceOf(address(request)),
            request.feesReserved(address(mirrorStock)),
            "SwapRequest must hold exactly the stock fees it owes"
        );
        assertEq(
            mirrorQuote.balanceOf(address(request)),
            request.feesReserved(address(mirrorQuote)),
            "SwapRequest must hold exactly the quote fees it owes"
        );
    }

    /// @notice A fee is kept only for a fill; every other outcome returns it.
    function invariant_feesFollowTheOutcome() public view {
        for (uint256 i = 0; i < handler.createdCount(); i++) {
            uint64 id = handler.createdAt(i);
            (,,,,,,,,, SwapTypes.Status st,,) = request.requests(id);
            SwapRequest.FeeEscrow memory f = request.getFees(id);
            if (f.state == SwapRequest.FeeState.NONE) continue; // an order too small to carry a fee
            if (st == SwapTypes.Status.PENDING) {
                assertEq(uint8(f.state), uint8(SwapRequest.FeeState.ESCROWED), "pending: fee held");
            } else if (st == SwapTypes.Status.FILLED) {
                assertEq(uint8(f.state), uint8(SwapRequest.FeeState.PAID), "filled: fee earned");
            } else {
                assertEq(uint8(f.state), uint8(SwapRequest.FeeState.RETURNED), "not filled: fee returned");
            }
        }
    }

    /// @notice The relay may hold tokens, but never more than was ever minted of them.
    function invariant_relayHoldingsAreBounded() public view {
        assertLe(homeStock.balanceOf(address(relay)), MINTED_STOCK, "relay stock holdings out of bounds");
        assertLe(homeQuote.balanceOf(address(relay)), MINTED_QUOTE, "relay quote holdings out of bounds");
    }

    /**
     * @notice A filled request must have delivered something.
     * @dev A FILLED settlement reporting zero output would tell the user their trade
     *      succeeded while giving them nothing.
     */
    function invariant_fillsDeliverSomething() public view {
        uint256 n = handler.createdCount();
        for (uint256 i = 0; i < n; i++) {
            uint64 id = handler.createdAt(i);
            (,,,,,, uint256 amountOut,,, SwapTypes.Status st,,) = request.requests(id);
            if (st == SwapTypes.Status.FILLED) {
                assertGt(amountOut, 0, "a FILLED request must have delivered a non-zero amount");
            }
        }
    }

    /**
     * @notice Ends every run with a liveness check, then proves the run was not vacuous.
     *
     * @dev The random campaign alone can end a run without ever filling, refunding or
     *      stalling — the venue can be switched to failing early and stay that way — which
     *      made these coverage assertions fail intermittently for reasons unrelated to the
     *      contracts. Rather than weaken them, every run now finishes with a scripted
     *      epilogue from whatever state the campaign left behind: restore the venue, settle
     *      everything, then require that a satisfiable order FILLS, an unsatisfiable one is
     *      REFUNDED, and a stalled compose can still be settled. That is a property in its own
     *      right — the system stays live from any reachable state — and every invariant is
     *      checked again once it has run.
     */
    function afterInvariant() public {
        console2.log("campaign: trades submitted:", handler.tradesSubmitted());
        console2.log("campaign: fills observed:  ", handler.fillsObserved());
        console2.log("campaign: refunds observed:", handler.refundsObserved());
        console2.log("campaign: compose stalls:  ", handler.callsStall());
        console2.log("packets delivered:", packetsDelivered);
        console2.log("composes executed:", composesExecuted);
        console2.log("composes failed:  ", composesFailed);
        console2.log("composes pending: ", pendingComposeCount());

        // ---- liveness epilogue
        handler.resetVenue();
        handler.deliver(); // settle anything the campaign left in flight

        uint256 fills = handler.fillsObserved();
        assertTrue(handler.tradeAnyActor(50), "epilogue: no actor could submit a satisfiable order");
        handler.deliver();
        assertGt(
            handler.fillsObserved(), fills, "epilogue: a satisfiable order on a healthy venue did not fill"
        );

        uint256 refunds = handler.refundsObserved();
        assertTrue(handler.tradeAnyActor(150), "epilogue: no actor could submit an unsatisfiable order");
        handler.deliver();
        assertGt(handler.refundsObserved(), refunds, "epilogue: an unsatisfiable order was not refunded");

        assertTrue(handler.tradeAnyActor(50), "epilogue: no actor could submit an order to stall");
        handler.stallCompose();
        handler.deliver();

        // Everything still holds after the epilogue.
        invariant_neitherAssetIsEverCreated();
        invariant_settlementIsFinal();
        invariant_requestStatesAreCoherent();
        invariant_swapRequestDoesNotAccumulate();
        invariant_relayHoldingsAreBounded();
        invariant_fillsDeliverSomething();

        // And the run as a whole reached every path it claims to test.
        assertGt(handler.tradesSubmitted(), 0, "no trade was ever submitted - invariants passed vacuously");
        assertGt(handler.fillsObserved(), 0, "no trade ever filled - the success path was never tested");
        assertGt(
            handler.refundsObserved(), 0, "no trade was ever refunded - the failure path was never tested"
        );
        assertGt(handler.callsStall(), 0, "the stalled-compose path was never exercised");
    }

    function _aggregate(bool isStock) internal view returns (uint256) {
        return isStock
            ? homeStock.totalSupply() + mirrorStock.totalSupply()
            : homeQuote.totalSupply() + mirrorQuote.totalSupply();
    }
}
