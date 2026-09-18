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
import { ISwapRouter } from "./interfaces/IUniswapV3.sol";

/**
 * @title SwapRelay
 * @notice HOME CHAIN ONLY. The contract where all price discovery and execution actually happen.
 *
 * @dev This is the far side of the core claim. A mirror chain with zero liquidity sends an
 *      order here, packaged as the `composeMsg` of an OFT `send()`, so the input tokens and
 *      the instruction arrive in the same LayerZero packet. That coupling is deliberate: the
 *      relay can never be asked to execute an order whose funds have not already landed.
 *
 *      Settlement outcomes:
 *
 *        SUCCESS  swap runs against the real Uniswap V3 pool -> quote asset is delivered to
 *                 the recipient ON THIS CHAIN, and a Receipt goes back to the originating
 *                 mirror chain over the relay pair's own peer path.
 *
 *        FAILURE  the input is bridged BACK to the originating mirror chain via OFT `send()`,
 *                 carrying a RefundNotice as its composeMsg. One packet both restores the
 *                 funds and closes out the request.
 *
 *      `lzCompose` is written so that it does not revert on a failed swap: reverting would
 *      leave the compose in a retryable-but-stuck state with tokens sitting here. Instead
 *      failures are converted into the refund path, and if even the refund dispatch fails
 *      (e.g. this contract is out of native gas) the amount is recorded in `stranded` and can
 *      be retried permissionlessly. See NOTES.md for why that last branch exists.
 */
