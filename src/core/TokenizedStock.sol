// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OmniToken } from "./OmniToken.sol";

/**
 * @title TokenizedStock
 * @notice The omnichain asset at the centre of CrossStock.
 *
 * @dev A named {OmniToken}: one contract deployed to every chain in the token's set, so the
 *      same asset identity exists everywhere while total supply stays constant across the
 *      whole set — a `send()` burns on the source chain and mints on the destination.
 *
 *      The only difference between the home-chain instance and a mirror-chain instance is the
 *      `initialSupply` argument:
 *
 *        home chain   -> full supply minted to `owner`, which then seeds the Uniswap V3 pool
 *        mirror chain -> `0`. A mirror instance is empty by construction and can only ever be
 *                        credited by an inbound bridge message.
 *
 *      That is what makes "no market on the mirror chain" structural rather than a matter of
 *      operational discipline: there is nothing there to trade against.
 *
 *      No pause / freeze / KYC hooks — deliberately out of scope for this POC.
 */
contract TokenizedStock is OmniToken {
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _lzEndpoint,
        address _owner,
        uint256 _initialSupply
    ) OmniToken(_name, _symbol, _decimals, _lzEndpoint, _owner, _initialSupply) {}
}
