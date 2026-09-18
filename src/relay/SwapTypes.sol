// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/**
 * @title SwapTypes
 * @notice Wire format shared by SwapRequest (mirror chains) and SwapRelay (home chain).
 *
 * @dev Three payloads move across the wire, on two distinct LayerZero pathways:
 *
 *      1. ORDER    mirror -> home, carried as the `composeMsg` of an OFT `send()`.
 *                  The tokens and the instruction travel together in one packet, so the
 *                  relay can never be asked to execute an order whose funds have not
 *                  arrived.
 *
 *      2. RECEIPT  home -> mirror, a plain OApp message on the relay pair's own peer path.
 *                  Reports the settled result. Used on success.
 *
 *      3. REFUND   home -> mirror, carried as the `composeMsg` of an OFT `send()` back.
 *                  Used on failure: the tokens themselves return alongside the notice, so
 *                  one packet both restores funds and closes out the request.
 */
library SwapTypes {
    /// @notice Lifecycle of a swap request as tracked on the mirror chain.
    enum Status {
        NONE, // never existed
        PENDING, // dispatched to the home chain, awaiting settlement
        FILLED, // executed on the home chain pool; proceeds delivered there
        REFUNDED // execution failed; input returned to the user on the mirror chain
    }

    /// @notice Why a request was refunded rather than filled.
    enum FailureReason {
        NONE,
        SLIPPAGE, // pool could not satisfy minAmountOut
        POOL_ERROR, // router reverted for any other reason
        UNAUTHORIZED_SOURCE // order arrived from a sender that is not the registered peer
    }

    /// @dev Encoded into the OFT composeMsg on the mirror -> home leg.
    struct Order {
        uint64 requestId; // unique per (mirror chain, SwapRequest) pair
        uint256 minAmountOut; // slippage floor, in quote-asset units
        address recipient; // who receives the quote asset on the HOME chain
        address refundTo; // who receives the input back on the MIRROR chain if it fails
    }

    /// @dev Encoded into the OApp message on the home -> mirror success leg.
    struct Receipt {
        uint64 requestId;
        uint256 amountIn; // input actually executed (post bridge-dust removal)
        uint256 amountOut; // quote asset received on the home chain
    }

    /// @dev Encoded into the OFT composeMsg on the home -> mirror failure leg.
    struct RefundNotice {
        uint64 requestId;
        uint8 reason; // SwapTypes.FailureReason
        uint256 amountReturned;
    }

    function encodeOrder(Order memory _o) internal pure returns (bytes memory) {
        return abi.encode(_o.requestId, _o.minAmountOut, _o.recipient, _o.refundTo);
    }

    function decodeOrder(bytes memory _b) internal pure returns (Order memory o) {
        (o.requestId, o.minAmountOut, o.recipient, o.refundTo) = abi.decode(
            _b,
            (uint64, uint256, address, address)
        );
    }

    function encodeReceipt(Receipt memory _r) internal pure returns (bytes memory) {
        return abi.encode(_r.requestId, _r.amountIn, _r.amountOut);
    }

    function decodeReceipt(bytes memory _b) internal pure returns (Receipt memory r) {
        (r.requestId, r.amountIn, r.amountOut) = abi.decode(_b, (uint64, uint256, uint256));
    }

    function encodeRefund(RefundNotice memory _n) internal pure returns (bytes memory) {
        return abi.encode(_n.requestId, _n.reason, _n.amountReturned);
    }

    function decodeRefund(bytes memory _b) internal pure returns (RefundNotice memory n) {
        (n.requestId, n.reason, n.amountReturned) = abi.decode(_b, (uint64, uint8, uint256));
    }
}
