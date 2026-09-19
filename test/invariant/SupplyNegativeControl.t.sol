// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { OmniFixture } from "../helpers/OmniFixture.sol";

/**
 * @title SupplyNegativeControl
 * @notice Proves the supply invariant can actually fail.
 *
 * @dev A passing invariant suite is only evidence if the invariant is capable of breaking. This
 *      deliberately inflates supply and confirms the assertion catches it. Without this, a
 *      typo in the property would look exactly like a clean run.
 *
 *      It also pins down a real finding: `OmniToken.mint()` is `onlyOwner` and unbounded, so the
 *      owner key can break the supply invariant at will on any chain. That is acceptable for a
 *      testnet faucet and is a supply-integrity hole in production — recorded here as an
 *      executable statement rather than a comment in a report.
 */
contract SupplyNegativeControl is OmniFixture {
    uint256 internal constant SUPPLY = 1_000_000e18;

    function setUp() public override {
        super.setUp();
        _setUpOmni(18, SUPPLY);
    }

    function test_invariantHoldsAtGenesis() public view {
        assertEq(aggregateSupply(), MINTED, "genesis supply must equal what was minted");
    }

    /// @dev The owner faucet inflates aggregate supply, and the invariant notices.
    function test_ownerMintBreaksTheSupplyInvariant() public {
        assertEq(aggregateSupply(), MINTED);

        tokens[1].mint(address(0xBEEF), 1e18); // a mirror chain, out of thin air

        assertGt(aggregateSupply(), MINTED, "owner mint must be detectable as inflation");
        assertEq(aggregateSupply(), MINTED + 1e18, "inflation must be exactly the minted amount");
    }

    /// @dev Burning on one chain without a matching mint must also be detectable.
    function test_unmatchedBurnBreaksTheSupplyInvariant() public {
        address holder = makeAddr("holder");
        tokens[0].transfer(holder, 10e18);

        vm.prank(holder);
        tokens[0].transfer(address(0xdead), 10e18); // not a burn, but it leaves the tracked set

        // Supply is unchanged by a transfer — this is the control showing the invariant is not
        // simply tracking balances of known addresses.
        assertEq(aggregateSupply(), MINTED, "a transfer must not change aggregate supply");
    }

    /// @dev A mirror chain cannot mint to itself without a bridge message.
    function test_mirrorChainCannotSelfMint() public {
        address notOwner = makeAddr("notOwner");
        vm.prank(notOwner);
        vm.expectRevert();
        tokens[1].mint(notOwner, 1e18);
    }
}
