// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { OApp, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";
import { IOAppComposer } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppComposer.sol";
import { OFTComposeMsgCodec } from "@layerzerolabs/oft-evm/contracts/libs/OFTComposeMsgCodec.sol";
import { IOFT, SendParam, MessagingFee, OFTReceipt } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { SwapTypes } from "./SwapTypes.sol";

/**
 * @title SwapRequest
 * @notice MIRROR CHAIN ONLY. The user-facing entrypoint on a chain that has no market.
 *
 * @dev This is the near side of the core claim. There is no pool here, no market maker, no
 *      reserves and no price. This contract cannot quote the asset and never tries to — it
 *      only takes the user's input, sends it to the chain where the market actually is, and
 *      hands back whatever comes home.
 *
 *      Both directions work, and they are the same code path with the tokens swapped:
 *
 *        BUY   user pays the quote asset (USDC) -> receives the omnichain stock, here
 *        SELL  user pays the omnichain stock    -> receives the quote asset, here
 *
 *      In both cases the result is delivered to the user's wallet **on this chain**. The user
 *      never touches the home chain and signs exactly one transaction.
 *
 *      ON "LOCKING": the input is pulled from the user and then burned by the OFT as the
 *      bridge's debit leg — it is not sitting in a vault here. Custody in flight is the OFT's
 *      burn/mint invariant: supply is constant across the chain set and the tokens exist on
 *      the home chain for the duration. Stated plainly because it matters when reasoning about
 *      a stalled message.
 *
 *      IMPORTANT: the user holding the quote asset here is NOT local liquidity. It is their
 *      own wallet balance. Nobody on this chain quotes a price or takes the other side of the
 *      trade; all of that happens on the home chain's pool.
 */
