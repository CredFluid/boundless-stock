// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { IOAppComposer } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import { IOFT, SendParam, MessagingReceipt, OFTReceipt } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { SwapTypes } from "./SwapTypes.sol";

/**
 * @title SwapRequest
 * @notice MIRROR CHAIN ONLY. The user-facing entrypoint on a chain with zero liquidity.
 *
 * @dev This contract is the near side of the core claim. It holds no pool, quotes no price,
 *      and has no idea what the asset is worth — it cannot, because the quote asset does not
 *      exist on this chain at all. Its entire job is identity, messaging, and recording the
 *      result:
 *
 *        1. take the user's input and commit it to a request,
 *        2. dispatch that input plus the order to the home chain in a single OFT packet,
 *        3. record the authenticated outcome when it comes back.
 *
 *      ON "LOCKING": the input is pulled from the user and then *burned* by the OFT as the
 *      bridge's debit leg — it is not sitting in a vault here. Custody during flight is the
 *      OFT's burn/mint invariant: supply is constant across the chain set, and the tokens
 *      exist on the home chain for the duration. A refund mints them back here and releases
 *      them to the user. The distinction matters when reasoning about a stalled message, so
 *      it is stated plainly rather than papered over with the word "escrow".
 */
contract SwapRequest is OApp, IOAppComposer {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;
    using OFTComposeMsgCodec for bytes;

    struct Request {
        address user; // who submitted it, and who a refund returns to
        address recipientOnHome; // who receives the quote asset on the home chain
        uint256 amountIn; // input actually bridged (post dust removal)
        uint256 minAmountOut; // slippage floor enforced by the home-chain pool
        uint256 amountOut; // filled in on settlement
        uint64 createdAt;
        uint64 settledAt;
        SwapTypes.Status status;
        uint8 failureReason;
    }

    /// @notice The omnichain asset on this mirror chain. Same address used as ERC-20 and OFT.
    IERC20 public immutable token;
    IOFT public immutable oft;
    /// @notice LayerZero eid of the home chain, where all liquidity lives.
    uint32 public immutable homeEid;

    uint64 public nextRequestId = 1;
    mapping(uint64 => Request) public requests;
    /// @notice Every request id this contract has ever created, for off-chain enumeration.
    uint64[] public requestIds;

    /// @notice Gas for the OFT's `lzReceive` on the home chain.
    uint128 public homeLzReceiveGas = 250_000;
    /// @notice Gas for `SwapRelay.lzCompose` on the home chain (the swap itself).
    uint128 public homeComposeGas = 600_000;
    /**
     * @notice Native value forwarded to SwapRelay with the compose call.
     * @dev This is what pays for the home -> mirror return leg. The user funds it as part of
     *      `msg.value`, so the round trip is paid for up front in one transaction on one
     *      chain. Denominated in the HOME chain's native token.
     */
    uint128 public homeComposeValue = 0.002 ether;

    event SwapRequested(
        uint64 indexed requestId,
        address indexed user,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipientOnHome
    );
    event SwapFilled(uint64 indexed requestId, uint256 amountIn, uint256 amountOut);
    event SwapRefunded(uint64 indexed requestId, address indexed user, uint256 amount, uint8 reason);
    event DustReturned(uint64 indexed requestId, address indexed user, uint256 amount);

    /// @dev `OnlyEndpoint(address)` is inherited from OAppReceiver.
    error UnexpectedComposeSource(address from);
    error UnexpectedOrigin(uint32 srcEid, bytes32 sender);
    error InsufficientFee(uint256 required, uint256 supplied);
    error ZeroAmount();
    error UnknownRequest(uint64 requestId);

    constructor(
        address _endpoint,
        address _owner,
        address _token,
        uint32 _homeEid
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        token = IERC20(_token);
        oft = IOFT(_token);
        homeEid = _homeEid;
    }

    // ------------------------------------------------------------------ user entrypoint

    /**
     * @notice Submit a swap to be executed on the home chain's pool.
     * @param _amountIn        Amount of the omnichain asset to sell. Caller must have approved this contract.
     * @param _minAmountOut    Slippage floor in quote-asset units, enforced by the home-chain pool.
     * @param _recipientOnHome Address that receives the quote asset on the home chain.
     * @return requestId       Identifier to track this request; echoed back in the settlement.
     *
     * @dev `msg.value` must cover the LayerZero fee returned by {quoteSwap}. Any excess is
     *      refunded to the caller by the endpoint.
     */
    function requestSwap(
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipientOnHome
    ) external payable returns (uint64 requestId) {
        if (_amountIn == 0) revert ZeroAmount();

        requestId = nextRequestId++;
        requestIds.push(requestId);

        token.safeTransferFrom(msg.sender, address(this), _amountIn);

        SendParam memory sendParam = _buildSendParam(requestId, _amountIn, _minAmountOut, _recipientOnHome, msg.sender);

        MessagingFee memory fee = oft.quoteSend(sendParam, false);
        if (msg.value < fee.nativeFee) revert InsufficientFee(fee.nativeFee, msg.value);

        // Excess native is refunded to the caller by the endpoint.
        (, OFTReceipt memory oftReceipt) = oft.send{ value: msg.value }(sendParam, fee, msg.sender);

        // The OFT quantises to shared decimals (6) before bridging, so anything finer than
        // that never leaves this chain. Hand it straight back rather than letting it silently
        // accumulate in this contract. See NOTES.md.
        uint256 sent = oftReceipt.amountSentLD;
        if (_amountIn > sent) {
            uint256 dust = _amountIn - sent;
            token.safeTransfer(msg.sender, dust);
            emit DustReturned(requestId, msg.sender, dust);
        }

        requests[requestId] = Request({
            user: msg.sender,
            recipientOnHome: _recipientOnHome,
            amountIn: sent,
            minAmountOut: _minAmountOut,
            amountOut: 0,
            createdAt: uint64(block.timestamp),
            settledAt: 0,
            status: SwapTypes.Status.PENDING,
            failureReason: uint8(SwapTypes.FailureReason.NONE)
        });

        emit SwapRequested(requestId, msg.sender, sent, _minAmountOut, _recipientOnHome);
    }

    /// @notice Native fee required for {requestSwap} with the same arguments.
    function quoteSwap(
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipientOnHome
    ) external view returns (MessagingFee memory) {
        SendParam memory sendParam = _buildSendParam(
            nextRequestId,
            _amountIn,
            _minAmountOut,
            _recipientOnHome,
            msg.sender
        );
        return oft.quoteSend(sendParam, false);
    }

    function _buildSendParam(
        uint64 _requestId,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipientOnHome,
        address _refundTo
    ) internal view returns (SendParam memory) {
        bytes memory composeMsg = SwapTypes.encodeOrder(
            SwapTypes.Order({
                requestId: _requestId,
                minAmountOut: _minAmountOut,
                recipient: _recipientOnHome,
                refundTo: _refundTo
            })
        );

        bytes memory options = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(homeLzReceiveGas, 0)
            .addExecutorLzComposeOption(0, homeComposeGas, homeComposeValue);

        return
            SendParam({
                dstEid: homeEid,
                to: peers[homeEid], // the SwapRelay on the home chain
                amountLD: _amountIn,
                minAmountLD: 0, // dust removal is handled explicitly above
                extraOptions: options,
                composeMsg: composeMsg,
                oftCmd: ""
            });
    }

    // ------------------------------------------------------------------ inbound: success

    /// @dev Settlement receipt from SwapRelay. OApp has already verified the peer.
    function _lzReceive(
        Origin calldata _origin,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) internal override {
        if (_origin.srcEid != homeEid) revert UnexpectedOrigin(_origin.srcEid, _origin.sender);

        SwapTypes.Receipt memory receipt = SwapTypes.decodeReceipt(_message);
        Request storage r = requests[receipt.requestId];
        if (r.status != SwapTypes.Status.PENDING) return; // already settled; ignore replays

        r.status = SwapTypes.Status.FILLED;
        r.amountOut = receipt.amountOut;
        r.settledAt = uint64(block.timestamp);

        emit SwapFilled(receipt.requestId, receipt.amountIn, receipt.amountOut);
    }

    // ------------------------------------------------------------------ inbound: refund

    /// @dev Refund leg: the input returns as OFT tokens with the notice as composeMsg.
    function lzCompose(
        address _from,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) external payable override {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint(msg.sender);
        if (_from != address(token)) revert UnexpectedComposeSource(_from);

        uint32 srcEid = _message.srcEid();
        bytes32 composeFrom = _message.composeFrom();
        if (srcEid != homeEid || composeFrom != peers[homeEid]) revert UnexpectedOrigin(srcEid, composeFrom);

        uint256 amountReturned = _message.amountLD();
        SwapTypes.RefundNotice memory notice = SwapTypes.decodeRefund(_message.composeMsg());

        Request storage r = requests[notice.requestId];
        if (r.status != SwapTypes.Status.PENDING) return; // already settled; keep funds retrievable via sweep

        r.status = SwapTypes.Status.REFUNDED;
        r.failureReason = notice.reason;
        r.settledAt = uint64(block.timestamp);

        token.safeTransfer(r.user, amountReturned);
        emit SwapRefunded(notice.requestId, r.user, amountReturned, notice.reason);
    }

    // ------------------------------------------------------------------ views

    function getRequest(uint64 _requestId) external view returns (Request memory) {
        Request memory r = requests[_requestId];
        if (r.user == address(0)) revert UnknownRequest(_requestId);
        return r;
    }

    function requestCount() external view returns (uint256) {
        return requestIds.length;
    }

    // ------------------------------------------------------------------ admin

    function setGasParams(uint128 _lzReceiveGas, uint128 _composeGas, uint128 _composeValue) external onlyOwner {
        homeLzReceiveGas = _lzReceiveGas;
        homeComposeGas = _composeGas;
        homeComposeValue = _composeValue;
    }

    /**
     * @notice Owner rescue for tokens that arrived without a matching open request.
     * @dev POC-only safety valve, e.g. a refund landing after a request was already settled.
     *      A production version needs a principled claim path instead — see agents.md §9.
     */
    function sweep(address _to, uint256 _amount) external onlyOwner {
        token.safeTransfer(_to, _amount);
    }

    receive() external payable {}
}
