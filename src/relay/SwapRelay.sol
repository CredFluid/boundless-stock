// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { ILayerZeroEndpointV2 } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { IOAppComposer } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import {
    IOFT,
    SendParam,
    MessagingFee,
    MessagingReceipt,
    OFTReceipt
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { SwapTypes } from "./SwapTypes.sol";
import { ISwapRouter } from "./interfaces/IUniswapV3.sol";

/**
 * @title SwapRelay
 * @notice HOME CHAIN ONLY. The single place where price discovery and execution happen.
 *
 * @dev This is the far side of the core claim. A mirror chain with no pool, no market maker
 *      and no price of its own sends an order here packaged as the `composeMsg` of an OFT
 *      `send()`, so the input tokens and the instruction arrive in one packet.
 *
 *      Both directions are supported and are perfectly symmetric:
 *
 *        BUY   the quote asset (USDC) arrives -> swap quote->base -> the stock goes back
 *        SELL  the stock arrives             -> swap base->quote -> USDC goes back
 *
 *      THE DIRECTION IS NEVER TAKEN FROM THE MESSAGE. It is derived from which OFT actually
 *      delivered the tokens, because that is the one thing a sender cannot forge: the order's
 *      declared direction is only cross-checked, and a mismatch is refunded rather than
 *      executed.
 *
 *      Every outcome returns tokens to the originating mirror chain via OFT `send()` — the
 *      output asset on a fill, the input asset on a failure — each carrying a Settlement as
 *      its composeMsg. One packet both moves the funds and closes out the request.
 *
 *      `lzCompose` never reverts on a failed swap. Reverting would leave the compose in a
 *      retryable-but-stuck state with tokens sitting here, unreachable by the user. Failures
 *      are converted into refunds instead, and if even the refund dispatch fails the amount is
 *      recorded in `stranded` and can be retried permissionlessly.
 */
