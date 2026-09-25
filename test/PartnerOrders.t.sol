// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { RelayFixture } from "./helpers/RelayFixture.sol";
import { SwapTypes } from "../src/relay/SwapTypes.sol";
import { SwapRequest } from "../src/relay/SwapRequest.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @dev A contract partner signer (a multisig or smart account) that approves one digest.
contract ApprovingWallet is IERC1271 {
    bytes32 public approved;

    function approve(bytes32 _digest) external {
        approved = _digest;
    }

    function isValidSignature(bytes32 _digest, bytes memory) external view returns (bytes4) {
        return _digest == approved ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/**
 * @title PartnerOrders
 * @notice Orders placed through a partner: the partner's signed authorisation, the gate that
 *         makes it mandatory, and the fees it carries.
 *
 * @dev The property that matters most: a fee is only ever kept when the order filled. On a
 *      refund, a cancellation or a strand the user gets back every unit they put in.
 */
contract PartnerOrders is RelayFixture {
    using OptionsBuilder for bytes;

    uint32 internal constant PARTNER = 7;
    uint16 internal constant PARTNER_FEE_BPS = 50; // 0.5%
    uint16 internal constant PLATFORM_FEE_BPS = 10; // 0.1%
    uint256 internal constant SPEND = 15_000e6;

    address internal user;
    address internal other;
    address internal partnerSigner;
    uint256 internal partnerKey;
    address internal partnerTreasury;
    address internal platformTreasury;

    function setUp() public override {
        super.setUp();
        _setUpRelay(1_000_000e18, 50_000_000e6, 100_000e18, 15_000_000e6);
        router.setPrice(150e6);

        user = makeAddr("user");
        other = makeAddr("other");
        partnerTreasury = makeAddr("partnerTreasury");
        platformTreasury = makeAddr("platformTreasury");
        (partnerSigner, partnerKey) = makeAddrAndKey("partnerSigner");
        vm.deal(user, 100 ether);
        vm.deal(other, 100 ether);

        request.setPartner(PARTNER, partnerSigner, partnerTreasury, 100, true);
        request.setPlatformFee(PLATFORM_FEE_BPS, platformTreasury);

        _fund(user, 100_000e6);
        _fund(other, 100_000e6);

        mirrorQuote.setRecoveryMinter(address(request));
        mirrorStock.setRecoveryMinter(address(request));
        homeQuote.setDelegate(address(relay));
        homeStock.setDelegate(address(relay));
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address _to, uint256 _amount) internal {
        SendParam memory p = SendParam({
            dstEid: MIRROR_EID,
            to: bytes32(uint256(uint160(_to))),
            amountLD: _amount,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory f = homeQuote.quoteSend(p, false);
        homeQuote.send{ value: f.nativeFee }(p, f, address(this));
        deliverAll();
    }

    function _auth(
        address _user,
        SwapTypes.Direction _dir,
        uint256 _amountIn,
        uint256 _minOut,
        uint16 _feeBps,
        uint256 _nonce,
        uint256 _deadline
    ) internal view returns (SwapRequest.PartnerAuth memory a) {
        bytes32 digest = request.hashPartnerOrder(
            _user, _dir, _amountIn, _minOut, PARTNER, _feeBps, _nonce, _deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(partnerKey, digest);
        a = SwapRequest.PartnerAuth(PARTNER, _feeBps, _nonce, _deadline, abi.encodePacked(r, s, v));
    }

    function _buyVia(address _user, uint256 _spend, uint256 _minOut, uint256 _nonce)
        internal
        returns (uint64 id)
    {
        SwapRequest.PartnerAuth memory a = _auth(
            _user,
            SwapTypes.Direction.BUY,
            _spend,
            _minOut,
            PARTNER_FEE_BPS,
            _nonce,
            block.timestamp + 5 minutes
        );
        vm.startPrank(_user);
        mirrorQuote.approve(address(request), _spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, _spend, _minOut);
        id = request.buyVia{ value: fee.nativeFee }(_spend, _minOut, a);
        vm.stopPrank();
    }

    function _status(uint64 _id) internal view returns (SwapTypes.Status st) {
        (,,,,,,,,, st,,) = request.requests(_id);
    }

    function _fees() internal pure returns (uint256 partnerFee, uint256 platformFee) {
        partnerFee = (SPEND * PARTNER_FEE_BPS) / 10_000;
        platformFee = (SPEND * PLATFORM_FEE_BPS) / 10_000;
    }

    // ------------------------------------------------------------------ fills pay the fees

    function test_partnerBuyFillsAndEarnsItsFees() public {
        uint256 before = mirrorQuote.balanceOf(user);
        uint64 id = _buyVia(user, SPEND, 1, 1);
        (uint256 partnerFee, uint256 platformFee) = _fees();

        assertEq(before - mirrorQuote.balanceOf(user), SPEND, "the user pays exactly what they authorised");
        assertEq(
            request.feesReserved(address(mirrorQuote)), partnerFee + platformFee, "fees are held in escrow"
        );
        assertEq(uint8(request.getFees(id).state), uint8(SwapRequest.FeeState.ESCROWED));

        deliverAll();

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED));
        // 15,000 - 0.6% = 14,910 USDC traded at 150 => 99.4 stock.
        assertEq(mirrorStock.balanceOf(user), 99.4e18, "only the net amount is traded");
        assertEq(uint8(request.getFees(id).state), uint8(SwapRequest.FeeState.PAID));
        assertEq(request.feesClaimable(address(mirrorQuote), partnerTreasury), partnerFee);
        assertEq(request.feesClaimable(address(mirrorQuote), platformTreasury), platformFee);

        vm.prank(partnerTreasury);
        request.claimFees(address(mirrorQuote), partnerTreasury);
        vm.prank(platformTreasury);
        request.claimFees(address(mirrorQuote), platformTreasury);
        assertEq(mirrorQuote.balanceOf(partnerTreasury), partnerFee, "75 USDC to the partner");
        assertEq(mirrorQuote.balanceOf(platformTreasury), platformFee, "15 USDC to the platform");
        assertEq(request.feesReserved(address(mirrorQuote)), 0);
        assertEq(mirrorQuote.balanceOf(address(request)), 0, "nothing left behind");
    }

    function test_partnerSellTakesItsFeeInTheStock() public {
        _buyVia(user, SPEND, 1, 1);
        deliverAll();
        uint256 stock = mirrorStock.balanceOf(user);

        SwapRequest.PartnerAuth memory a = _auth(
            user, SwapTypes.Direction.SELL, stock, 1, PARTNER_FEE_BPS, 2, block.timestamp + 5 minutes
        );
        vm.startPrank(user);
        mirrorStock.approve(address(request), stock);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.SELL, stock, 1);
        uint64 id = request.sellVia{ value: fee.nativeFee }(stock, 1, a);
        vm.stopPrank();
        deliverAll();

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED));
        uint256 partnerFee = (stock * PARTNER_FEE_BPS) / 10_000;
        assertEq(
            request.feesClaimable(address(mirrorStock), partnerTreasury), partnerFee, "fee in the input token"
        );
    }

    // ------------------------------------------------------------------ no fill, no fee

    function test_aRefundReturnsTheFeesToo() public {
        router.setForceRevert(true);
        uint256 before = mirrorQuote.balanceOf(user);
        uint64 id = _buyVia(user, SPEND, 1, 1);
        deliverAll();

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.REFUNDED));
        assertEq(mirrorQuote.balanceOf(user), before, "every unit back, fees included");
        assertEq(uint8(request.getFees(id).state), uint8(SwapRequest.FeeState.RETURNED));
        assertEq(request.feesClaimable(address(mirrorQuote), partnerTreasury), 0);
        assertEq(request.feesReserved(address(mirrorQuote)), 0);
    }

    function test_aCancellationReturnsTheFeesToo() public {
        uint256 before = mirrorQuote.balanceOf(user);
        uint64 id = _buyVia(user, SPEND, 1, 1);
        (,,,,,,,,,,, uint64 nonce) = request.requests(id);

        relay.cancelStuckInbound(
            MIRROR_EID, bytes32(uint256(uint160(address(mirrorQuote)))), address(homeQuote), nonce, bytes32(0)
        );
        deliverOnlyTo(MIRROR_EID, address(request));

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.CANCELLED));
        assertEq(mirrorQuote.balanceOf(user), before, "input restored and fees returned");
        assertEq(request.feesReserved(address(mirrorQuote)), 0);
    }

    function test_aStrandReturnsTheFees() public {
        uint256 before = mirrorQuote.balanceOf(user);
        uint64 id = _buyVia(user, SPEND, 1, 1);
        (uint256 partnerFee, uint256 platformFee) = _fees();

        // The notice the home relay sends when a return leg cannot be dispatched.
        bytes memory notice = SwapTypes.encodeSettlement(
            SwapTypes.Settlement({
                requestId: id,
                status: uint8(SwapTypes.Status.STRANDED),
                reason: uint8(SwapTypes.FailureReason.POOL_ERROR),
                amountIn: 0,
                amountOut: 0,
                lzNonce: 0,
                recipient: bytes32(uint256(uint160(user))),
                cancelledPath: bytes32(0)
            })
        );
        vm.prank(endpoints[MIRROR_EID]);
        request.lzReceive(
            Origin(HOME_EID, bytes32(uint256(uint160(address(relay)))), 1), bytes32(0), notice, address(0), ""
        );

        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.STRANDED));
        assertEq(
            mirrorQuote.balanceOf(user),
            before - SPEND + partnerFee + platformFee,
            "the fee comes back now; the traded amount is recovered at home"
        );
        assertEq(request.feesReserved(address(mirrorQuote)), 0);
    }

    // ------------------------------------------------------------------ the gate

    function test_partnerRequiredClosesTheOpenEntrypoints() public {
        request.setPartnerRequired(true);
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(SwapRequest.PartnerRequired.selector);
        request.buy{ value: 1 ether }(SPEND, 1);
        vm.expectRevert(SwapRequest.PartnerRequired.selector);
        request.sell{ value: 1 ether }(1e18, 1);
        vm.stopPrank();

        uint64 id = _buyVia(user, SPEND, 1, 1);
        deliverAll();
        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED), "partner orders still go through");
    }

    function test_openOrdersPayOnlyThePlatformFee() public {
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, SPEND, 1);
        uint64 id = request.buy{ value: fee.nativeFee }(SPEND, 1);
        vm.stopPrank();
        deliverAll();

        (, uint256 platformFee) = _fees();
        assertEq(request.getFees(id).partnerFee, 0);
        assertEq(request.feesClaimable(address(mirrorQuote), platformTreasury), platformFee);
    }

    function test_withNoFeesConfiguredNothingIsEscrowed() public {
        request.setPlatformFee(0, address(0));
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, SPEND, 1);
        uint64 id = request.buy{ value: fee.nativeFee }(SPEND, 1);
        vm.stopPrank();
        deliverAll();

        assertEq(uint8(request.getFees(id).state), uint8(SwapRequest.FeeState.NONE));
        assertEq(mirrorStock.balanceOf(user), 100e18, "the pre-partner behaviour, unchanged");
    }

    // ------------------------------------------------------------------ the authorisation

    function test_anAuthorisationIsBoundToItsUser() public {
        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER_FEE_BPS, 1, block.timestamp + 5 minutes);
        vm.startPrank(other);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.InvalidPartnerSignature.selector, PARTNER));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();
    }

    function test_anAuthorisationCoversExactlyItsOrder() public {
        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER_FEE_BPS, 1, block.timestamp + 5 minutes);
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND * 2);

        vm.expectRevert(abi.encodeWithSelector(SwapRequest.InvalidPartnerSignature.selector, PARTNER));
        request.buyVia{ value: 1 ether }(SPEND * 2, 1, a); // a different amount

        vm.expectRevert(abi.encodeWithSelector(SwapRequest.InvalidPartnerSignature.selector, PARTNER));
        request.buyVia{ value: 1 ether }(SPEND, 0, a); // a looser floor

        a.feeBps = PARTNER_FEE_BPS + 1;
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.InvalidPartnerSignature.selector, PARTNER));
        request.buyVia{ value: 1 ether }(SPEND, 1, a); // a higher fee than signed
        vm.stopPrank();
    }

    function test_anAuthorisationCannotBeReplayed() public {
        _buyVia(user, SPEND, 1, 42);
        SwapRequest.PartnerAuth memory a = _auth(
            user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER_FEE_BPS, 42, block.timestamp + 5 minutes
        );
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.NonceAlreadyUsed.selector, PARTNER, 42));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();
    }

    function test_anExpiredAuthorisationIsRefused() public {
        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER_FEE_BPS, 1, block.timestamp + 1);
        vm.warp(block.timestamp + 2);
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.AuthorizationExpired.selector, a.deadline));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();
    }

    function test_aFeeAboveThePartnersCeilingIsRefused() public {
        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, SPEND, 1, 101, 1, block.timestamp + 60);
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.FeeTooHigh.selector, 101, 100));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();
    }

    function test_aDeactivatedPartnerCannotAuthorise() public {
        request.setPartner(PARTNER, partnerSigner, partnerTreasury, 100, false);
        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER_FEE_BPS, 1, block.timestamp + 60);
        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.UnknownPartner.selector, PARTNER));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();
    }

    function test_thePartnerCanWithdrawAnUnusedAuthorisation() public {
        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER_FEE_BPS, 9, block.timestamp + 60);
        vm.prank(user);
        vm.expectRevert(SwapRequest.NotPartnerSigner.selector);
        request.invalidateNonce(PARTNER, 9);

        vm.prank(partnerSigner);
        request.invalidateNonce(PARTNER, 9);

        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.NonceAlreadyUsed.selector, PARTNER, 9));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();
    }

    function test_aContractSignerIsAcceptedThroughERC1271() public {
        ApprovingWallet wallet = new ApprovingWallet();
        request.setPartner(PARTNER, address(wallet), partnerTreasury, 100, true);
        bytes32 digest = request.hashPartnerOrder(
            user, SwapTypes.Direction.BUY, SPEND, 1, PARTNER, PARTNER_FEE_BPS, 1, block.timestamp + 60
        );
        SwapRequest.PartnerAuth memory a =
            SwapRequest.PartnerAuth(PARTNER, PARTNER_FEE_BPS, 1, block.timestamp + 60, "");

        vm.startPrank(user);
        mirrorQuote.approve(address(request), SPEND);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.InvalidPartnerSignature.selector, PARTNER));
        request.buyVia{ value: 1 ether }(SPEND, 1, a);
        vm.stopPrank();

        wallet.approve(digest);
        vm.startPrank(user);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, SPEND, 1);
        uint64 id = request.buyVia{ value: fee.nativeFee }(SPEND, 1, a);
        vm.stopPrank();
        deliverAll();
        assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED));
    }

    // ------------------------------------------------------------------ admin and custody

    function test_feeCeilingsAndOwnershipAreEnforced() public {
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.FeeTooHigh.selector, 301, 300));
        request.setPartner(PARTNER, partnerSigner, partnerTreasury, 301, true);
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.FeeTooHigh.selector, 101, 100));
        request.setPlatformFee(101, platformTreasury);
        vm.expectRevert(SwapRequest.InvalidPartner.selector);
        request.setPartner(0, partnerSigner, partnerTreasury, 100, true);
        vm.expectRevert(SwapRequest.InvalidPartner.selector);
        request.setPlatformFee(10, address(0));

        vm.startPrank(user);
        vm.expectRevert();
        request.setPartner(PARTNER, user, user, 300, true);
        vm.expectRevert();
        request.setPartnerRequired(true);
        vm.expectRevert();
        request.setPlatformFee(100, user);
        vm.stopPrank();
    }

    function test_sweepCannotReachEscrowedOrEarnedFees() public {
        _buyVia(user, SPEND, 1, 1);
        (uint256 partnerFee, uint256 platformFee) = _fees();
        assertEq(mirrorQuote.balanceOf(address(request)), partnerFee + platformFee);

        vm.expectRevert(abi.encodeWithSelector(SwapRequest.WouldSweepFees.selector, 0));
        request.sweep(address(mirrorQuote), address(this), 1);

        deliverAll(); // fees now earned, still held until claimed
        vm.expectRevert(abi.encodeWithSelector(SwapRequest.WouldSweepFees.selector, 0));
        request.sweep(address(mirrorQuote), address(this), 1);
    }

    /// @dev Whatever the amount and fee, the user pays exactly `amountIn`, the fees are exactly
    ///      the stated basis points, and after settlement the contract holds only what is owed.
    function testFuzz_feesAreExactAndFullyAccounted(uint256 _spend, uint16 _feeBps, bool _fail) public {
        _spend = bound(_spend, 1e6, 50_000e6);
        _feeBps = uint16(bound(_feeBps, 0, 100));
        router.setForceRevert(_fail);

        SwapRequest.PartnerAuth memory a =
            _auth(user, SwapTypes.Direction.BUY, _spend, 1, _feeBps, 1, block.timestamp + 60);
        uint256 before = mirrorQuote.balanceOf(user);
        vm.startPrank(user);
        mirrorQuote.approve(address(request), _spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, _spend, 1);
        uint64 id = request.buyVia{ value: fee.nativeFee }(_spend, 1, a);
        vm.stopPrank();

        assertEq(before - mirrorQuote.balanceOf(user), _spend, "debited exactly the authorised amount");
        deliverAll();

        uint256 partnerFee = (_spend * _feeBps) / 10_000;
        uint256 platformFee = (_spend * PLATFORM_FEE_BPS) / 10_000;
        if (_fail) {
            assertEq(uint8(_status(id)), uint8(SwapTypes.Status.REFUNDED));
            assertEq(mirrorQuote.balanceOf(user), before, "a failed order costs nothing");
            assertEq(request.feesReserved(address(mirrorQuote)), 0);
        } else {
            assertEq(uint8(_status(id)), uint8(SwapTypes.Status.FILLED));
            assertEq(request.feesClaimable(address(mirrorQuote), partnerTreasury), partnerFee);
            assertEq(request.feesClaimable(address(mirrorQuote), platformTreasury), platformFee);
            assertEq(request.feesReserved(address(mirrorQuote)), partnerFee + platformFee);
        }
        assertEq(
            mirrorQuote.balanceOf(address(request)),
            request.feesReserved(address(mirrorQuote)),
            "the contract holds exactly the fees it owes, nothing more or less"
        );
    }
}
