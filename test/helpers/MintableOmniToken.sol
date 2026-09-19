// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OmniToken } from "../../src/core/OmniToken.sol";

/**
 * @notice An {OmniToken} that can be minted after deployment. **Test-only.**
 *
 * @dev Production `OmniToken` has no mint function at all: its supply is fixed at deployment
 *      and can afterwards only move between chains. That is what makes the omnichain supply
 *      invariant hold on its own rather than resting on a private key.
 *
 *      Two things in the test suite still need to create supply out of nothing:
 *
 *      1. Seeding a mock venue's float, which stands in for pool reserves that on a real
 *         deployment would be provided by the issuer rather than minted.
 *      2. `SupplyNegativeControl`, which deliberately inflates supply to prove the invariant
 *         is capable of failing. An invariant that cannot fail is not evidence.
 *
 *      Keeping the capability here rather than in the asset means the suite can still do both
 *      without the production contract carrying the hole.
 */
contract MintableOmniToken is OmniToken {
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _lzEndpoint,
        address _owner,
        uint256 _initialSupply
    ) OmniToken(_name, _symbol, _decimals, _lzEndpoint, _owner, _initialSupply) {}

    function mint(address _to, uint256 _amount) external onlyOwner {
        _mint(_to, _amount);
    }
}
