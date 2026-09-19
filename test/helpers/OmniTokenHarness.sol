// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OmniToken } from "../../src/core/OmniToken.sol";

/**
 * @notice Exposes OFTCore internals so they can be fuzzed directly.
 * @dev Test-only. The precision behaviour of an OFT is where value silently disappears, so it
 *      deserves property tests rather than being exercised only incidentally through a bridge.
 */
contract OmniTokenHarness is OmniToken {
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _endpoint,
        address _owner,
        uint256 _supply
    ) OmniToken(_name, _symbol, _decimals, _endpoint, _owner, _supply) {}

    function removeDust(uint256 _amountLD) external view returns (uint256) {
        return _removeDust(_amountLD);
    }

    function toLD(uint64 _amountSD) external view returns (uint256) {
        return _toLD(_amountSD);
    }

    function toSD(uint256 _amountLD) external view returns (uint64) {
        return _toSD(_amountLD);
    }

    function conversionRate() external view returns (uint256) {
        return decimalConversionRate;
    }

    function debitView(
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) external view returns (uint256 sent, uint256 received) {
        return _debitView(_amountLD, _minAmountLD, _dstEid);
    }
}
