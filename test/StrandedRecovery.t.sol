// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { console2 } from "forge-std/console2.sol";
import { RelayFixture } from "./helpers/RelayFixture.sol";
import { SwapTypes } from "../src/relay/SwapTypes.sol";
import { SwapRelay } from "../src/relay/SwapRelay.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title StrandedRecovery
 * @notice The fix for the finding that had been the project's standing blocker.
 *
 * @dev Validation scenario 4 established that a stalled message never *loses* funds but never
 *      self-heals either: the value sat in `SwapRelay` with no on-chain record of whose it was
 *      and no way for the owner to get it out, while the mirror-chain request stayed `PENDING`
 *      forever. "Recoverable in principle" is not the same as recoverable.
 *
 *      Three things changed, and this file is what holds them in place:
 *
 *      1. A stranded amount records its **beneficiary**, so it has a known owner instead of
 *         becoming anonymous value in the contract.
 *      2. `claimStranded` is **permissionless** and pays that beneficiary **on the home chain**
 *         — the only honest destination, because an amount that is stranded is by definition one
 *         that cannot cross the bridge.
 *      3. A `STRANDED` settlement tells the mirror chain, so the request reaches a terminal
 *         state and the user learns where their money actually is.
 */
contract StrandedRecovery is RelayFixture {
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
            amountLD: 100_000e6,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory f = homeQuote.quoteSend(p, false);
        homeQuote.send{ value: f.nativeFee }(p, f, address(this));
        deliverAll();
    }

    /**
     * @dev Strands a refund by starving the relay of gas and then making the venue fail.
     *
     * Both halves are necessary. Draining the balance alone is not enough: the executor
     * forwards native value with every `lzCompose`, which tops the relay back up before it
     * reaches the return leg. Withholding that value is what actually reproduces the
     * out-of-gas-mid-settlement condition a live chain hits when fees move.
     */
    function _strandARefund(uint256 spend) internal returns (uint64 id) {
        setComposeValue(0);
        relay.withdrawNative(payable(address(this)), address(relay).balance);
        assertEq(address(relay).balance, 0, "relay must be out of gas for the return leg");

        router.setForceRevert(true);

        vm.startPrank(user);
        mirrorQuote.approve(address(request), spend);
        MessagingFee memory fee = request.quoteTrade(SwapTypes.Direction.BUY, spend, 0);
        id = request.buy{ value: fee.nativeFee }(spend, 0);
        vm.stopPrank();

        deliverAll();
    }

    function test_strandedAmountIsRecordedWithItsOwner() public {
        uint256 spend = 5_000e6;
        uint64 id = _strandARefund(spend);

        assertEq(relay.stranded(MIRROR_EID, id), spend, "the amount must be recorded as stranded");
        assertEq(relay.strandedToken(MIRROR_EID, id), address(homeQuote), "in the input asset");
        assertEq(
            relay.strandedBeneficiary(MIRROR_EID, id),
            bytes32(uint256(uint160(user))),
            "stranded value must record whose it is"
        );
        console2.log("stranded:", relay.stranded(MIRROR_EID, id));
    }

    /// @dev The actual fix: anyone can release the funds, and only to their owner.
    function test_anyoneCanClaimStrandedFundsForTheirOwner() public {
        uint256 spend = 5_000e6;
        uint64 id = _strandARefund(spend);

        uint256 before = homeQuote.balanceOf(user);

        // A passer-by pays the gas. Nothing about the destination is theirs to choose.
        address goodSamaritan = makeAddr("goodSamaritan");
        vm.prank(goodSamaritan);
        relay.claimStranded(MIRROR_EID, id);

        assertEq(homeQuote.balanceOf(user) - before, spend, "the owner must receive the full amount");
        assertEq(homeQuote.balanceOf(goodSamaritan), 0, "the claimer must receive nothing");
        assertEq(relay.stranded(MIRROR_EID, id), 0, "the record must be cleared");
        console2.log("claimed to owner on the home chain:", spend);
    }

    function test_claimingTwiceIsRejected() public {
        uint64 id = _strandARefund(5_000e6);
        relay.claimStranded(MIRROR_EID, id);

        vm.expectRevert(abi.encodeWithSelector(SwapRelay.NothingStranded.selector, MIRROR_EID, id));
        relay.claimStranded(MIRROR_EID, id);
    }

    function test_claimingSomethingNeverStrandedIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SwapRelay.NothingStranded.selector, MIRROR_EID, uint64(999)));
        relay.claimStranded(MIRROR_EID, 999);
    }

    /**
     * @dev A non-EVM beneficiary cannot be paid on an EVM chain, and must fail loudly rather
     *      than silently truncating a 32-byte pubkey into the wrong `address`.
     *
     * Driven by calling `lzCompose` directly, pranked as the endpoint, with a hand-built order
     * carrying a Solana-shaped recipient. An earlier version poked the storage slot instead and
     * fell back to passing when the probe missed — which is the vacuous-test trap this suite
     * exists to avoid.
     */
    function test_nonEvmBeneficiaryIsRefusedRatherThanTruncated() public {
        setComposeValue(0);
        relay.withdrawNative(payable(address(this)), address(relay).balance);
        router.setForceRevert(true); // force the refund path, which will then strand

        uint64 requestId = 7;
        bytes32 solanaPubkey = keccak256("a solana account");
        uint256 amount = 1_000e6;

        // Give the relay the tokens the OFT would have credited it with.
        homeQuote.transfer(address(relay), amount);

        bytes memory order = abi.encode(requestId, uint8(0) /* BUY */, uint256(0), solanaPubkey);
        bytes memory composeMsg = abi.encodePacked(
            uint64(1), // nonce
            MIRROR_EID, // srcEid
            uint256(amount), // amountLD
            bytes32(uint256(uint160(address(request)))), // composeFrom = the registered peer
            order
        );

        vm.prank(endpoints[HOME_EID]);
        relay.lzCompose(address(homeQuote), bytes32(0), composeMsg, address(0), "");

        assertEq(relay.stranded(MIRROR_EID, requestId), amount, "the refund must have stranded");
        assertEq(
            relay.strandedBeneficiary(MIRROR_EID, requestId),
            solanaPubkey,
            "the Solana beneficiary must be recorded verbatim, not truncated"
        );

        vm.expectRevert(abi.encodeWithSelector(SwapRelay.BeneficiaryNotAddressable.selector, solanaPubkey));
        relay.claimStranded(MIRROR_EID, requestId);
    }

    /// @dev Funds are conserved throughout: stranding and claiming move value, never create it.
    function test_strandingAndClaimingConserveSupply() public {
        uint256 beforeSupply = homeQuote.totalSupply() + mirrorQuote.totalSupply();
        uint256 beforeInFlight = homeQuote.bridgedOut() + mirrorQuote.bridgedOut()
            - homeQuote.bridgedIn() - mirrorQuote.bridgedIn();

        uint64 id = _strandARefund(5_000e6);
        relay.claimStranded(MIRROR_EID, id);

        uint256 afterSupply = homeQuote.totalSupply() + mirrorQuote.totalSupply();
        uint256 afterInFlight = homeQuote.bridgedOut() + mirrorQuote.bridgedOut()
            - homeQuote.bridgedIn() - mirrorQuote.bridgedIn();

        assertEq(
            afterSupply + afterInFlight,
            beforeSupply + beforeInFlight,
            "supply plus in-flight must be unchanged by stranding and claiming"
        );
    }
}
