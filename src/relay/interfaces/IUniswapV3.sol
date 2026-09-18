// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @notice Minimal local declarations of the Uniswap V3 surfaces this repo touches.
 * @dev Declared here rather than imported from `@uniswap/v3-periphery` because those sources
 *      pin `pragma >=0.7.5 <0.8.0` and cannot compile in the same 0.8.22 unit as the
 *      LayerZero stack. The deployed bytecode still comes from the official npm artifacts —
 *      see infra/lib/uniswap.ts. Only the ABI surface is restated.
 */
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}

interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function liquidity() external view returns (uint128);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function initialize(uint160 sqrtPriceX96) external;
}
