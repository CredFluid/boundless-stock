// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { console2 } from "forge-std/console2.sol";
import { RelayFixture } from "./helpers/RelayFixture.sol";
import { SwapTypes } from "../src/relay/SwapTypes.sol";
import { OmniToken } from "../src/core/OmniToken.sol";
import { Errors } from "@layerzerolabs/lz-evm-protocol-v2/contracts/libs/Errors.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title StuckMessageCancellation
 * @notice Recovery for a message that is never delivered at all.
 *
 * @dev This was written off earlier as a property of the bridge rather than something the
 *      application could fix, on the grounds that refunding a message which might still land
 *      would create the amount twice. That reasoning only holds for a *unilateral source-side
 *      refund*. It does not hold once the destination has proved the message can never execute.
 *
 *      The safety argument is entirely in the ordering: **kill, then authorise.**
 *
 *        1. On the destination, `skip` (and `burn` if it was verified) make the nonce
 *           permanently unexecutable and unverifiable.
 *        2. Only then does a cancellation message authorise the source to restore the input.
 *
 *      Reversing those two steps is the double spend. Performing them in this order cannot be,
 *      and `test_theKilledMessageCanNeverBeDeliveredAfterwards` is the assertion that actually
 *      carries the argument — the rest is bookkeeping.
 */
