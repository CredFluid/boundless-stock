// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OFTCore } from "@layerzerolabs/oft-evm/contracts/OFTCore.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title OmniToken
 * @notice A LayerZero V2 OFT with a caller-specified decimals value.
 *
 * @dev WHY THIS EXISTS RATHER THAN USING `OFT` DIRECTLY
 *
 *      LayerZero's `OFT` passes `decimals()` into `OFTCore` from its own constructor
 *      initializer list. That call resolves *before* any derived constructor body runs, so a
 *      subclass that stores its decimals in a variable and overrides `decimals()` returns 0 at
 *      that moment — and `OFTCore` then computes `10 ** (0 - 6)` and reverts on underflow.
 *      The practical effect is that `OFT` only really supports 18-decimal tokens.
 *
 *      CrossStock needs a 6-decimal omnichain USDC, so this contract subclasses `OFTCore`
 *      directly and hands it the decimals explicitly. `_debit` / `_credit` are the same
 *      burn-on-source / mint-on-destination behaviour as the stock `OFT`; nothing about the
 *      cross-chain semantics is changed.
 *
 *      NOTE ON PRECISION: `sharedDecimals()` is 6, so a 6-decimal token bridges with a
 *      conversion rate of exactly 1 and loses nothing. An 18-decimal token quantises away its
 *      bottom 12 decimal places on every hop — see NOTES.md.
 *
 *      NO MINT FUNCTION, DELIBERATELY. Supply is fixed at deployment and can afterwards only
 *      move between chains, never grow. An owner-callable `mint` existed here as a testnet
 *      faucet and was removed: it made the entire omnichain supply invariant contingent on a
 *      single private key, which is precisely the property this asset should not have. Tests
 *      that need to conjure supply use `MintableOmniToken` in `test/helpers/`.
 */
contract OmniToken is OFTCore, ERC20 {
    uint8 private immutable _decimals;

    /**
     * @notice Cumulative amount this chain has ever burned to send elsewhere.
     * @dev Together with {bridgedIn}, this is what makes the omnichain supply invariant
     *      *monitorable*. A bridge burns here and mints there, so a token is briefly on no
     *      chain at all, and a monitor comparing `Σ totalSupply` against the amount minted at
     *      genesis fires on every in-flight message. With these counters the real invariant is
     *      checkable from chain state alone:
     *
     *          Σ totalSupply + Σ bridgedOut − Σ bridgedIn == minted at genesis
     *
     *      because `Σ bridgedOut − Σ bridgedIn` is exactly what is in flight. No cross-chain
     *      acknowledgement is needed: each chain counts only its own side.
     */
    uint256 public bridgedOut;

    /// @notice Cumulative amount this chain has ever minted from an inbound bridge message.
    uint256 public bridgedIn;

    /// @param _initialSupply Full supply on the home chain; 0 on every mirror chain.
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 decimals_,
        address _lzEndpoint,
        address _owner,
        uint256 _initialSupply
    ) ERC20(_name, _symbol) OFTCore(decimals_, _lzEndpoint, _owner) Ownable(_owner) {
        _decimals = decimals_;
        if (_initialSupply > 0) {
            _mint(_owner, _initialSupply);
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @dev The OFT is the token itself, so no separate ERC-20 and no approval to send.
    function token() public view returns (address) {
        return address(this);
    }

    function approvalRequired() external pure virtual returns (bool) {
        return false;
    }

    function _debit(
        address _from,
        uint256 _amountLD,
        uint256 _minAmountLD,
        uint32 _dstEid
    ) internal virtual override returns (uint256 amountSentLD, uint256 amountReceivedLD) {
        (amountSentLD, amountReceivedLD) = _debitView(_amountLD, _minAmountLD, _dstEid);
        _burn(_from, amountSentLD);
        bridgedOut += amountSentLD;
    }

    function _credit(
        address _to,
        uint256 _amountLD,
        uint32 /*_srcEid*/
    ) internal virtual override returns (uint256 amountReceivedLD) {
        if (_to == address(0x0)) _to = address(0xdead);
        _mint(_to, _amountLD);
        bridgedIn += _amountLD;
        return _amountLD;
    }
}
