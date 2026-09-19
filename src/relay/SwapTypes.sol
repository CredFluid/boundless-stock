// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title SwapTypes
 * @notice Wire format shared by SwapRequest (mirror chains) and SwapRelay (home chain).
 *
 * @dev Two payloads move across the wire, both carried as the `composeMsg` of an OFT `send()`
 *      so that tokens and instruction always travel in the same packet:
 *
 *      1. ORDER      mirror -> home.  The input tokens plus what to do with them.
 *      2. SETTLEMENT home -> mirror.  The outcome, alongside the tokens being returned —
 *                    the *output* asset when the swap filled, the *input* asset when it did
 *                    not. One shape covers both, because from the mirror chain's point of
 *                    view a fill and a refund are the same event: tokens arrived and a
 *                    request closed.
 *
 *      Coupling tokens to the instruction is the core safety property. Neither side can ever
 *      be asked to act on a message whose funds have not already arrived.
 */
library SwapTypes {
    /// @notice Which way the trade goes, from the mirror-chain user's point of view.
    enum Direction {
        BUY, // pay the quote asset (USDC), receive the omnichain stock
        SELL // pay the omnichain stock, receive the quote asset
    }

    /// @notice Lifecycle of a request as tracked on the mirror chain.
    enum Status {
        NONE,
        PENDING, // dispatched to the home chain, awaiting settlement
        FILLED, // executed on the home chain pool; output delivered back here
        REFUNDED // execution failed; input returned here, in full
    }

    /// @notice Why a request was refunded rather than filled.
    enum FailureReason {
        NONE,
        SLIPPAGE, // the pool could not satisfy minAmountOut
        POOL_ERROR, // the router reverted for any other reason
        UNAUTHORIZED_SOURCE // the order did not come from the registered peer
    }

    /// @dev mirror -> home, inside the OFT composeMsg.
    struct Order {
        uint64 requestId; // unique per (mirror chain, SwapRequest) pair
        uint8 direction; // SwapTypes.Direction, declared by the sender
        uint256 minAmountOut; // slippage floor, in output-asset units
        address recipient; // who receives the result, ON THE MIRROR CHAIN
    }

    /// @dev home -> mirror, inside the OFT composeMsg accompanying the returned tokens.
    struct Settlement {
        uint64 requestId;
        uint8 status; // SwapTypes.Status: FILLED or REFUNDED
        uint8 reason; // SwapTypes.FailureReason, NONE when filled
        uint256 amountIn; // input actually executed (post bridge-dust removal)
        uint256 amountOut; // output produced on the home chain pool
    }

    function encodeOrder(Order memory _o) internal pure returns (bytes memory) {
        return abi.encode(_o.requestId, _o.direction, _o.minAmountOut, _o.recipient);
    }

    function decodeOrder(bytes memory _b) internal pure returns (Order memory o) {
        (o.requestId, o.direction, o.minAmountOut, o.recipient) = abi.decode(
            _b,
            (uint64, uint8, uint256, address)
        );
    }

    function encodeSettlement(Settlement memory _s) internal pure returns (bytes memory) {
        return abi.encode(_s.requestId, _s.status, _s.reason, _s.amountIn, _s.amountOut);
    }

    function decodeSettlement(bytes memory _b) internal pure returns (Settlement memory s) {
        (s.requestId, s.status, s.reason, s.amountIn, s.amountOut) = abi.decode(
            _b,
            (uint64, uint8, uint8, uint256, uint256)
        );
    }
}
