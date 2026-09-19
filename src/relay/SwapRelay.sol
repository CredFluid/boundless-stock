// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
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

    /// @notice Sub-quantum remainders left behind by OFT dust removal on return sends.
    mapping(address token => uint256 amount) public dustAccrued;

    uint128 public constant DEFAULT_RETURN_GAS = 250_000;
    uint128 public constant DEFAULT_RETURN_COMPOSE_GAS = 300_000;

    event OrderReceived(uint32 indexed srcEid, uint64 indexed requestId, address tokenIn, uint256 amountIn);
    event OrderFilled(uint32 indexed srcEid, uint64 indexed requestId, uint256 amountIn, uint256 amountOut);
    event OrderFailed(uint32 indexed srcEid, uint64 indexed requestId, uint8 reason, uint256 amountIn);
    event ReturnDispatched(uint32 indexed srcEid, uint64 indexed requestId, address token, uint256 amount);
    event FundsStranded(uint32 indexed srcEid, uint64 indexed requestId, address token, uint256 amount, string why);
    event NativeFunded(address indexed from, uint256 amount);

    error UnexpectedComposeSource(address from);

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
            _strand(_dstEid, _requestId, address(_token), _amount, "amount below the bridgeable minimum");
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
                _strand(_dstEid, _requestId, address(_token), _amount, "insufficient native for return");
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
                _strand(_dstEid, _requestId, address(_token), _amount, "return send reverted");
            }
        } catch {
            _strand(_dstEid, _requestId, address(_token), _amount, "return quote reverted");
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

    function _strand(uint32 _dstEid, uint64 _requestId, address _token, uint256 _amount, string memory _why) internal {
        stranded[_dstEid][_requestId] += _amount;
        strandedToken[_dstEid][_requestId] = _token;
        emit FundsStranded(_dstEid, _requestId, _token, _amount, _why);
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
                    amountOut: _amountOut
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
