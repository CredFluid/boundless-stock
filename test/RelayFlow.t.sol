// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { console2 } from "forge-std/console2.sol";
import { RelayFixture } from "./helpers/RelayFixture.sol";
import { SwapTypes } from "../src/relay/SwapTypes.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title RelayFlow
 * @notice End-to-end integration tests for the relay stack, in Foundry.
 *
 * @dev These complement the TypeScript validation suite rather than duplicating it. The TS
 *      suite proves the *deployment* works across separate chains with a real relayer; these
 *      prove the *contracts* behave correctly, deterministically, and can assert on internal
 *      state the TS suite cannot reach.
 */
contract RelayFlow is RelayFixture {
    using OptionsBuilder for bytes;

    address internal user;

    uint256 internal constant STOCK_SUPPLY = 1_000_000e18;
    uint256 internal constant QUOTE_SUPPLY = 50_000_000e6;
    uint256 internal constant STOCK_FLOAT = 100_000e18;
    uint256 internal constant QUOTE_FLOAT = 15_000_000e6;

    function setUp() public override {
        super.setUp();
        _setUpRelay(STOCK_SUPPLY, QUOTE_SUPPLY, STOCK_FLOAT, QUOTE_FLOAT);

        router.setPrice(150e6); // 150 USDC per stock, direction-aware

        user = makeAddr("user");
        vm.deal(user, 100 ether);
    }

    /// @dev Bridge quote asset to the user on the mirror chain — how they fund themselves.
    function _fundUserOnMirror(uint256 amount) internal {
        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(user))),
            amountLD: amount,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory fee = homeQuote.quoteSend(p, false);
        homeQuote.send{ value: fee.nativeFee }(p, fee, address(this));
        deliverAll();
    }

    /// @dev A Solana mirror is addressed in its own terms: compute units, and lamports the
    ///      executor forwards for rent. The options must carry exactly what was configured.
    function test_returnOptionsCarryPerDestinationGasAndValue() public {
        uint32 solanaEid = 40_168;
        assertEq(
            relay.returnOptions(solanaEid),
            OptionsBuilder
                .newOptions()
                .addExecutorLzReceiveOption(relay.DEFAULT_RETURN_GAS(), 0)
                .addExecutorLzComposeOption(0, relay.DEFAULT_RETURN_COMPOSE_GAS(), 0)
        );

        relay.setReturnGas(solanaEid, 400_000);
        relay.setReturnComposeGas(solanaEid, 600_000);
        relay.setReturnValue(solanaEid, 2_500_000);
        assertEq(
            relay.returnOptions(solanaEid),
            OptionsBuilder
                .newOptions()
                .addExecutorLzReceiveOption(400_000, 2_500_000)
                .addExecutorLzComposeOption(0, 600_000, 0)
        );

        vm.prank(user);
        vm.expectRevert();
        relay.setReturnValue(solanaEid, 1);
    }

    function test_buyDeliversStockOnTheMirrorChain() public {
        uint256 spend = 15_000e6;
        _fundUserOnMirror(spend);

        assertEq(mirrorQuote.balanceOf(user), spend, "user should hold USDC on the mirror");
        assertEq(mirrorStock.balanceOf(user), 0, "user should hold no stock yet");

        uint256 minOut = 95e18; // 15,000 / 150 = 100, allow 5%
        vm.startPrank(user);
        mirrorQuote.approve(address(request), spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, spend, minOut);
        uint64 id = request.buy{ value: fee.nativeFee }(spend, minOut);
        vm.stopPrank();

        assertEq(mirrorQuote.balanceOf(user), 0, "the user's money must leave their wallet");

        deliverAll();

        SwapRequest_Request memory r = _getRequest(id);
        assertEq(uint8(r.status), uint8(SwapTypes.Status.FILLED), "request must settle as FILLED");
        assertEq(mirrorStock.balanceOf(user), 100e18, "stock must land in the user's wallet on the mirror");
        assertEq(r.amountOut, 100e18, "settlement must report what was actually delivered");

        console2.log("bought stock on mirror:", mirrorStock.balanceOf(user));
    }

    function test_sellDeliversQuoteOnTheMirrorChain() public {
        // Give the user stock on the mirror first.
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



        vm.startPrank(user);
        mirrorStock.approve(address(request), 10e18);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, 10e18, 1e6);
        uint64 id = request.sell{ value: fee.nativeFee }(10e18, 1e6);
        vm.stopPrank();

        deliverAll();

        SwapRequest_Request memory r = _getRequest(id);
        assertEq(uint8(r.status), uint8(SwapTypes.Status.FILLED), "sell must settle as FILLED");
        assertEq(mirrorQuote.balanceOf(user), 1500e6, "proceeds must land on the mirror chain");
    }

    function test_failedSwapRefundsTheUserOnTheMirrorChain() public {
        uint256 spend = 15_000e6;
        _fundUserOnMirror(spend);
        router.setForceRevert(true);

        vm.startPrank(user);
        mirrorQuote.approve(address(request), spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, spend, 1);
        uint64 id = request.buy{ value: fee.nativeFee }(spend, 1);
        vm.stopPrank();

        assertEq(mirrorQuote.balanceOf(user), 0, "money leaves on submit");

        deliverAll();

        SwapRequest_Request memory r = _getRequest(id);
        assertEq(uint8(r.status), uint8(SwapTypes.Status.REFUNDED), "must settle as REFUNDED");
        assertEq(mirrorQuote.balanceOf(user), spend, "the user must get every unit back");
        assertEq(mirrorStock.balanceOf(user), 0, "no stock on a failed buy");
    }

    /**
     * @notice With matching 18-decimal tokens, a floor one wei above the output still refunds.
     * @dev The floor crosses in shared decimals (6). Rounded down, 100e18 + 1 would arrive as
     *      exactly 100 and the swap would fill below what the user asked for.
     */
    function test_floorFinerThanSharedPrecisionRoundsUp() public {
        uint256 spend = 15_000e6;
        _fundUserOnMirror(spend);

        vm.startPrank(user);
        mirrorQuote.approve(address(request), spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, spend, 100e18 + 1);
        uint64 id = request.buy{ value: fee.nativeFee }(spend, 100e18 + 1);
        vm.stopPrank();
        deliverAll();

        assertEq(uint8(_getRequest(id).status), uint8(SwapTypes.Status.REFUNDED), "must not fill below the floor");
        assertEq(mirrorQuote.balanceOf(user), spend, "refunded in full");
    }

    /// @dev Helper mirroring SwapRequest.Request, since structs don't cross the ABI cleanly.
    struct SwapRequest_Request {
        address user;
        uint8 direction;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 amountOut;
        uint64 createdAt;
        uint64 settledAt;
        SwapTypes.Status status;
        uint8 failureReason;
        uint64 lzNonce;
    }

    function _getRequest(uint64 id) internal view returns (SwapRequest_Request memory out) {
        (
            address u,
            uint8 dir,
            address tIn,
            address tOut,
            uint256 aIn,
            uint256 minOut,
            uint256 aOut,
            uint64 created,
            uint64 settled,
            SwapTypes.Status st,
            uint8 reason,
            uint64 nonce
        ) = request.requests(id);
        out = SwapRequest_Request(u, dir, tIn, tOut, aIn, minOut, aOut, created, settled, st, reason, nonce);
    }
}
