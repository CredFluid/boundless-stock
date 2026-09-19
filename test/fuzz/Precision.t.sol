// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { OmniTokenHarness } from "../helpers/OmniTokenHarness.sol";
import { LocalEndpointV2 } from "../../src/mocks/LocalEndpointV2.sol";

/**
 * @title PrecisionFuzz
 * @notice Property tests for OFT decimal quantisation.
 *
 * @dev This is where value silently disappears in an omnichain token. An OFT bridges at
 *      `sharedDecimals` (6) regardless of the token's own decimals, so an 18-decimal asset
 *      drops its bottom 12 decimal places on every hop. Every property here is one that, if
 *      violated, would mean either a user loses more than the documented dust or — far worse —
 *      the bridge credits more than it debited.
 */
contract PrecisionFuzz is Test {
    OmniTokenHarness internal stock; // 18 decimals, like the tokenized stock
    OmniTokenHarness internal usdc; // 6 decimals, like the quote asset

    uint32 internal constant EID = 1;
    uint32 internal constant DST_EID = 2;

    function setUp() public {
        LocalEndpointV2 endpoint = new LocalEndpointV2(EID, address(this));
        stock = new OmniTokenHarness("Stock", "STK", 18, address(endpoint), address(this), 0);
        usdc = new OmniTokenHarness("USD Coin", "USDC", 6, address(endpoint), address(this), 0);
    }

    // ------------------------------------------------------------------ conversion rates

    function test_conversionRates() public view {
        // 18 decimals against sharedDecimals 6 => 10^12 of quantisation.
        assertEq(stock.conversionRate(), 10 ** 12, "18-decimal token should quantise at 1e12");
        // A 6-decimal token matches sharedDecimals exactly, so it bridges losslessly.
        assertEq(usdc.conversionRate(), 1, "6-decimal token should bridge with no quantisation");
    }

    // ------------------------------------------------------------------ removeDust

    /// @dev Dust removal may only ever round DOWN. Rounding up would mint value from nothing.
    function testFuzz_removeDustNeverIncreases(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        assertLe(stock.removeDust(amount), amount, "removeDust must never increase an amount");
        assertLe(usdc.removeDust(amount), amount, "removeDust must never increase an amount");
    }

    /// @dev The result must be exactly representable at shared decimals, or the remote mint
    ///      would disagree with the local burn.
    function testFuzz_removeDustIsRepresentable(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        uint256 clean = stock.removeDust(amount);
        assertEq(clean % stock.conversionRate(), 0, "result must be a whole number of shared units");
    }

    /// @dev The discarded remainder is strictly bounded by one shared unit. This is the
    ///      guarantee that lets SwapRequest hand dust back rather than track it.
    function testFuzz_dustIsBoundedByOneSharedUnit(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        uint256 lost = amount - stock.removeDust(amount);
        assertLt(lost, stock.conversionRate(), "dust must be smaller than one shared unit");
    }

    /// @dev Idempotent: a cleaned amount is already clean. If this failed, repeated hops would
    ///      shave value off an amount that had already been quantised.
    function testFuzz_removeDustIsIdempotent(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        uint256 once = stock.removeDust(amount);
        assertEq(stock.removeDust(once), once, "removeDust must be idempotent");
    }

    /// @dev A 6-decimal token loses nothing at all.
    function testFuzz_sixDecimalsIsLossless(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        assertEq(usdc.removeDust(amount), amount, "6-decimal amounts must survive intact");
    }

    // ------------------------------------------------------------------ SD/LD round trip

    /// @dev Converting to shared decimals and back must be the same as removing dust —
    ///      anything else means the wire format and the local ledger disagree.
    function testFuzz_localSharedRoundTrip(uint256 amount) public view {
        // Bounded to what uint64 shared-decimal amounts can represent.
        amount = bound(amount, 0, uint256(type(uint64).max) * 10 ** 12);
        uint256 clean = stock.removeDust(amount);
        assertEq(stock.toLD(stock.toSD(clean)), clean, "SD->LD->SD must round-trip a clean amount");
    }

    // ------------------------------------------------------------------ debitView

    /// @dev The amount credited on the destination may never exceed the amount debited on the
    ///      source. A violation here is inflation, and it is the single most important
    ///      property in this file.
    function testFuzz_debitNeverCreditsMoreThanItDebits(uint256 amount) public view {
        amount = bound(amount, 0, type(uint128).max);
        (uint256 sent, uint256 received) = stock.debitView(amount, 0, DST_EID);
        assertLe(received, sent, "received must never exceed sent");
        assertLe(sent, amount, "sent must never exceed the requested amount");
    }

    /// @dev The slippage floor must be honoured: if the quantised amount falls below
    ///      minAmountLD the call must revert rather than silently send less.
    function testFuzz_debitRespectsMinAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);
        uint256 clean = stock.removeDust(amount);
        vm.assume(clean < amount); // only meaningful when dust is actually removed

        vm.expectRevert();
        stock.debitView(amount, amount, DST_EID); // demanding the un-quantised amount
    }
}
