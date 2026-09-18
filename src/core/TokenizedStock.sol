// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TokenizedStock
 * @notice The omnichain asset at the centre of CrossStock.
 *
 * @dev One contract, deployed to every chain in the token's chain set. It is a LayerZero V2
 *      OFT, so the *same* token identity exists everywhere while total supply stays constant
 *      across the whole set: a `send()` burns on the source chain and mints on the
 *      destination.
 *
 *      The only difference between the home-chain instance and a mirror-chain instance is the
 *      `initialSupply` constructor argument:
 *
 *        - home chain  -> full supply minted to `owner`, which then seeds the Uniswap V3 pool
 *        - mirror chain -> `0`. A mirror instance is *empty by construction* and can only ever
 *          be credited by an inbound bridge message. This is what makes the zero-liquidity
 *          claim structural rather than a matter of configuration discipline.
 *
 *      No pause / freeze / KYC hooks — deliberately out of scope for this POC.
 */
contract TokenizedStock is OFT {
    /// @param _name         Token name (config-driven).
    /// @param _symbol       Token symbol (config-driven).
    /// @param _lzEndpoint   LayerZero V2 EndpointV2 address for the chain being deployed to.
    /// @param _owner        Owner + LayerZero delegate. Receives `_initialSupply`.
    /// @param _initialSupply Full supply on the home chain; 0 on every mirror chain.
    constructor(
        string memory _name,
        string memory _symbol,
        address _lzEndpoint,
        address _owner,
        uint256 _initialSupply
    ) OFT(_name, _symbol, _lzEndpoint, _owner) Ownable(_owner) {
        if (_initialSupply > 0) {
            _mint(_owner, _initialSupply);
        }
    }
}
