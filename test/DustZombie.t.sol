// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { console2 } from "forge-std/console2.sol";
import { RelayFixture } from "./helpers/RelayFixture.sol";
import { SwapTypes } from "../src/relay/SwapTypes.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @notice Regression test for a zombie-request bug found by the invariant fuzzer.
 *
 * @dev A trade whose entire input sits below the OFT's precision floor bridges as zero. The
 *      home chain then has nothing to swap and nothing to send back, so the request stays
 *      PENDING forever — the user loses nothing (their dust is returned) but the request can
 *      never settle. `invariant_requestStatesAreCoherent` caught it via "a request must record
 *      a non-zero input".
 *
 *      SwapRequest now rejects such trades at submission.
 */
contract DustZombieRegression is RelayFixture {
    using OptionsBuilder for bytes;
    address internal user;

    function setUp() public override {
        super.setUp();
        _setUpRelay(1_000_000e18, 50_000_000e6, 200_000e18, 30_000_000e6);
        router.setPrice(150e6);
        user = makeAddr("user");
        vm.deal(user, 100 ether);

        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(user))),
            amountLD: 1e18,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory f = homeStock.quoteSend(p, false);
        homeStock.send{ value: f.nativeFee }(p, f, address(this));
        deliverAll();
    }

    /// @dev A sub-quantum trade must be rejected rather than creating an unsettleable request.
    function test_dustSizedTradeIsRejected() public {
        uint256 dust = 500; // below the 1e12 quantum of an 18-decimal OFT
        assertLt(dust, 1e12, "must be smaller than one shared unit");

        uint256 balBefore = mirrorStock.balanceOf(user);
        uint256 countBefore = request.requestCount();

        vm.startPrank(user);
        mirrorStock.approve(address(request), dust);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, dust, 0);
        vm.expectRevert();
        request.sell{ value: fee.nativeFee }(dust, 0);
        vm.stopPrank();

        assertEq(mirrorStock.balanceOf(user), balBefore, "a rejected trade must not touch the user's balance");
        assertEq(request.requestCount(), countBefore, "a rejected trade must not create a request");
    }

    /// @dev The smallest bridgeable amount must still work — the guard must not be too broad.
    function test_exactlyOneQuantumIsAccepted() public {
        uint256 quantum = 1e12;

        vm.startPrank(user);
        mirrorStock.approve(address(request), quantum);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, quantum, 0);
        uint64 id = request.sell{ value: fee.nativeFee }(quantum, 0);
        vm.stopPrank();

        (, , , , uint256 amountIn, , , , , SwapTypes.Status status, ) = request.requests(id);
        assertEq(amountIn, quantum, "one quantum must bridge intact");
        assertEq(uint8(status), uint8(SwapTypes.Status.PENDING), "and create a real request");
        console2.log("one quantum accepted, amountIn:", amountIn);
    }

    /// @dev A trade with dust ON TOP of a bridgeable amount keeps the bridgeable part.
    function test_partialDustIsTrimmedNotRejected() public {
        uint256 amount = 3e12 + 777;

        vm.startPrank(user);
        mirrorStock.approve(address(request), amount);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, amount, 0);
        uint64 id = request.sell{ value: fee.nativeFee }(amount, 0);
        vm.stopPrank();

        (, , , , uint256 amountIn, , , , , , ) = request.requests(id);
        assertEq(amountIn, 3e12, "the bridgeable part must be kept and the remainder returned");
    }
}

/**
 * @notice Second zombie found by the fuzzer, on the RETURN leg.
 *
 * @dev When a swap succeeds but its output is smaller than one bridgeable unit, the OFT send
 *      quantises it to zero. The user's input has already been consumed by the venue, a
 *      settlement claiming FILLED arrives carrying nothing, and the user is told their trade
 *      succeeded while receiving zero. Caught by
 *      `invariant_fillsDeliverSomething` ("a FILLED request must have delivered a non-zero
 *      amount").
 */
contract DustOutputRegression is RelayFixture {
    using OptionsBuilder for bytes;
    address internal user;

    function setUp() public override {
        super.setUp();
        _setUpRelay(1_000_000e18, 50_000_000e6, 200_000e18, 30_000_000e6);
        user = makeAddr("user");
        vm.deal(user, 100 ether);

        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(user))),
            amountLD: 1_000_000e6,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory f = homeQuote.quoteSend(p, false);
        homeQuote.send{ value: f.nativeFee }(p, f, address(this));
        deliverAll();
    }

    /// @dev A buy whose output is sub-quantum must never report FILLED with nothing delivered.
    function test_subQuantumOutputIsNotReportedAsFilled() public {
        // A price so bad that 1000 USDC buys less than one bridgeable unit of stock (1e12).
        // A price so extreme that 1000 USDC buys less than one bridgeable unit of stock.
        router.setPrice(type(uint128).max);

        uint256 spend = 1000e6;
        vm.startPrank(user);
        mirrorQuote.approve(address(request), spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, spend, 0);
        uint64 id = request.buy{ value: fee.nativeFee }(spend, 0);
        vm.stopPrank();

        deliverAll();
        deliverAll();

        (, , , , , , uint256 amountOut, , , SwapTypes.Status status, ) = request.requests(id);
        console2.log("status (1=PENDING,2=FILLED):", uint8(status));
        console2.log("amountOut:", amountOut);
        console2.log("stock delivered to user:", mirrorStock.balanceOf(user));

        // The right outcome is a clean refund: the trade could never deliver anything, so the
        // venue rejects it and the user's money comes home rather than being consumed.
        assertTrue(status != SwapTypes.Status.FILLED, "must not report FILLED with a zero delivery");
        assertEq(uint8(status), uint8(SwapTypes.Status.REFUNDED), "an undeliverable trade must refund");
        assertEq(amountOut, 0, "nothing was delivered");
        assertEq(mirrorStock.balanceOf(user), 0, "and no stock reached the user");
        assertEq(mirrorQuote.balanceOf(user), 1_000_000e6, "the user's money must come back in full");
        console2.log("refunded to user:", mirrorQuote.balanceOf(user));
    }
}
