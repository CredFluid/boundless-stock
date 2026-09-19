// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OFTAdapter } from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title OmniTokenAdapter
 * @notice Makes an **already-deployed** ERC-20 omnichain, without replacing it.
 *
 * @dev The alternative to {OmniToken}. Where an OmniToken *is* the asset and mints its own
 *      supply, an adapter sits beside an asset that already exists: it **locks** the token on
 *      this chain and lets OmniToken instances on other chains mint representations against
 *      the locked balance.
 *
 *      This is what lets an issuer bring a token they already have rather than launching a new
 *      one. Holders keep their balances, the contract address never changes, and no migration
 *      is required.
 *
 *      ```
 *      existing tAAPL ──locked in──► OmniTokenAdapter ──backs──► tAAPL OFT on every mirror chain
 *      ```
 *
 *      THREE CONSTRAINTS, all inherited from LayerZero's OFTAdapter:
 *
 *      1. **Exactly one adapter may exist per token, ever.** A second lockbox would fracture
 *         supply: representations minted against one adapter could not be redeemed at the
 *         other. The infra records the adapter in the manifest so a redeploy reuses it.
 *      2. **Transfers must be lossless.** Fee-on-transfer and rebasing tokens break the
 *         accounting, because the adapter assumes one token in equals one token out.
 *         Explicitly out of scope for this POC.
 *      3. **`approvalRequired()` is true.** Unlike an OmniToken, which burns from the caller,
 *         an adapter pulls with `transferFrom` — so anything calling `send()` must approve the
 *         adapter first. SwapRelay and SwapRequest both handle this.
 *
 *      SUPPLY ACCOUNTING DIFFERS, and this is the part that surprises people: on the adapter's
 *      chain, the token's `totalSupply()` is its *entire* supply, including coins that have
 *      never been anywhere near this system. The omnichain figure is the adapter's **locked
 *      balance**, which is what the mirror-chain supplies are minted against. Summing
 *      `totalSupply()` across chains double-counts. See `infra/supply.ts`.
 */
contract OmniTokenAdapter is OFTAdapter {
    constructor(
        address _token,
        address _lzEndpoint,
        address _owner
    ) OFTAdapter(_token, _lzEndpoint, _owner) Ownable(_owner) {}

    /// @notice The underlying ERC-20 this adapter locks.
    function underlying() external view returns (address) {
        return address(innerToken);
    }

    /**
     * @notice Amount of the underlying currently locked, i.e. the supply that exists as
     *         representations on other chains plus anything in flight.
     * @dev The correct figure to reconcile mirror-chain supplies against.
     */
    function lockedBalance() external view returns (uint256) {
        return innerToken.balanceOf(address(this));
    }
}
