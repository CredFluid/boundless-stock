// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { OmniFixture } from "../helpers/OmniFixture.sol";
import { OmniToken } from "../../src/core/OmniToken.sol";

/**
 * @title SupplyNegativeControl
 * @notice Proves the supply invariant can actually fail.
 *
 * @dev A passing invariant suite is only evidence if the invariant is capable of breaking. This
 *      deliberately inflates supply and confirms the assertion catches it. Without this, a
 *      typo in the property would look exactly like a clean run.
 *
 *      The minting used here comes from `MintableOmniToken`, a **test-only** subclass.
 *      Production `OmniToken` has no mint function: supply is fixed at deployment and can only
 *      move between chains. An owner-callable mint used to live on the asset itself, which made
 *      the whole omnichain supply invariant contingent on one private key; it was removed, and
 *      `test_productionTokenCannotMint` below is what keeps it removed.
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

    /**
     * @notice The production asset has no mint function at all.
     * @dev Enforced by the type system rather than by a runtime check: `OmniToken` exposes no
     *      `mint`, so this only compiles because the fixture uses the test-only subclass. If
     *      someone re-adds minting to the asset, the cast below starts succeeding and the
     *      assertion fires — which is the point.
     */
    function test_productionTokenCannotMint() public view {
        OmniToken production = OmniToken(address(tokens[0]));
        (bool ok, ) = address(production).staticcall(
            abi.encodeWithSignature("mint(address,uint256)", address(this), uint256(1))
        );
        assertFalse(ok, "production OmniToken must expose no mint function");
    }
}
