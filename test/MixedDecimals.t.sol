// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { RelayFixture } from "./helpers/RelayFixture.sol";
import { SwapTypes } from "../src/relay/SwapTypes.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title MixedDecimals
 * @notice The home chain and a mirror chain disagree about the stock's local decimals.
 *
 * @dev This is the shape of a Solana mirror: an SPL amount is a u64, which holds at most
 *      ~18.4 whole units of an 18-decimal token, so the mint there has to use fewer decimals
 *      than the home chain's ERC-20. Modelled here with EVM tokens so the relay contracts are
 *      exercised for real — 18 decimals on the home chain, 9 on the mirror, 6 shared.
 *
 *      Before wire amounts moved to shared decimals, a mirror-side `minAmountOut` of 101e9
 *      (101 stock at 9 decimals) was read on the home chain as 101e9 at 18 decimals —
 *      0.000000101 stock — so an unsatisfiable floor filled anyway. The slippage protection
 *      was gone without any error.
 */
contract MixedDecimals is RelayFixture {
    using OptionsBuilder for bytes;

    uint8 internal constant MIRROR_STOCK_DECIMALS = 9;

    address internal user;

    function _mirrorStockDecimals() internal pure override returns (uint8) {
        return MIRROR_STOCK_DECIMALS;
    }

    function setUp() public override {
        super.setUp();
        _setUpRelay(1_000_000e18, 50_000_000e6, 100_000e18, 15_000_000e6);
        router.setPrice(150e6);
        user = makeAddr("user");
        vm.deal(user, 100 ether);
    }

    function _fundQuoteOnMirror(uint256 amount) internal {
        _bridgeToUser(address(homeQuote), amount);
    }

    function _bridgeToUser(address token, uint256 amount) internal {
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
        if (token == address(homeStock)) {
            fee = homeStock.quoteSend(p, false);
            homeStock.send{ value: fee.nativeFee }(p, fee, address(this));
        } else {
            homeQuote.send{ value: fee.nativeFee }(p, fee, address(this));
        }
        deliverAll();
    }

    function _buy(uint256 spend, uint256 minOut) internal returns (uint64 id) {
        vm.startPrank(user);
        mirrorQuote.approve(address(request), spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, spend, minOut);
        id = request.buy{ value: fee.nativeFee }(spend, minOut);
        vm.stopPrank();
        deliverAll();
    }

    function _status(uint64 id) internal view returns (SwapTypes.Status) {
        return request.getRequest(id).status;
    }

    function test_mirrorReallyHasDifferentDecimals() public view {
        assertEq(homeStock.decimals(), 18);
        assertEq(mirrorStock.decimals(), MIRROR_STOCK_DECIMALS);
    }

    function test_buyDeliversAtTheMirrorsOwnPrecision() public {
        _fundQuoteOnMirror(15_000e6);
        uint64 id = _buy(15_000e6, 95e9); // 95 stock, in the mirror's 9 decimals

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED), "must fill");
        assertEq(mirrorStock.balanceOf(user), 100e9, "100 stock, expressed in 9 decimals");
        assertEq(request.getRequest(id).amountOut, 100e9, "recorded in the mirror's decimals");
    }

    /// @notice The regression: a floor above what the pool gives must refund, at any decimals.
    function test_slippageFloorIsHonouredAcrossDecimals() public {
        _fundQuoteOnMirror(15_000e6);
        uint64 id = _buy(15_000e6, 101e9); // the pool gives 100; the user demands 101

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.REFUNDED), "an unmet floor must refund");
        assertEq(mirrorQuote.balanceOf(user), 15_000e6, "input returned in full");
        assertEq(mirrorStock.balanceOf(user), 0, "no stock below the user's floor");
    }

    /// @notice A floor exactly at the pool's output fills.
    function test_floorAtExactOutputFills() public {
        _fundQuoteOnMirror(15_000e6);
        uint64 id = _buy(15_000e6, 100e9);
        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED));
    }

    /**
     * @notice A floor one base unit above the output must refund, even though that unit is
     *         finer than the shared precision.
     * @dev 100e9 + 1 at 9 decimals is 100.000000001 stock, which shared decimals (6) cannot
     *      represent. Rounding the floor DOWN would send 100.000000 and fill below what the user
     *      asked for; rounding UP sends 100.000001 and the unmet floor refunds.
     */
    function test_subQuantumFloorRoundsUpNotDown() public {
        _fundQuoteOnMirror(15_000e6);
        uint64 id = _buy(15_000e6, 100e9 + 1);
        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.REFUNDED), "must not fill below the floor");
    }

    function test_sellFromTheLowerPrecisionMirror() public {
        _bridgeToUser(address(homeStock), 10e18);
        assertEq(mirrorStock.balanceOf(user), 10e9, "10 stock arrives as 10e9 on the mirror");

        vm.startPrank(user);
        mirrorStock.approve(address(request), 10e9);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, 10e9, 1_500e6);
        uint64 id = request.sell{ value: fee.nativeFee }(10e9, 1_500e6);
        vm.stopPrank();
        deliverAll();

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED), "sell must fill");
        assertEq(mirrorQuote.balanceOf(user), 1_500e6, "10 x 150 USDC");
    }

    /**
     * @notice The settlement that reaches the mirror carries shared-decimal amounts and names
     *         the user.
     * @dev Read off the wire — the `ComposeSent` the mirror's endpoint queued — rather than from
     *      either contract's own view, because the point is what a mirror on ANOTHER VM will
     *      receive. A Solana mirror relies on both fields: it cannot scale an 18-decimal figure
     *      into a u64, and it must name the user's token account before delivery runs.
     */
    function test_settlementOnTheWireIsDecimalFreeAndNamesTheUser() public {
        _fundQuoteOnMirror(15_000e6);

        vm.startPrank(user);
        mirrorQuote.approve(address(request), 15_000e6);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, 15_000e6, 95e9);
        uint64 id = request.buy{ value: fee.nativeFee }(15_000e6, 95e9);
        vm.stopPrank();

        deliverAll();
        SwapTypes.Settlement memory s = _lastSettlementTo(address(request));

        assertEq(s.requestId, id);
        assertEq(s.status, uint8(SwapTypes.Status.FILLED));
        assertEq(s.amountOut, 100e6, "100 stock at 6 shared decimals, not 100e18 or 100e9");
        assertEq(s.amountIn, 15_000e6, "15,000 USDC at 6 shared decimals");
        assertEq(s.recipient, bytes32(uint256(uint160(user))), "must name the user");
    }

    /// @dev Decodes the settlement in the last compose queued for `_to`.
    ///      OFT compose frame: nonce (8) | srcEid (4) | amountLD (32) | composeFrom (32) | msg.
    function _lastSettlementTo(address _to) internal view returns (SwapTypes.Settlement memory) {
        bytes memory message = lastComposeTo[_to];
        require(message.length > 76, "no settlement composed to that address");
        bytes memory body = new bytes(message.length - 76);
        for (uint256 j = 0; j < body.length; j++) body[j] = message[76 + j];
        return SwapTypes.decodeSettlement(body);
    }
}