contract SwapRequest is OApp, IOAppComposer {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;
    using OFTComposeMsgCodec for bytes;

    struct Request {
        address user; // who submitted it, and who the result goes to
        uint8 direction; // SwapTypes.Direction
        address tokenIn; // what they paid with, on this chain
        address tokenOut; // what they expect back, on this chain
        uint256 amountIn; // input actually bridged (post dust removal)
        uint256 minAmountOut;
        uint256 amountOut; // filled in on settlement
        uint64 createdAt;
        uint64 settledAt;
        SwapTypes.Status status;
        uint8 failureReason;
    }

    /// @notice The stock, as an ERC-20, on this chain.
    IERC20 public immutable baseToken;
    /// @notice The quote asset, as an ERC-20, on this chain. Liquid only on the home chain.
    IERC20 public immutable quoteToken;

    /**
     * @notice The OFT handle for each asset — the contract that moves it across chains.
     * @dev Equal to the token itself for a native {OmniToken}, and a separate
     *      {OmniTokenAdapter} where the asset already existed on this chain. Mirror chains
     *      normally hold native OmniTokens, but keeping the handles distinct means this
     *      contract also works on a chain where the asset predates the deployment.
     */
    IOFT public immutable baseOft;
    IOFT public immutable quoteOft;
    /// @notice LayerZero eid of the home chain, where the market lives.
    uint32 public immutable homeEid;

    uint64 public nextRequestId = 1;
    mapping(uint64 => Request) public requests;
    uint64[] public requestIds;

    /// @notice Gas for the OFT's `lzReceive` on the home chain.
    uint128 public homeLzReceiveGas = 250_000;
    /// @notice Gas for `SwapRelay.lzCompose` on the home chain — the swap plus the return send.
    uint128 public homeComposeGas = 1_200_000;
    /**
     * @notice Native value forwarded to SwapRelay with the compose call.
     * @dev This pre-pays the home -> mirror return leg, which is why the whole round trip costs
     *      the user one transaction on one chain. Denominated in the HOME chain's native token.
     */
    uint128 public homeComposeValue = 0.01 ether;

    event SwapRequested(
        uint64 indexed requestId,
        address indexed user,
        uint8 direction,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut
    );
    event SwapFilled(uint64 indexed requestId, address indexed user, address tokenOut, uint256 amountOut);
    event SwapRefunded(uint64 indexed requestId, address indexed user, address token, uint256 amount, uint8 reason);
    event DustReturned(uint64 indexed requestId, address indexed user, uint256 amount);
    /// @notice The result exists on the home chain but cannot be bridged back; claim it there.
    event SwapStranded(uint64 indexed requestId, address indexed user, uint256 amount);
    /// @notice Tokens arrived for an already-settled request and were paid to its owner anyway.
    event LateSettlementPaid(uint64 indexed requestId, address indexed user, address token, uint256 amount);

    error UnexpectedComposeSource(address from);
    error UnexpectedOrigin(uint32 srcEid, bytes32 sender);
    error InsufficientFee(uint256 required, uint256 supplied);
    error ZeroAmount();
    /// @dev The whole input was below the OFT's precision floor, so nothing could be bridged.
    error AmountBelowBridgeableMinimum(uint256 amountIn, uint256 quantum);
    error UnknownRequest(uint64 requestId);

    constructor(
        address _endpoint,
        address _owner,
        address _baseToken,
        address _baseOft,
        address _quoteToken,
        address _quoteOft,
        uint32 _homeEid
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        baseToken = IERC20(_baseToken);
        quoteToken = IERC20(_quoteToken);
        baseOft = IOFT(_baseOft);
        quoteOft = IOFT(_quoteOft);
        homeEid = _homeEid;
    }

    // ------------------------------------------------------------------ user entrypoint

    /**
     * @notice Buy the omnichain stock from this chain, paying with the quote asset.
     * @param _amountIn     Quote asset to spend. Caller must have approved this contract.
     * @param _minAmountOut Minimum stock to accept, enforced by the home chain's pool.
     *
     * @dev This is the flow the POC exists to prove: the caller is on a chain with no market
     *      for this asset at all, and receives it here anyway.
     */
    function buy(uint256 _amountIn, uint256 _minAmountOut) external payable returns (uint64) {
        return _submit(SwapTypes.Direction.BUY, _amountIn, _minAmountOut);
    }

    /// @notice Sell the omnichain stock from this chain, receiving the quote asset here.
    function sell(uint256 _amountIn, uint256 _minAmountOut) external payable returns (uint64) {
        return _submit(SwapTypes.Direction.SELL, _amountIn, _minAmountOut);
    }

    function _submit(
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut
    ) internal returns (uint64 requestId) {
        if (_amountIn == 0) revert ZeroAmount();

        bool isBuy = _direction == SwapTypes.Direction.BUY;
        IERC20 tokenIn = isBuy ? quoteToken : baseToken;
        IERC20 tokenOut = isBuy ? baseToken : quoteToken;

        requestId = nextRequestId++;
        requestIds.push(requestId);

        tokenIn.safeTransferFrom(msg.sender, address(this), _amountIn);

        SendParam memory sendParam = _buildSendParam(requestId, _direction, _amountIn, _minAmountOut, msg.sender);

        IOFT oft = _oftFor(tokenIn);

        // An adapter pulls with transferFrom rather than burning, so it needs an allowance.
        // A native OmniToken reports false and needs none.
        if (oft.approvalRequired()) {
            tokenIn.forceApprove(address(oft), _amountIn);
        }

        MessagingFee memory fee = oft.quoteSend(sendParam, false);
        if (msg.value < fee.nativeFee) revert InsufficientFee(fee.nativeFee, msg.value);

        (, OFTReceipt memory oftReceipt) = oft.send{ value: msg.value }(sendParam, fee, msg.sender);

        // The OFT quantises to shared decimals (6) before bridging, so anything finer never
        // leaves this chain. Hand it straight back rather than letting it accumulate here.
        uint256 sent = oftReceipt.amountSentLD;

        // An input entirely below the OFT's precision floor bridges as zero. The home chain
        // would then have nothing to swap and nothing to send back, leaving the request
        // PENDING forever — a zombie that can never settle. Found by the invariant fuzzer;
        // see NOTES.md. Reject it at the door instead.
        if (sent == 0) {
            revert AmountBelowBridgeableMinimum(_amountIn, _bridgeQuantum(tokenIn));
        }

        if (_amountIn > sent) {
            uint256 dust = _amountIn - sent;
            tokenIn.safeTransfer(msg.sender, dust);
            emit DustReturned(requestId, msg.sender, dust);
        }

        requests[requestId] = Request({
            user: msg.sender,
            direction: uint8(_direction),
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
            amountIn: sent,
            minAmountOut: _minAmountOut,
            amountOut: 0,
            createdAt: uint64(block.timestamp),
            settledAt: 0,
            status: SwapTypes.Status.PENDING,
            failureReason: uint8(SwapTypes.FailureReason.NONE)
        });

        emit SwapRequested(requestId, msg.sender, uint8(_direction), address(tokenIn), sent, _minAmountOut);
    }

    /// @notice Native fee required to submit a trade with these arguments.
    function quoteTrade(
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut
    ) external view returns (MessagingFee memory) {
        IERC20 tokenIn = _direction == SwapTypes.Direction.BUY ? quoteToken : baseToken;
        SendParam memory sendParam = _buildSendParam(
            nextRequestId,
            _direction,
            _amountIn,
            _minAmountOut,
            msg.sender
        );
        return _oftFor(tokenIn).quoteSend(sendParam, false);
    }

    function _buildSendParam(
        uint64 _requestId,
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipient
    ) internal view returns (SendParam memory) {
        // Widened to bytes32 on the wire so a non-EVM mirror can name its own account format.
        bytes memory composeMsg = SwapTypes.encodeOrder(
            SwapTypes.Order({
                requestId: _requestId,
                direction: uint8(_direction),
                minAmountOut: _minAmountOut,
                recipient: bytes32(uint256(uint160(_recipient)))
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

    /// @dev The OFT that moves `_token` across chains: itself, or its adapter.
    function _oftFor(IERC20 _token) internal view returns (IOFT) {
        return address(_token) == address(baseToken) ? baseOft : quoteOft;
    }

    /// @dev Smallest amount of `_token` that can cross the bridge: one shared-decimal unit.
    function _bridgeQuantum(IERC20 _token) internal view returns (uint256) {
        uint8 localDecimals = IERC20Metadata(address(_token)).decimals();
        uint8 sharedDecimals = _oftFor(_token).sharedDecimals();
        return localDecimals > sharedDecimals ? 10 ** (localDecimals - sharedDecimals) : 1;
    }

    // ------------------------------------------------------------------ inbound: the result

    /**
     * @notice Settlement from the home chain, arriving together with the tokens.
     * @dev One handler covers both outcomes: on a fill the output asset arrives, on a failure
     *      the input asset comes back. Either way, tokens landed and a request closes.
     */
    function lzCompose(
        address _from,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) external payable override {
        if (msg.sender != address(endpoint)) revert OnlyEndpoint(msg.sender);
        // The deliverer is the OFT, which is the adapter when the asset predates the deployment.
        if (_from != address(baseOft) && _from != address(quoteOft)) revert UnexpectedComposeSource(_from);
        IERC20 delivered = _from == address(baseOft) ? baseToken : quoteToken;

        uint32 srcEid = _message.srcEid();
        bytes32 composeFrom = _message.composeFrom();
        if (srcEid != homeEid || composeFrom != peers[homeEid]) revert UnexpectedOrigin(srcEid, composeFrom);

        uint256 amountReceived = _message.amountLD();
        SwapTypes.Settlement memory s = SwapTypes.decodeSettlement(_message.composeMsg());

        Request storage r = requests[s.requestId];

        // A settlement for a request that is no longer pending — a retry that raced a first
        // delivery, or one arriving after a stranded notice. Reverting would leave the compose
        // permanently failing, and simply returning would keep the tokens here with only an
        // owner sweep to release them. Pay the recorded user instead: whatever the sequencing,
        // these tokens are theirs. Only a genuinely unknown request falls through to sweep,
        // because then there is nobody to pay.
        if (r.status != SwapTypes.Status.PENDING) {
            if (r.user != address(0) && amountReceived > 0) {
                delivered.safeTransfer(r.user, amountReceived);
                emit LateSettlementPaid(s.requestId, r.user, address(delivered), amountReceived);
            }
            return;
        }

        r.settledAt = uint64(block.timestamp);

        if (s.status == uint8(SwapTypes.Status.FILLED)) {
            r.status = SwapTypes.Status.FILLED;
            r.amountOut = amountReceived;
            delivered.safeTransfer(r.user, amountReceived);
            emit SwapFilled(s.requestId, r.user, address(delivered), amountReceived);
        } else {
            r.status = SwapTypes.Status.REFUNDED;
            r.failureReason = s.reason;
            delivered.safeTransfer(r.user, amountReceived);
            emit SwapRefunded(s.requestId, r.user, address(delivered), amountReceived, s.reason);
        }
    }

    /**
     * @notice A settlement that carries no tokens — currently only STRANDED.
     *
     * @dev Results normally arrive with their tokens via `lzCompose`. A stranded amount is the
     *      exception: it cannot cross the bridge at all, so there is nothing to attach. The
     *      notice exists so the request reaches a terminal state and tells the user where the
     *      money actually is, instead of sitting PENDING indefinitely while funds sit claimable
     *      on the home chain and nobody knows.
     *
     *      OApp has already verified the sender is this chain's registered peer.
     */
    function _lzReceive(
        Origin calldata _origin,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) internal override {
        if (_origin.srcEid != homeEid) revert UnexpectedOrigin(_origin.srcEid, _origin.sender);

        SwapTypes.Settlement memory s = SwapTypes.decodeSettlement(_message);
        if (s.status != uint8(SwapTypes.Status.STRANDED)) return;

        Request storage r = requests[s.requestId];
        if (r.status != SwapTypes.Status.PENDING) return;

        r.status = SwapTypes.Status.STRANDED;
        r.failureReason = s.reason;
        r.settledAt = uint64(block.timestamp);
        emit SwapStranded(s.requestId, r.user, s.amountIn);
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
     * @dev POC-only safety valve. A production version needs a principled claim path instead.
     */
    function sweep(address _token, address _to, uint256 _amount) external onlyOwner {
        IERC20(_token).safeTransfer(_to, _amount);
    }

    receive() external payable {}
}