contract SwapRelay is OApp, IOAppComposer {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;
    using OFTComposeMsgCodec for bytes;

    /// @notice The omnichain asset being traded (TokenizedStock). Also the OFT that delivers orders.
    IERC20 public immutable baseToken;
    /// @notice The pairing asset (USDC). Home-chain only, never bridged.
    IERC20 public immutable quoteToken;
    /// @notice Uniswap V3 router used for execution.
    ISwapRouter public immutable router;
    /// @notice Fee tier of the TokenizedStock/USDC pool.
    uint24 public immutable poolFee;

    /// @notice Gas granted to the Receipt message's `lzReceive` on each mirror chain.
    mapping(uint32 eid => uint128 gas) public returnGas;
    /// @notice Gas granted to the RefundNotice's `lzCompose` on each mirror chain.
    mapping(uint32 eid => uint128 gas) public refundComposeGas;

    /// @notice Input that could not be swapped *and* could not be sent home. Retryable.
    mapping(uint32 eid => mapping(uint64 requestId => uint256 amount)) public stranded;

    uint128 public constant DEFAULT_RETURN_GAS = 250_000;
    uint128 public constant DEFAULT_REFUND_COMPOSE_GAS = 250_000;

    event OrderReceived(uint32 indexed srcEid, uint64 indexed requestId, uint256 amountIn, address recipient);
    event OrderFilled(uint32 indexed srcEid, uint64 indexed requestId, uint256 amountIn, uint256 amountOut);
    event OrderFailed(uint32 indexed srcEid, uint64 indexed requestId, uint8 reason, uint256 amountIn);
    event RefundDispatched(uint32 indexed srcEid, uint64 indexed requestId, uint256 amount);
    event FundsStranded(uint32 indexed srcEid, uint64 indexed requestId, uint256 amount, string reason);
    event NativeFunded(address indexed from, uint256 amount);

    /// @dev `OnlyEndpoint(address)` is inherited from OAppReceiver.
    error UnexpectedComposeSource(address from);

    constructor(
        address _endpoint,
        address _owner,
        address _baseToken,
        address _quoteToken,
        address _router,
        uint24 _poolFee
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        baseToken = IERC20(_baseToken);
        quoteToken = IERC20(_quoteToken);
        router = ISwapRouter(_router);
        poolFee = _poolFee;
    }

    // ------------------------------------------------------------------ inbound: the order

    /**
     * @notice Entry point for a cross-chain swap order.
     * @dev Called by the LayerZero endpoint after the OFT has already credited this contract
     *      with `amountLD` of `baseToken`.
     */
    function lzCompose(
        address _from,
        bytes32 /* _guid */,
        bytes calldata _message,
        address /* _executor */,
        bytes calldata /* _extraData */
    ) external payable override {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint(msg.sender);
        // Only the OFT that carries our asset may deliver orders here.
        if (_from != address(baseToken)) revert UnexpectedComposeSource(_from);

        uint32 srcEid = _message.srcEid();
        uint256 amountIn = _message.amountLD();
        bytes32 composeFrom = _message.composeFrom();

        SwapTypes.Order memory order = SwapTypes.decodeOrder(_message.composeMsg());
        emit OrderReceived(srcEid, order.requestId, amountIn, order.recipient);

        // Authenticate the originator: the order must come from the SwapRequest registered as
        // this relay's peer on that chain. Anyone else's tokens are bounced straight back.
        if (composeFrom != peers[srcEid] || peers[srcEid] == bytes32(0)) {
            emit OrderFailed(srcEid, order.requestId, uint8(SwapTypes.FailureReason.UNAUTHORIZED_SOURCE), amountIn);
            _dispatchRefund(srcEid, order, amountIn, SwapTypes.FailureReason.UNAUTHORIZED_SOURCE);
            return;
        }

        _settle(srcEid, amountIn, order);
    }

    /// @dev Executes against the pool, then routes to the success or failure leg.
    function _settle(uint32 _srcEid, uint256 _amountIn, SwapTypes.Order memory _order) internal {
        baseToken.forceApprove(address(router), _amountIn);

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(baseToken),
            tokenOut: address(quoteToken),
            fee: poolFee,
            recipient: _order.recipient,
            deadline: block.timestamp,
            amountIn: _amountIn,
            amountOutMinimum: _order.minAmountOut,
            sqrtPriceLimitX96: 0
        });

        try router.exactInputSingle(params) returns (uint256 amountOut) {
            baseToken.forceApprove(address(router), 0);
            emit OrderFilled(_srcEid, _order.requestId, _amountIn, amountOut);
            _dispatchReceipt(_srcEid, _order.requestId, _amountIn, amountOut);
        } catch {
            // Clear the approval before doing anything else — the router must not retain an
            // allowance over an amount we are about to send back across the bridge.
            baseToken.forceApprove(address(router), 0);
            emit OrderFailed(_srcEid, _order.requestId, uint8(SwapTypes.FailureReason.SLIPPAGE), _amountIn);
            _dispatchRefund(_srcEid, _order, _amountIn, SwapTypes.FailureReason.SLIPPAGE);
        }
    }

    // ------------------------------------------------------------------ outbound: success

    /// @dev Success leg: a plain OApp message on the relay pair's peer path.
    function _dispatchReceipt(uint32 _dstEid, uint64 _requestId, uint256 _amountIn, uint256 _amountOut) internal {
        bytes memory payload = SwapTypes.encodeReceipt(
            SwapTypes.Receipt({ requestId: _requestId, amountIn: _amountIn, amountOut: _amountOut })
        );
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(_returnGas(_dstEid), 0);

        MessagingFee memory fee = _quote(_dstEid, payload, options, false);
        // Paid out of this contract's native balance, which is topped up by the value the
        // executor forwards with each inbound lzCompose. See _payNative below.
        _lzSend(_dstEid, payload, options, fee, address(this));
    }

    // ------------------------------------------------------------------ outbound: failure

    /// @dev Failure leg: bridge the input back, carrying the notice as composeMsg.
    function _dispatchRefund(
        uint32 _dstEid,
        SwapTypes.Order memory _order,
        uint256 _amount,
        SwapTypes.FailureReason _reason
    ) internal {
        bytes memory composeMsg = SwapTypes.encodeRefund(
            SwapTypes.RefundNotice({ requestId: _order.requestId, reason: uint8(_reason), amountReturned: _amount })
        );

        bytes memory options = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(_returnGas(_dstEid), 0)
            .addExecutorLzComposeOption(0, _refundComposeGas(_dstEid), 0);

        SendParam memory sendParam = SendParam({
            dstEid: _dstEid,
            to: peers[_dstEid], // the SwapRequest on that mirror chain
            amountLD: _amount,
            minAmountLD: 0, // a refund must never fail on dust; the notice carries the exact figure
            extraOptions: options,
            composeMsg: composeMsg,
            oftCmd: ""
        });

        IOFT oft = IOFT(address(baseToken));

        try oft.quoteSend(sendParam, false) returns (MessagingFee memory fee) {
            if (address(this).balance < fee.nativeFee) {
                stranded[_dstEid][_order.requestId] += _amount;
                emit FundsStranded(_dstEid, _order.requestId, _amount, "insufficient native for refund");
                return;
            }
            try oft.send{ value: fee.nativeFee }(sendParam, fee, address(this)) returns (
                MessagingReceipt memory,
                OFTReceipt memory
            ) {
                emit RefundDispatched(_dstEid, _order.requestId, _amount);
            } catch {
                stranded[_dstEid][_order.requestId] += _amount;
                emit FundsStranded(_dstEid, _order.requestId, _amount, "refund send reverted");
            }
        } catch {
            stranded[_dstEid][_order.requestId] += _amount;
            emit FundsStranded(_dstEid, _order.requestId, _amount, "refund quote reverted");
        }
    }

    /**
     * @notice Retry a refund that previously could not be dispatched.
     * @dev Permissionless: anyone may pay the gas to unstick a user's funds. The destination
     *      is fixed to the registered peer, so this cannot be used to redirect anything.
     */
    function retryRefund(uint32 _dstEid, uint64 _requestId, address _refundTo) external payable {
        uint256 amount = stranded[_dstEid][_requestId];
        require(amount > 0, "SwapRelay: nothing stranded");
        stranded[_dstEid][_requestId] = 0;

        SwapTypes.Order memory order = SwapTypes.Order({
            requestId: _requestId,
            minAmountOut: 0,
            recipient: address(0),
            refundTo: _refundTo
        });
        _dispatchRefund(_dstEid, order, amount, SwapTypes.FailureReason.POOL_ERROR);
    }

    // ------------------------------------------------------------------ inbound: OApp

    /// @dev The relay does not expect inbound OApp messages; orders arrive via lzCompose.
    function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) internal override {}

    // ------------------------------------------------------------------ admin / plumbing

    function setReturnGas(uint32 _eid, uint128 _gas) external onlyOwner {
        returnGas[_eid] = _gas;
    }

    function setRefundComposeGas(uint32 _eid, uint128 _gas) external onlyOwner {
        refundComposeGas[_eid] = _gas;
    }

    function _returnGas(uint32 _eid) internal view returns (uint128) {
        uint128 g = returnGas[_eid];
        return g == 0 ? DEFAULT_RETURN_GAS : g;
    }

    function _refundComposeGas(uint32 _eid) internal view returns (uint128) {
        uint128 g = refundComposeGas[_eid];
        return g == 0 ? DEFAULT_REFUND_COMPOSE_GAS : g;
    }

    /**
     * @dev The relay sends messages from inside `lzCompose`, where `msg.value` is whatever the
     *      executor forwarded, not a figure this contract chose. The default OAppSender
     *      implementation demands `msg.value == nativeFee` exactly, which can never hold here.
     *      Paying from the contract's own balance is the standard pattern for automated /
     *      composed sends.
     */
    function _payNative(uint256 _nativeFee) internal view override returns (uint256) {
        if (address(this).balance < _nativeFee) revert NotEnoughNative(address(this).balance);
        return _nativeFee;
    }

    /// @notice Top up the native balance used to pay for return-leg messages.
    function fundNative() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }

    function withdrawNative(address payable _to, uint256 _amount) external onlyOwner {
        (bool ok, ) = _to.call{ value: _amount }("");
        require(ok, "SwapRelay: withdraw failed");
    }

    receive() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }
}
