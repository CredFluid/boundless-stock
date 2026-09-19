// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LegacyERC20
 * @notice A perfectly ordinary ERC-20 that knows nothing about LayerZero.
 *
 * @dev Stands in for a tokenized stock an issuer deployed before CrossStock existed, with
 *      holders and history already on it. Used to prove the adapter path end to end: the infra
 *      must be able to make THIS token omnichain without redeploying it, migrating holders, or
 *      changing its address.
 *
 *      Deliberately has no OFT surface — no `sharedDecimals`, no endpoint, no peers. If the
 *      adapter path accidentally depended on any of that, deploying against this contract
 *      would fail, which is exactly the point of testing against it rather than against an
 *      OmniToken with its omnichain features switched off.
 */
contract LegacyERC20 is ERC20, Ownable {
    uint8 private immutable _decimals;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 decimals_,
        address _owner,
        uint256 _initialSupply
    ) ERC20(_name, _symbol) Ownable(_owner) {
        _decimals = decimals_;
        if (_initialSupply > 0) _mint(_owner, _initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address _to, uint256 _amount) external onlyOwner {
        _mint(_to, _amount);
    }
}