contract SwapRelay is OApp, IOAppComposer {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;
    using OFTComposeMsgCodec for bytes;

    /// @notice The stock being traded, as an ERC-20. What the pool actually holds.
    IERC20 public immutable baseToken;
    /// @notice The quote asset, as an ERC-20. Liquid only here, on the home chain.
    IERC20 public immutable quoteToken;

    /**
     * @notice The OFT handle for each asset — the contract that moves it across chains.
     * @dev Equal to the token itself when the asset is a native {OmniToken}, and a separate
     *      {OmniTokenAdapter} when the issuer brought a token that already existed. Keeping the
     *      two handles distinct is what lets one relay serve both cases: the pool is always
     *      traded in the underlying, while messaging always goes through the OFT.
     */
    IOFT public immutable baseOft;
    IOFT public immutable quoteOft;
    /// @notice Uniswap V3 router used for execution.
    ISwapRouter public immutable router;
    /// @notice Fee tier of the base/quote pool.
    uint24 public immutable poolFee;

    /// @notice Gas granted to the return packet's `lzReceive` on each mirror chain.
    mapping(uint32 eid => uint128 gas) public returnGas;
    /// @notice Gas granted to `SwapRequest.lzCompose` on each mirror chain.
    mapping(uint32 eid => uint128 gas) public returnComposeGas;

    /// @notice Input that could not be swapped *and* could not be sent home. Retryable.
    mapping(uint32 eid => mapping(uint64 requestId => uint256 amount)) public stranded;
    /// @notice Which token a stranded amount is denominated in.
    mapping(uint32 eid => mapping(uint64 requestId => address token)) public strandedToken;
    /**
     * @notice Who the stranded amount belongs to, as LayerZero addresses them.
     * @dev Taken from the order's `recipient`. Recorded so a stranded amount has a known owner
     *      rather than becoming anonymous value sitting in this contract, which is what turns
     *      "recoverable in principle" into "claimable in practice".
     */
    mapping(uint32 eid => mapping(uint64 requestId => bytes32 beneficiary)) public strandedBeneficiary;

    /// @notice Sub-quantum remainders left behind by OFT dust removal on return sends.
    mapping(address token => uint256 amount) public dustAccrued;

    uint128 public constant DEFAULT_RETURN_GAS = 250_000;
    uint128 public constant DEFAULT_RETURN_COMPOSE_GAS = 300_000;

    event OrderReceived(uint32 indexed srcEid, uint64 indexed requestId, address tokenIn, uint256 amountIn);
    event OrderFilled(uint32 indexed srcEid, uint64 indexed requestId, uint256 amountIn, uint256 amountOut);
    event OrderFailed(uint32 indexed srcEid, uint64 indexed requestId, uint8 reason, uint256 amountIn);
    event ReturnDispatched(uint32 indexed srcEid, uint64 indexed requestId, address token, uint256 amount);
    event FundsStranded(uint32 indexed srcEid, uint64 indexed requestId, address token, uint256 amount, string why);
    event StrandedClaimed(uint32 indexed srcEid, uint64 indexed requestId, address token, address to, uint256 amount);
    event NativeFunded(address indexed from, uint256 amount);
    event StuckMessageCancelled(uint32 indexed srcEid, uint64 indexed nonce, address oft, bytes32 payloadHash);

    error UnexpectedComposeSource(address from);
    error NothingStranded(uint32 srcEid, uint64 requestId);
    /// @dev The beneficiary is not expressible as an EVM address, so it cannot be paid here.
    error BeneficiaryNotAddressable(bytes32 beneficiary);

    /// @param _baseOft  OFT handle for the stock: the token itself, or its adapter.
    /// @param _quoteOft OFT handle for the quote asset: the token itself, or its adapter.
    constructor(
        address _endpoint,
        address _owner,
        address _baseToken,
        address _baseOft,
        address _quoteToken,
        address _quoteOft,
        address _router,
        uint24 _poolFee
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        baseToken = IERC20(_baseToken);
        quoteToken = IERC20(_quoteToken);
        baseOft = IOFT(_baseOft);
        quoteOft = IOFT(_quoteOft);
        router = ISwapRouter(_router);
        poolFee = _poolFee;
    }

    // ------------------------------------------------------------------ inbound: the order

    /**
     * @notice Entry point for a cross-chain order.
     * @dev Called by the endpoint after an OFT has already credited this contract with the
     *      input tokens.
     */
    function lzCompose(
        address _from,
        bytes32 /* _guid */,
        bytes calldata _message,
        address /* _executor */,
        bytes calldata /* _extraData */
    ) external payable override {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint(msg.sender);

        // Direction is derived from the delivering OFT, not from the payload. With an adapter
        // the deliverer is the adapter rather than the token, which is why the OFT handles are
        // tracked separately.
        bool isBuy;
        if (_from == address(quoteOft)) isBuy = true;
        else if (_from == address(baseOft)) isBuy = false;
        else revert UnexpectedComposeSource(_from);

        uint32 srcEid = _message.srcEid();
        uint256 amountIn = _message.amountLD();
        bytes32 composeFrom = _message.composeFrom();

        SwapTypes.Order memory order = SwapTypes.decodeOrder(_message.composeMsg());
        emit OrderReceived(srcEid, order.requestId, _from, amountIn);

        IERC20 tokenIn = isBuy ? quoteToken : baseToken;
        IERC20 tokenOut = isBuy ? baseToken : quoteToken;

        // Authenticate the originator: the order must come from the SwapRequest registered as
        // this relay's peer on that chain.
        if (peers[srcEid] == bytes32(0) || composeFrom != peers[srcEid]) {
            emit OrderFailed(srcEid, order.requestId, uint8(SwapTypes.FailureReason.UNAUTHORIZED_SOURCE), amountIn);
            _returnToMirror(
                srcEid,
                order.requestId,
                tokenIn,
                amountIn,
                order.recipient,
                _settlementFor(order.requestId, false, SwapTypes.FailureReason.UNAUTHORIZED_SOURCE, amountIn, 0)
            );
            return;
        }

        // The declared direction is advisory; disagreeing with the delivering OFT means the
        // caller is confused or hostile, so the funds go straight back rather than trading.
        bool declaredBuy = order.direction == uint8(SwapTypes.Direction.BUY);
        if (declaredBuy != isBuy) {
            emit OrderFailed(srcEid, order.requestId, uint8(SwapTypes.FailureReason.POOL_ERROR), amountIn);
            _returnToMirror(
                srcEid,
                order.requestId,
                tokenIn,
                amountIn,
                order.recipient,
                _settlementFor(order.requestId, false, SwapTypes.FailureReason.POOL_ERROR, amountIn, 0)
            );
            return;
        }

        _settle(srcEid, order, tokenIn, tokenOut, amountIn);
    }

    /// @dev Executes against the pool, then returns either the proceeds or the input.
    function _settle(
        uint32 _srcEid,
        SwapTypes.Order memory _order,
        IERC20 _tokenIn,
        IERC20 _tokenOut,
        uint256 _amountIn
    ) internal {
        _tokenIn.forceApprove(address(router), _amountIn);

        // Never execute a swap whose output could not be delivered. Anything below one
        // bridgeable unit cannot cross back to the mirror chain, so accepting it would consume
        // the user's input for a result they can never receive. Raising the floor makes the
        // venue reject the trade instead, which routes into the refund path and returns the
        // user's money. Found by the invariant fuzzer; see NOTES.md.
        uint256 minOut = _order.minAmountOut;
        uint256 quantum = _bridgeQuantum(address(_tokenOut));
        if (minOut < quantum) minOut = quantum;

        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: address(_tokenIn),
            tokenOut: address(_tokenOut),
            fee: poolFee,
            recipient: address(this), // held here, then bridged back to the mirror chain
            deadline: block.timestamp,
            amountIn: _amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0
        });

        try router.exactInputSingle(params) returns (uint256 amountOut) {
            _tokenIn.forceApprove(address(router), 0);
            emit OrderFilled(_srcEid, _order.requestId, _amountIn, amountOut);
            _returnToMirror(
                _srcEid,
                _order.requestId,
                _tokenOut,
                amountOut,
                _order.recipient,
                _settlementFor(_order.requestId, true, SwapTypes.FailureReason.NONE, _amountIn, amountOut)
            );
        } catch {
            // Clear the approval before anything else: the router must not keep an allowance
            // over tokens that are about to be bridged away.
            _tokenIn.forceApprove(address(router), 0);
            emit OrderFailed(_srcEid, _order.requestId, uint8(SwapTypes.FailureReason.SLIPPAGE), _amountIn);
            _returnToMirror(
                _srcEid,
                _order.requestId,
                _tokenIn,
                _amountIn,
                _order.recipient,
                _settlementFor(_order.requestId, false, SwapTypes.FailureReason.SLIPPAGE, _amountIn, 0)
            );
        }
    }

    // ------------------------------------------------------------------ outbound: the result

    /**
     * @dev Sends tokens back to the originating mirror chain with a Settlement attached.
     *      Used identically for fills and refunds — only the token and the payload differ.
     */
    function _returnToMirror(
        uint32 _dstEid,
        uint64 _requestId,
        IERC20 _token,
        uint256 _amount,
        bytes32 _beneficiary,
        bytes memory _settlement
    ) internal {
        // An amount below the OFT's precision floor bridges as ZERO. Sending it anyway would
        // deliver a settlement claiming FILLED while carrying nothing — telling the user their
        // trade succeeded when they received none of it, after their input was already
        // consumed by the venue. Record it as owed on this chain instead, and leave the
        // request unsettled rather than lying about it.
        //
        // Found by the invariant fuzzer via `invariant_fillsDeliverSomething`; see NOTES.md.
        // Note this value is NOT recoverable by `retryReturn` — it will never be bridgeable —
        // so it needs a home-chain claim path before production. Tracked in agents.md.
        if (_amount < _bridgeQuantum(address(_token))) {
            _strand(_dstEid, _requestId, address(_token), _amount, _beneficiary, "amount below the bridgeable minimum");
            return;
        }

        bytes memory options = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(_returnGas(_dstEid), 0)
            .addExecutorLzComposeOption(0, _returnComposeGas(_dstEid), 0);

        SendParam memory sendParam = SendParam({
            dstEid: _dstEid,
            to: peers[_dstEid], // the SwapRequest on that mirror chain
            amountLD: _amount,
            minAmountLD: 0, // a return must never fail on dust; the settlement carries the figure
            extraOptions: options,
            composeMsg: _settlement,
            oftCmd: ""
        });

        IOFT oft = _oftFor(_token);

        // An adapter pulls with transferFrom rather than burning, so it needs an allowance.
        // A native OmniToken reports false here and needs none.
        if (oft.approvalRequired()) {
            _token.forceApprove(address(oft), _amount);
        }

        try oft.quoteSend(sendParam, false) returns (MessagingFee memory fee) {
            if (address(this).balance < fee.nativeFee) {
                _strand(_dstEid, _requestId, address(_token), _amount, _beneficiary, "insufficient native for return");
                return;
            }
            try oft.send{ value: fee.nativeFee }(sendParam, fee, address(this)) returns (
                MessagingReceipt memory,
                OFTReceipt memory oftReceipt
            ) {
                // An 18-decimal OFT quantises to shared decimals, so a sliver can be left
                // behind. Tracked rather than silently absorbed.
                if (_amount > oftReceipt.amountSentLD) {
                    dustAccrued[address(_token)] += _amount - oftReceipt.amountSentLD;
                }
                emit ReturnDispatched(_dstEid, _requestId, address(_token), oftReceipt.amountSentLD);
            } catch {
                _strand(_dstEid, _requestId, address(_token), _amount, _beneficiary, "return send reverted");
            }
        } catch {
            _strand(_dstEid, _requestId, address(_token), _amount, _beneficiary, "return quote reverted");
        }
    }

    /// @dev The OFT that moves `_token` across chains: itself, or its adapter.
    function _oftFor(IERC20 _token) internal view returns (IOFT) {
        return address(_token) == address(baseToken) ? baseOft : quoteOft;
    }

    /// @dev Smallest amount of `_token` that can cross the bridge: one shared-decimal unit.
    function _bridgeQuantum(address _token) internal view returns (uint256) {
        uint8 localDecimals = IERC20Metadata(_token).decimals();
        uint8 shared = _oftFor(IERC20(_token)).sharedDecimals();
        return localDecimals > shared ? 10 ** (localDecimals - shared) : 1;
    }

    function _strand(
        uint32 _dstEid,
        uint64 _requestId,
        address _token,
        uint256 _amount,
        bytes32 _beneficiary,
        string memory _why
    ) internal {
        stranded[_dstEid][_requestId] += _amount;
        strandedToken[_dstEid][_requestId] = _token;
        if (_beneficiary != bytes32(0)) strandedBeneficiary[_dstEid][_requestId] = _beneficiary;
        emit FundsStranded(_dstEid, _requestId, _token, _amount, _why);

        // Tell the mirror chain, so the request reaches a terminal state instead of sitting
        // PENDING forever. Best-effort: the commonest reason to be here is having run out of
        // native gas, and failing to notify must not undo the strand record itself.
        _notifyStranded(_dstEid, _requestId, _amount);
    }

    /// @dev Sends a STRANDED settlement carrying no tokens. Never reverts.
    function _notifyStranded(uint32 _dstEid, uint64 _requestId, uint256 _amount) internal {
        bytes memory payload = SwapTypes.encodeSettlement(
            SwapTypes.Settlement({
                requestId: _requestId,
                status: uint8(SwapTypes.Status.STRANDED),
                reason: uint8(SwapTypes.FailureReason.POOL_ERROR),
                amountIn: _amount,
                amountOut: 0,
                lzNonce: 0
            })
        );
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(_returnGas(_dstEid), 0);

        try this.quoteStrandedNotice(_dstEid, payload, options) returns (uint256 fee) {
            if (address(this).balance >= fee) {
                _lzSend(_dstEid, payload, options, MessagingFee(fee, 0), address(this));
            }
        } catch {
            // No notice. The strand record on this chain is the durable part.
        }
    }

    /// @dev External only so the quote can be wrapped in try/catch from inside `_strand`.
    function quoteStrandedNotice(
        uint32 _dstEid,
        bytes calldata _payload,
        bytes calldata _options
    ) external view returns (uint256) {
        require(msg.sender == address(this), "SwapRelay: internal");
        return _quote(_dstEid, _payload, _options, false).nativeFee;
    }

    /**
     * @notice Pay a stranded amount to its owner, here on the home chain.
     *
     * @dev Permissionless: anyone may pay the gas to release someone else's funds, and the
     *      destination is fixed to the recorded beneficiary, so this cannot redirect anything.
     *
     *      Delivery is on the HOME chain because a stranded amount is, by definition, one that
     *      cannot cross the bridge — `retryReturn` will never succeed for it, however many
     *      times it is called. An EOA has the same address on every EVM chain, so for an EVM
     *      mirror this reaches the same person. A non-EVM beneficiary (a Solana pubkey) is not
     *      expressible as an `address` and reverts rather than paying the wrong account; that
     *      case needs an explicit recipient mapping, which is noted in agents.md §9.
     */
    function claimStranded(uint32 _srcEid, uint64 _requestId) external {
        uint256 amount = stranded[_srcEid][_requestId];
        if (amount == 0) revert NothingStranded(_srcEid, _requestId);

        bytes32 beneficiary = strandedBeneficiary[_srcEid][_requestId];
        if (uint256(beneficiary) >> 160 != 0 || beneficiary == bytes32(0)) {
            revert BeneficiaryNotAddressable(beneficiary);
        }
        address to = address(uint160(uint256(beneficiary)));
        address token = strandedToken[_srcEid][_requestId];

        stranded[_srcEid][_requestId] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit StrandedClaimed(_srcEid, _requestId, token, to, amount);
    }

    function _settlementFor(
        uint64 _requestId,
        bool _filled,
        SwapTypes.FailureReason _reason,
        uint256 _amountIn,
        uint256 _amountOut
    ) internal pure returns (bytes memory) {
        return
            SwapTypes.encodeSettlement(
                SwapTypes.Settlement({
                    requestId: _requestId,
                    status: uint8(_filled ? SwapTypes.Status.FILLED : SwapTypes.Status.REFUNDED),
                    reason: uint8(_reason),
                    amountIn: _amountIn,
                    amountOut: _amountOut,
                    lzNonce: 0
                })
            );
    }

    /**
     * @notice Retry a return that previously could not be dispatched.
     * @dev Permissionless: anyone may pay the gas to unstick a user's funds. The destination
     *      is fixed to the registered peer, so this cannot redirect anything.
     */
    function retryReturn(uint32 _dstEid, uint64 _requestId) external payable {
        uint256 amount = stranded[_dstEid][_requestId];
        require(amount > 0, "SwapRelay: nothing stranded");
        address token = strandedToken[_dstEid][_requestId];
        stranded[_dstEid][_requestId] = 0;

        _returnToMirror(
            _dstEid,
            _requestId,
            IERC20(token),
            amount,
            strandedBeneficiary[_dstEid][_requestId],
            _settlementFor(_requestId, false, SwapTypes.FailureReason.POOL_ERROR, amount, 0)
        );
    }

    // ------------------------------------------------------------------ plumbing

    /// @dev Orders arrive via lzCompose; no plain OApp messages are expected.
    function _lzReceive(Origin calldata, bytes32, bytes calldata, address, bytes calldata) internal override {}

    function setReturnGas(uint32 _eid, uint128 _gas) external onlyOwner {
        returnGas[_eid] = _gas;
    }

    function setReturnComposeGas(uint32 _eid, uint128 _gas) external onlyOwner {
        returnComposeGas[_eid] = _gas;
    }

    function _returnGas(uint32 _eid) internal view returns (uint128) {
        uint128 g = returnGas[_eid];
        return g == 0 ? DEFAULT_RETURN_GAS : g;
    }

    function _returnComposeGas(uint32 _eid) internal view returns (uint128) {
        uint128 g = returnComposeGas[_eid];
        return g == 0 ? DEFAULT_RETURN_COMPOSE_GAS : g;
    }

    /**
     * @dev The relay sends from inside `lzCompose`, where `msg.value` is whatever the executor
     *      forwarded rather than a figure this contract chose, so the default
     *      `msg.value == nativeFee` check can never hold. Paying from the contract's own
     *      balance is the standard pattern for composed sends.
     */
    function _payNative(uint256 _nativeFee) internal view override returns (uint256) {
        if (address(this).balance < _nativeFee) revert NotEnoughNative(address(this).balance);
        return _nativeFee;
    }

    /**
     * @notice Permanently kill an inbound message that will never arrive, and tell the mirror
     *         chain so the user can be made whole.
     *
     * @dev THE ORDERING IS THE SAFETY ARGUMENT. A source chain cannot simply refund a message
     *      that has not arrived: if it later lands, the amount exists twice. What makes a
     *      refund safe is proving first, here on the destination, that it can never execute —
     *      and only then authorising the restoration. Kill, then notify. Never the reverse.
     *
     *      LayerZero gives the OApp (or its delegate) exactly the tools for that half:
     *
     *        unverified  `skip` advances the lazy inbound nonce past it. Afterwards the nonce
     *                    is neither verifiable nor executable, because verification requires
     *                    either a nonce above the lazy one or an existing payload hash, and it
     *                    now has neither.
     *        verified    `skip` then `burn`. `skip` brings the lazy nonce up so `burn` is
     *                    permitted; `burn` deletes the payload hash outright. `nilify` alone
     *                    would NOT be enough — it only blocks execution *until re-verified*,
     *                    so a DVN attesting again would resurrect the message and with it the
     *                    double spend.
     *
     *      This relay must be the OFT's **delegate** for the calls to be authorised. That is a
     *      powerful role — a delegate can kill any inbound message on that OFT — so it is
     *      owner-gated here and belongs behind a timelock in production, together with a
     *      timeout policy that lets anyone trigger it rather than only the operator.
     *
     * @param _srcEid       The mirror chain the message came from.
     * @param _sender       That chain's OFT, as LayerZero addresses it.
     * @param _oft          The OFT on this chain whose inbound channel is stuck.
     * @param _nonce        Must be the oldest unexecuted nonce on that path.
     * @param _payloadHash  The verified payload hash, or zero if it was never verified.
     */
    function cancelStuckInbound(
        uint32 _srcEid,
        bytes32 _sender,
        address _oft,
        uint64 _nonce,
        bytes32 _payloadHash
    ) external onlyOwner {
        if (_oft != address(baseOft) && _oft != address(quoteOft)) revert UnexpectedComposeSource(_oft);

        ILayerZeroEndpointV2 ep = ILayerZeroEndpointV2(address(endpoint));

        // Advance the lazy nonce past it. For an unverified message this alone is terminal.
        ep.skip(_oft, _srcEid, _sender, _nonce);

        // For a verified one, delete the payload so it can never be re-verified either.
        if (_payloadHash != bytes32(0)) {
            ep.burn(_oft, _srcEid, _sender, _nonce, _payloadHash);
        }

        // Only now is it safe to authorise the restoration. The mirror chain holds the request
        // record and the amount, so the nonce is all that has to travel.
        bytes memory payload = SwapTypes.encodeSettlement(
            SwapTypes.Settlement({
                requestId: 0,
                status: uint8(SwapTypes.Status.CANCELLED),
                reason: uint8(SwapTypes.FailureReason.NONE),
                amountIn: 0,
                amountOut: 0,
                lzNonce: _nonce
            })
        );
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(_returnGas(_srcEid), 0);
        MessagingFee memory fee = _quote(_srcEid, payload, options, false);
        _lzSend(_srcEid, payload, options, fee, address(this));

        emit StuckMessageCancelled(_srcEid, _nonce, _oft, _payloadHash);
    }

    /// @notice Top up the native balance used to pay for return legs.
    function fundNative() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }

    function withdrawNative(address payable _to, uint256 _amount) external onlyOwner {
        (bool ok, ) = _to.call{ value: _amount }("");
        require(ok, "SwapRelay: withdraw failed");
    }

    /// @notice Sweep accumulated bridge dust. POC-only convenience.
    function sweepDust(address _token, address _to) external onlyOwner {
        uint256 amount = dustAccrued[_token];
        dustAccrued[_token] = 0;
        IERC20(_token).safeTransfer(_to, amount);
    }

    receive() external payable {
        emit NativeFunded(msg.sender, msg.value);
    }
}
