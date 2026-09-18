// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title USDCMock
 * @notice The pairing asset. Plain ERC-20, 6 decimals, **home chain only**.
 *
 * @dev Deliberately *not* an OFT. It stands for the asset that lives where the real liquidity
 *      pool lives, and keeping it non-omnichain is what forces the architecture to be honest:
 *      a mirror chain cannot hold the quote asset, so it cannot quietly acquire local
 *      liquidity, so every trade must genuinely route to the home chain's pool.
 *
 *      Consequence, documented in NOTES.md: the USDC proceeds of a mirror-initiated sell are
 *      delivered on the *home* chain, and what returns to the mirror chain is an authenticated
 *      settlement receipt.
 */
contract USDCMock is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 decimals_,
        address _owner,
        uint256 _initialSupply
    ) ERC20(_name, _symbol) Ownable(_owner) {
        _decimals = decimals_;
        if (_initialSupply > 0) {
            _mint(_owner, _initialSupply);
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Test-faucet mint. Owner-only; this is a testnet stand-in, not real USDC.
    function mint(address _to, uint256 _amount) external onlyOwner {
        _mint(_to, _amount);
    }
}
