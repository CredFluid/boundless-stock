// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISwapRouter } from "../../src/relay/interfaces/IUniswapV3.sol";

/**
 * @notice A Uniswap V3 router stand-in with a controllable price and failure switches.
 *
 * @dev Used instead of real Uniswap V3 in the invariant suite on purpose. The properties under
 *      test are the relay's *accounting* — that nothing it receives is ever lost, double-paid
 *      or silently absorbed — and those depend on the swap's outcome, not on how the outcome
 *      was computed. A mock lets the fuzzer drive the outcome directly, including reverts and
 *      zero-output swaps, which real V3 would essentially never produce.
 *
 *      The price is DIRECTION-AWARE. An earlier version applied one `num/den` ratio to every
 *      swap, which cannot be correct for both directions at once: a rate calibrated for buys
 *      makes sells absurd. The result was that no trade ever filled and the success path went
 *      untested — which the suite's coverage assertion caught.
 *
 *      Holds a float of both assets, exactly as a pool does.
 */
contract MockSwapRouter is ISwapRouter {
    address public immutable stock;
    address public immutable quote;
    uint256 public immutable stockUnit; // 10 ** stockDecimals

    /// @notice Price in quote raw units per ONE whole stock token, e.g. 150e6 for 150 USDC.
    uint256 public priceQuotePerStock;

    /// @notice When set, every swap reverts — stands in for any router-side failure.
    bool public forceRevert;
    /// @notice When set, swaps succeed but return nothing.
    bool public returnZero;

    constructor(address _stock, address _quote, uint8 _stockDecimals, uint256 _initialPrice) {
        stock = _stock;
        quote = _quote;
        stockUnit = 10 ** _stockDecimals;
        priceQuotePerStock = _initialPrice;
    }

    function setPrice(uint256 _price) external {
        require(_price > 0, "price=0");
        priceQuotePerStock = _price;
    }

    function setForceRevert(bool _v) external {
        forceRevert = _v;
    }

    function setReturnZero(bool _v) external {
        returnZero = _v;
    }

    /// @notice Output for `_amountIn` of `_tokenIn`, in `_tokenOut` raw units.
    function quoteSwap(address _tokenIn, uint256 _amountIn) public view returns (uint256) {
        if (returnZero) return 0;
        if (_tokenIn == quote) {
            // buying stock with quote
            return (_amountIn * stockUnit) / priceQuotePerStock;
        }
        // selling stock for quote
        return (_amountIn * priceQuotePerStock) / stockUnit;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 amountOut) {
        require(!forceRevert, "MockSwapRouter: forced failure");

        amountOut = quoteSwap(p.tokenIn, p.amountIn);
        require(amountOut >= p.amountOutMinimum, "Too little received");
        require(IERC20(p.tokenOut).balanceOf(address(this)) >= amountOut, "MockSwapRouter: insufficient float");

        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }
}