contract StuckMessageCancellation is RelayFixture {
    using OptionsBuilder for bytes;

    address internal user;
    uint256 internal constant SPEND = 15_000e6;

    function setUp() public override {
        super.setUp();
        _setUpRelay(1_000_000e18, 50_000_000e6, 200_000e18, 30_000_000e6);
        router.setPrice(150e6);

        user = makeAddr("user");
        vm.deal(user, 100 ether);

        // Give the user quote asset on the mirror chain, and settle that fully.
        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(user))),
            amountLD: 100_000e6,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory f = homeQuote.quoteSend(p, false);
        homeQuote.send{ value: f.nativeFee }(p, f, address(this));
        deliverAll();

        // The relay needs to be able to restore inputs and to kill stuck inbound messages.
        mirrorQuote.setRecoveryMinter(address(request));
        mirrorStock.setRecoveryMinter(address(request));
        homeQuote.setDelegate(address(relay));
        homeStock.setDelegate(address(relay));
    }

    /// @dev Submits a trade and deliberately never delivers it.
    function _submitAndStall() internal returns (uint64 id, uint64 nonce) {
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, SPEND, 0);
        id = request.buy{ value: fee.nativeFee }(SPEND, 0);
        vm.stopPrank();

        (, , , , , , , , , , , uint64 recorded) = request.requests(id);
        nonce = recorded;
    }

    /**
     * @notice The prerequisite: without the nonce, a stuck message cannot even be named.
     * @dev `oft.send()` returns it and the contract used to discard it. Recording it is cheap
     *      and impossible to reconstruct afterwards — recovery is not merely unbuilt without
     *      it, it is unreachable.
     */
    function test_theOutboundNonceIsRecorded() public {
        (uint64 id, uint64 nonce) = _submitAndStall();
        assertGt(nonce, 0, "the LayerZero nonce must be recorded against the request");
        assertEq(
            request.requestIdByNonce(address(mirrorQuote), nonce),
            id,
            "and must resolve back to the request, keyed by the OFT that sent it"
        );
    }

    /// @dev While stalled, the amount is on no chain at all — and the counters say so.
    function test_aStalledAmountIsVisibleAsInFlight() public {
        uint256 before = _aggregateQuote() + _inFlightQuote();
        _submitAndStall();

        assertEq(_inFlightQuote(), SPEND, "the stalled amount must show up as in flight");
        assertEq(
            _aggregateQuote() + _inFlightQuote(),
            before,
            "supply plus in-flight must be unchanged by a message merely being stuck"
        );
    }

    function test_cancellationRestoresTheInputAndClosesTheRequest() public {
        (uint64 id, uint64 nonce) = _submitAndStall();
        uint256 balanceAfterSubmit = mirrorQuote.balanceOf(user);

        // Kill it on the home chain. Never verified here, so the payload hash is zero and
        // `skip` alone is terminal.
        relay.cancelStuckInbound(
            MIRROR_EID,
            bytes32(uint256(uint160(address(mirrorQuote)))),
            address(homeQuote),
            nonce,
            bytes32(0)
        );

        // Deliver only the cancellation. The original is still sitting in the queue.
        deliverOnlyTo(MIRROR_EID, address(request));

        (, , , , , , , , , SwapTypes.Status status, , ) = request.requests(id);
        assertEq(uint8(status), uint8(SwapTypes.Status.CANCELLED), "the request must close as CANCELLED");
        assertEq(
            mirrorQuote.balanceOf(user) - balanceAfterSubmit,
            SPEND,
            "the user's input must be restored in full"
        );
        console2.log("restored to the user:", SPEND);
    }

    /**
     * @notice The assertion the whole design rests on.
     * @dev After the kill, delivering the original must be impossible. If it could still land,
     *      the user would hold the restored input *and* the home chain would mint the same
     *      amount again — the double spend the ordering exists to prevent.
     */
    function test_theKilledMessageCanNeverBeDeliveredAfterwards() public {
        (, uint64 nonce) = _submitAndStall();

        relay.cancelStuckInbound(
            MIRROR_EID,
            bytes32(uint256(uint160(address(mirrorQuote)))),
            address(homeQuote),
            nonce,
            bytes32(0)
        );
        deliverOnlyTo(MIRROR_EID, address(request));

        uint256 homeSupplyBefore = homeQuote.totalSupply();

        // Now try to deliver the original. The endpoint must refuse to verify it, and refuse
        // for the *right* reason: the path is no longer verifiable because `skip` advanced the
        // lazy nonce past it and left no payload hash behind. A bare `expectRevert` here would
        // pass on any failure at all, including one unrelated to the kill.
        vm.expectRevert(Errors.LZ_PathNotVerifiable.selector);
        this.attemptOriginalDelivery();

        assertEq(homeQuote.totalSupply(), homeSupplyBefore, "nothing may be minted on the home chain");
    }

    /// @dev External so the revert can be caught by `expectRevert`.
    function attemptOriginalDelivery() external {
        deliverOnlyTo(HOME_EID, address(homeQuote));
    }

    /// @dev Cancelling must not create value: it moves the in-flight amount back to a chain.
    function test_cancellationConservesSupply() public {
        uint256 before = _aggregateQuote() + _inFlightQuote();

        (, uint64 nonce) = _submitAndStall();
        relay.cancelStuckInbound(
            MIRROR_EID,
            bytes32(uint256(uint160(address(mirrorQuote)))),
            address(homeQuote),
            nonce,
            bytes32(0)
        );
        deliverOnlyTo(MIRROR_EID, address(request));

        assertEq(_inFlightQuote(), 0, "nothing should remain in flight once cancelled");
        assertEq(
            _aggregateQuote() + _inFlightQuote(),
            before,
            "supply plus in-flight must be identical before and after a cancellation"
        );
    }

    /// @dev A second cancellation for the same nonce must not pay out twice.
    function test_cancellingTwiceDoesNotPayTwice() public {
        (uint64 id, uint64 nonce) = _submitAndStall();
        bytes32 sender = bytes32(uint256(uint160(address(mirrorQuote))));

        relay.cancelStuckInbound(MIRROR_EID, sender, address(homeQuote), nonce, bytes32(0));
        deliverOnlyTo(MIRROR_EID, address(request));
        uint256 afterFirst = mirrorQuote.balanceOf(user);

        // Replaying the notice directly: the request is no longer PENDING, so it is ignored.
        deliverOnlyTo(MIRROR_EID, address(request));

        assertEq(mirrorQuote.balanceOf(user), afterFirst, "a repeat cancellation must pay nothing");
        (, , , , , , , , , SwapTypes.Status status, , ) = request.requests(id);
        assertEq(uint8(status), uint8(SwapTypes.Status.CANCELLED), "and must stay CANCELLED");
    }

    /**
     * @notice A buy and a sell can carry the SAME LayerZero nonce, and cancelling one must not
     *         touch the other.
     * @dev Nonces are per path. A buy leaves through the quote OFT and a sell through the stock
     *      OFT, so the first of each is nonce 1 on its own path. Keyed by nonce alone, the second
     *      record overwrites the first — and cancelling the stuck BUY would instead restore the
     *      SELL's input while the sell itself is still deliverable: the double spend the
     *      kill-then-authorise ordering exists to prevent.
     */
    function test_aBuyAndASellWithTheSameNonceAreNotConfused() public {
        // Give the user stock on the mirror so they can sell.
        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(user))),
            amountLD: 10e18,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory f = homeStock.quoteSend(p, false);
        homeStock.send{ value: f.nativeFee }(p, f, address(this));
        deliverAll();

        (uint64 buyId, uint64 buyNonce) = _submitAndStall();

        vm.startPrank(user);
        mirrorStock.approve(address(request), 10e18);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, 10e18, 0);
        uint64 sellId = request.sell{ value: fee.nativeFee }(10e18, 0);
        vm.stopPrank();
        (, , , , , , , , , , , uint64 sellNonce) = request.requests(sellId);
        assertEq(buyNonce, sellNonce, "precondition: both are the first message on their own path");

        uint256 stockBefore = mirrorStock.balanceOf(user);
        uint256 quoteBefore = mirrorQuote.balanceOf(user);

        // Kill the BUY only.
        relay.cancelStuckInbound(
            MIRROR_EID,
            bytes32(uint256(uint160(address(mirrorQuote)))),
            address(homeQuote),
            buyNonce,
            bytes32(0)
        );
        deliverOnlyTo(MIRROR_EID, address(request));

        (, , , , , , , , , SwapTypes.Status buyStatus, , ) = request.requests(buyId);
        (, , , , , , , , , SwapTypes.Status sellStatus, , ) = request.requests(sellId);
        assertEq(uint8(buyStatus), uint8(SwapTypes.Status.CANCELLED), "the cancelled buy must close");
        assertEq(uint8(sellStatus), uint8(SwapTypes.Status.PENDING), "the sell must be untouched");
        assertEq(mirrorQuote.balanceOf(user) - quoteBefore, SPEND, "the buy's USDC is restored");
        assertEq(mirrorStock.balanceOf(user), stockBefore, "the sell's stock is NOT restored");
    }

    /// @dev Only the mirror OFT's designated minter may restore supply.
    function test_recoveryCreditIsNotOpenToAnyone() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(OmniToken.OnlyRecoveryMinter.selector, attacker));
        mirrorQuote.recoveryCredit(attacker, 1_000_000e6);
    }

    function _aggregateQuote() internal view returns (uint256) {
        return homeQuote.totalSupply() + mirrorQuote.totalSupply();
    }

    function _inFlightQuote() internal view returns (uint256) {
        return homeQuote.bridgedOut() + mirrorQuote.bridgedOut() - homeQuote.bridgedIn() - mirrorQuote.bridgedIn();
    }
}
