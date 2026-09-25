// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @dev The slice of a Uniswap V3 pool the quoter drives.
interface IUniswapV3PoolSwap {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/**
 * @title PoolQuoter
 * @notice Exact output of a Uniswap V3 exact-input swap, computed by the pool itself.
 *
 * @dev Never deployed. The read API places this contract's runtime code at an unused address
 *      through an `eth_call` state override and calls `quoteExactInput`. The pool runs the real
 *      swap — every tick crossed, the fee applied — then asks this contract to pay, and the
 *      callback reverts with the output instead. The revert unwinds the swap, so nothing
 *      changes, and the figure is exactly what `SwapRelay` would receive for the same input at
 *      the same state, because it swaps through the same pool with no price limit.
 *
 *      The same technique as Uniswap's own Quoter, without its immutables: this contract needs
 *      no factory address, so its runtime code works as-is at any address.
 */
contract PoolQuoter {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    error UnexpectedSuccess();

    function quoteExactInput(address _pool, bool _zeroForOne, uint256 _amountIn) external returns (uint256) {
        try IUniswapV3PoolSwap(_pool)
            .swap(
                address(this),
                _zeroForOne,
                int256(_amountIn),
                _zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                ""
            ) {
            revert UnexpectedSuccess();
        } catch (bytes memory reason) {
            // Our callback's revert carries exactly one word. Anything else is a real failure
            // from the pool (no liquidity, a locked pool) and is passed on unchanged.
            if (reason.length != 32) {
                assembly {
                    revert(add(reason, 32), mload(reason))
                }
            }
            return abi.decode(reason, (uint256));
        }
    }

    function uniswapV3SwapCallback(int256 _amount0Delta, int256 _amount1Delta, bytes calldata) external pure {
        // The positive delta is what the pool wants paid; the negative one is the output.
        uint256 amountOut = uint256(-(_amount0Delta < 0 ? _amount0Delta : _amount1Delta));
        assembly {
            let p := mload(0x40)
            mstore(p, amountOut)
            revert(p, 32)
        }
    }
}
