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
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

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
 *
 *      PARTNERS AND FEES. Orders can come through a registered partner — a wallet, exchange or
 *      app that owns the customer relationship and its KYC. The partner's backend signs an
 *      EIP-712 authorisation for one specific order, and the user submits it with `buyVia` /
 *      `sellVia`. With `partnerRequired` set, that is the only way in, which is what makes
 *      "partners handle KYC" hold on chain rather than as a policy. A partner fee (authorised
 *      per order, capped per partner) and a platform fee are taken from the input and held in
 *      escrow here: paid out only if the order fills, returned to the user otherwise. All of
 *      this is local to the mirror chain — the order that crosses the wire is unchanged, so
 *      the home chain, the relayer and existing deployments are unaffected.
 */
/// @dev The narrow slice of {OmniToken} this contract needs in order to restore a cancelled input.
interface IOmniRecovery {
    function recoveryCredit(address to, uint256 amount) external;
}

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
        /**
         * LayerZero nonce of the outbound message carrying this request.
         *
         * Recorded because it is the *only* handle by which a message that never arrived can
         * later be identified and killed on the destination. Without it a stuck request is not
         * merely unrecovered, it is unrecoverable — there is nothing to point at. Cheap to
         * store and impossible to reconstruct afterwards.
         */
        uint64 lzNonce;
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
    /**
     * @notice Outbound LayerZero nonce -> request id.
     * @dev A cancellation arrives knowing only the nonce: the home chain killed a message whose
     *      payload it never saw, so it cannot name the request. This mapping is what lets the
     *      mirror resolve it, and is why the mirror — not the message — is the source of truth
     *      for the amount being restored.
     */
    /// @dev Keyed by the OFT that sent the message as well as its nonce: nonces are per path,
    ///      so a buy (quote OFT) and a sell (stock OFT) routinely share one.
    mapping(address oft => mapping(uint64 lzNonce => uint64 requestId)) public requestIdByNonce;

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

    // ------------------------------------------------------------------ partners and fees

    uint256 internal constant BPS = 10_000;
    /// @notice Hard ceiling on any partner's fee, whatever the owner registers.
    uint16 public constant MAX_PARTNER_FEE_BPS = 300;
    /// @notice Hard ceiling on the platform fee.
    uint16 public constant MAX_PLATFORM_FEE_BPS = 100;

    // EIP-712, written out rather than inherited: OpenZeppelin's EIP712 and SignatureChecker
    // need solc 0.8.24, and this repo compiles every contract with 0.8.22.
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant EIP712_NAME_HASH = keccak256("CrossStock SwapRequest");
    bytes32 internal constant EIP712_VERSION_HASH = keccak256("1");

    bytes32 public constant PARTNER_ORDER_TYPEHASH = keccak256(
        "PartnerOrder(address user,uint8 direction,uint256 amountIn,uint256 minAmountOut,uint32 partnerId,uint16 feeBps,uint256 nonce,uint256 deadline)"
    );

    struct Partner {
        address signer; // signs order authorisations; an EOA or an ERC-1271 contract
        address feeRecipient; // where this partner's fees accrue
        uint16 maxFeeBps; // the most this partner may charge on one order
        bool active;
    }

    /// @notice A partner's signed approval of one order, passed by the user who submits it.
    struct PartnerAuth {
        uint32 partnerId;
        uint16 feeBps; // the partner's fee on this order, in basis points of the input
        uint256 nonce; // single use, per partner
        uint256 deadline; // unix seconds
        bytes signature;
    }

    enum FeeState {
        NONE, // no fee on this request
        ESCROWED, // held here until the request settles
        PAID, // the request filled; fees accrued to their recipients
        RETURNED // the request did not fill; fees went back to the user
    }

    struct FeeEscrow {
        uint32 partnerId;
        FeeState state;
        address partnerRecipient; // snapshotted at submission: the terms the user agreed to
        address platformRecipient;
        uint128 partnerFee; // in the input token, local decimals
        uint128 platformFee;
    }

    /// @notice When set, orders are accepted only with a partner's authorisation.
    bool public partnerRequired;
    mapping(uint32 partnerId => Partner) public partners;
    mapping(uint32 partnerId => mapping(uint256 nonce => bool)) public nonceUsed;

    uint16 public platformFeeBps;
    address public platformFeeRecipient;

    mapping(uint64 requestId => FeeEscrow) internal _fees;
    /// @notice Fees earned (or returned but undeliverable) and waiting to be claimed.
    mapping(address token => mapping(address account => uint256)) public feesClaimable;
    /// @notice Fee tokens held here that belong to someone: escrowed plus claimable. Never swept.
    mapping(address token => uint256) public feesReserved;

    event SwapRequested(
        uint64 indexed requestId,
        address indexed user,
        uint8 direction,
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut
    );
    event SwapFilled(uint64 indexed requestId, address indexed user, address tokenOut, uint256 amountOut);
    event SwapRefunded(
        uint64 indexed requestId, address indexed user, address token, uint256 amount, uint8 reason
    );
    event DustReturned(uint64 indexed requestId, address indexed user, uint256 amount);
    /// @notice The result exists on the home chain but cannot be bridged back; claim it there.
    event SwapStranded(uint64 indexed requestId, address indexed user, uint256 amount);
    /// @notice The outbound message was killed on the destination and the input restored here.
    event SwapCancelled(
        uint64 indexed requestId, address indexed user, address token, uint256 amount, uint64 lzNonce
    );
    /// @notice Tokens arrived for an already-settled request and were paid to its owner anyway.
    event LateSettlementPaid(uint64 indexed requestId, address indexed user, address token, uint256 amount);

    event PartnerSet(
        uint32 indexed partnerId, address signer, address feeRecipient, uint16 maxFeeBps, bool active
    );
    event PartnerRequiredSet(bool required);
    event PlatformFeeSet(uint16 bps, address recipient);
    event NonceInvalidated(uint32 indexed partnerId, uint256 nonce);
    event FeesEscrowed(
        uint64 indexed requestId, uint32 indexed partnerId, uint256 partnerFee, uint256 platformFee
    );
    event FeesPaid(
        uint64 indexed requestId, uint32 indexed partnerId, uint256 partnerFee, uint256 platformFee
    );
    event FeesReturned(uint64 indexed requestId, address indexed user, uint256 amount);
    event FeesClaimed(address indexed token, address indexed account, address to, uint256 amount);

    error UnexpectedComposeSource(address from);
    error UnexpectedOrigin(uint32 srcEid, bytes32 sender);
    error InsufficientFee(uint256 required, uint256 supplied);
    error ZeroAmount();
    /// @dev The whole input was below the OFT's precision floor, so nothing could be bridged.
    error AmountBelowBridgeableMinimum(uint256 amountIn, uint256 quantum);
    error UnknownRequest(uint64 requestId);
    error PartnerRequired();
    error UnknownPartner(uint32 partnerId);
    error AuthorizationExpired(uint256 deadline);
    error FeeTooHigh(uint256 feeBps, uint256 maxBps);
    error NonceAlreadyUsed(uint32 partnerId, uint256 nonce);
    error InvalidPartnerSignature(uint32 partnerId);
    error InvalidPartner();
    error NotPartnerSigner();
    error WouldSweepFees(uint256 available);

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
     *      for this asset at all, and receives it here anyway. Closed while `partnerRequired`.
     */
    function buy(uint256 _amountIn, uint256 _minAmountOut) external payable returns (uint64) {
        if (partnerRequired) revert PartnerRequired();
        return _submit(SwapTypes.Direction.BUY, _amountIn, _minAmountOut, 0, 0, address(0));
    }

    /// @notice Sell the omnichain stock from this chain, receiving the quote asset here.
    function sell(uint256 _amountIn, uint256 _minAmountOut) external payable returns (uint64) {
        if (partnerRequired) revert PartnerRequired();
        return _submit(SwapTypes.Direction.SELL, _amountIn, _minAmountOut, 0, 0, address(0));
    }

    /// @notice Buy through a partner, with its signed authorisation of exactly this order.
    function buyVia(uint256 _amountIn, uint256 _minAmountOut, PartnerAuth calldata _auth)
        external
        payable
        returns (uint64)
    {
        address recipient = _authorize(SwapTypes.Direction.BUY, _amountIn, _minAmountOut, _auth);
        return
            _submit(
                SwapTypes.Direction.BUY, _amountIn, _minAmountOut, _auth.partnerId, _auth.feeBps, recipient
            );
    }

    /// @notice Sell through a partner, with its signed authorisation of exactly this order.
    function sellVia(uint256 _amountIn, uint256 _minAmountOut, PartnerAuth calldata _auth)
        external
        payable
        returns (uint64)
    {
        address recipient = _authorize(SwapTypes.Direction.SELL, _amountIn, _minAmountOut, _auth);
        return
            _submit(
                SwapTypes.Direction.SELL, _amountIn, _minAmountOut, _auth.partnerId, _auth.feeBps, recipient
            );
    }

    /**
     * @dev Checks a partner authorisation and consumes its nonce.
     *
     *      The signature binds the order to the account submitting it (`msg.sender`): an
     *      authorisation issued for one verified user cannot be used by anyone else, and cannot
     *      be replayed, reused for a different amount or direction, or used after its deadline.
     *      The domain separator binds it to this contract on this chain.
     * @return The partner's fee recipient, snapshotted into the request's escrow.
     */
    function _authorize(
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut,
        PartnerAuth calldata _auth
    ) internal returns (address) {
        Partner memory p = partners[_auth.partnerId];
        if (!p.active) revert UnknownPartner(_auth.partnerId);
        if (block.timestamp > _auth.deadline) revert AuthorizationExpired(_auth.deadline);
        if (_auth.feeBps > p.maxFeeBps) revert FeeTooHigh(_auth.feeBps, p.maxFeeBps);
        if (nonceUsed[_auth.partnerId][_auth.nonce]) revert NonceAlreadyUsed(_auth.partnerId, _auth.nonce);

        bytes32 digest = hashPartnerOrder(
            msg.sender,
            _direction,
            _amountIn,
            _minAmountOut,
            _auth.partnerId,
            _auth.feeBps,
            _auth.nonce,
            _auth.deadline
        );
        if (!_validSignature(p.signer, digest, _auth.signature)) {
            revert InvalidPartnerSignature(_auth.partnerId);
        }
        nonceUsed[_auth.partnerId][_auth.nonce] = true;
        return p.feeRecipient;
    }

    /// @dev An EOA's ECDSA signature, or ERC-1271 approval from a contract signer (a multisig or
    ///      smart account), mirroring OpenZeppelin's SignatureChecker.
    function _validSignature(address _signer, bytes32 _digest, bytes calldata _sig)
        internal
        view
        returns (bool)
    {
        if (_signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(_digest, _sig);
            return err == ECDSA.RecoverError.NoError && recovered == _signer;
        }
        (bool ok, bytes memory ret) =
            _signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (_digest, _sig)));
        return
            ok && ret.length >= 32
                && abi.decode(ret, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    /// @notice EIP-712 domain separator: this contract, on this chain.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this)
            )
        );
    }

    /// @notice The EIP-712 digest a partner signs to authorise an order.
    function hashPartnerOrder(
        address _user,
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut,
        uint32 _partnerId,
        uint16 _feeBps,
        uint256 _nonce,
        uint256 _deadline
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                PARTNER_ORDER_TYPEHASH,
                _user,
                uint8(_direction),
                _amountIn,
                _minAmountOut,
                _partnerId,
                _feeBps,
                _nonce,
                _deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _submit(
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut,
        uint32 _partnerId,
        uint16 _partnerFeeBps,
        address _partnerRecipient
    ) internal returns (uint64 requestId) {
        if (_amountIn == 0) revert ZeroAmount();

        IERC20 tokenIn = _direction == SwapTypes.Direction.BUY ? quoteToken : baseToken;

        requestId = nextRequestId++;
        requestIds.push(requestId);

        tokenIn.safeTransferFrom(msg.sender, address(this), _amountIn);

        // Fees come off the input and stay here in escrow; only the remainder crosses.
        uint256 net =
            _escrowFees(requestId, tokenIn, _amountIn, _partnerId, _partnerFeeBps, _partnerRecipient);
        if (net == 0) revert ZeroAmount();

        // Dispatched in its own frame: the send needs several locals that are dead afterwards,
        // and keeping them alive here puts this function over the stack limit.
        (uint256 sent, uint64 lzNonce) = _dispatch(requestId, _direction, tokenIn, net, _minAmountOut);

        // An input entirely below the OFT's precision floor bridges as zero. The home chain
        // would then have nothing to swap and nothing to send back, leaving the request
        // PENDING forever — a zombie that can never settle. Found by the invariant fuzzer;
        // see NOTES.md. Reject it at the door instead.
        if (sent == 0) {
            revert AmountBelowBridgeableMinimum(net, _bridgeQuantum(tokenIn));
        }

        if (net > sent) {
            uint256 dust = net - sent;
            tokenIn.safeTransfer(msg.sender, dust);
            emit DustReturned(requestId, msg.sender, dust);
        }

        _record(requestId, _direction, tokenIn, sent, _minAmountOut, lzNonce);
    }

    function _record(
        uint64 _requestId,
        SwapTypes.Direction _direction,
        IERC20 _tokenIn,
        uint256 _sent,
        uint256 _minAmountOut,
        uint64 _lzNonce
    ) internal {
        requests[_requestId] = Request({
            user: msg.sender,
            direction: uint8(_direction),
            tokenIn: address(_tokenIn),
            tokenOut: address(_direction == SwapTypes.Direction.BUY ? baseToken : quoteToken),
            amountIn: _sent,
            minAmountOut: _minAmountOut,
            amountOut: 0,
            createdAt: uint64(block.timestamp),
            settledAt: 0,
            status: SwapTypes.Status.PENDING,
            failureReason: uint8(SwapTypes.FailureReason.NONE),
            lzNonce: _lzNonce
        });
        requestIdByNonce[address(_oftFor(_tokenIn))][_lzNonce] = _requestId;

        emit SwapRequested(_requestId, msg.sender, uint8(_direction), address(_tokenIn), _sent, _minAmountOut);
    }

    /**
     * @dev Takes the partner and platform fees off `_gross` and holds them in escrow.
     * @return net What is left to trade.
     */
    function _escrowFees(
        uint64 _requestId,
        IERC20 _tokenIn,
        uint256 _gross,
        uint32 _partnerId,
        uint16 _partnerFeeBps,
        address _partnerRecipient
    ) internal returns (uint256 net) {
        uint256 partnerFee = (_gross * _partnerFeeBps) / BPS;
        uint256 platformFee = (_gross * platformFeeBps) / BPS;
        uint256 total = partnerFee + platformFee;
        if (total == 0) return _gross;

        _fees[_requestId] = FeeEscrow({
            partnerId: _partnerId,
            state: FeeState.ESCROWED,
            partnerRecipient: _partnerRecipient,
            platformRecipient: platformFeeRecipient,
            partnerFee: uint128(partnerFee),
            platformFee: uint128(platformFee)
        });
        feesReserved[address(_tokenIn)] += total;
        emit FeesEscrowed(_requestId, _partnerId, partnerFee, platformFee);
        return _gross - total;
    }

    /**
     * @dev Settles a request's escrowed fees: to their recipients if it filled, back to the
     *      user if it did not (refunded, cancelled or stranded).
     *
     *      Earned fees accrue for `claimFees` rather than being pushed, so a recipient that
     *      cannot receive the token can never block a user's settlement. A returned fee is
     *      pushed to the user with the rest of their refund; if that transfer fails it is
     *      credited to them as claimable instead of reverting the settlement.
     */
    function _releaseFees(uint64 _requestId, bool _earned) internal {
        FeeEscrow storage f = _fees[_requestId];
        if (f.state != FeeState.ESCROWED) return;
        Request storage r = requests[_requestId];
        address token = r.tokenIn;

        if (_earned) {
            f.state = FeeState.PAID;
            if (f.partnerFee > 0) feesClaimable[token][f.partnerRecipient] += f.partnerFee;
            if (f.platformFee > 0) feesClaimable[token][f.platformRecipient] += f.platformFee;
            emit FeesPaid(_requestId, f.partnerId, f.partnerFee, f.platformFee);
            return;
        }

        f.state = FeeState.RETURNED;
        uint256 total = uint256(f.partnerFee) + f.platformFee;
        if (IERC20(token).trySafeTransfer(r.user, total)) {
            feesReserved[token] -= total;
        } else {
            feesClaimable[token][r.user] += total; // stays reserved until claimed
        }
        emit FeesReturned(_requestId, r.user, total);
    }

    /// @notice Withdraw fees credited to the caller, in `_token`, to `_to`.
    function claimFees(address _token, address _to) external returns (uint256 amount) {
        amount = feesClaimable[_token][msg.sender];
        if (amount == 0) return 0;
        feesClaimable[_token][msg.sender] = 0;
        feesReserved[_token] -= amount;
        IERC20(_token).safeTransfer(_to, amount);
        emit FeesClaimed(_token, msg.sender, _to, amount);
    }

    /// @notice What an order of `_amountIn` pays in fees, and what is left to trade.
    function quoteFees(uint256 _amountIn, uint16 _partnerFeeBps)
        external
        view
        returns (uint256 partnerFee, uint256 platformFee, uint256 net)
    {
        partnerFee = (_amountIn * _partnerFeeBps) / BPS;
        platformFee = (_amountIn * platformFeeBps) / BPS;
        net = _amountIn - partnerFee - platformFee;
    }

    function getFees(uint64 _requestId) external view returns (FeeEscrow memory) {
        return _fees[_requestId];
    }

    /**
     * @dev Builds and sends the outbound OFT message.
     * @return sent    Amount that actually crossed, after the OFT's precision floor.
     * @return lzNonce LayerZero nonce of the message — the handle by which it can later be
     *                 identified and, if it never arrives, killed on the destination.
     */
    function _dispatch(
        uint64 _requestId,
        SwapTypes.Direction _direction,
        IERC20 _tokenIn,
        uint256 _amountIn,
        uint256 _minAmountOut
    ) internal returns (uint256 sent, uint64 lzNonce) {
        SendParam memory sendParam =
            _buildSendParam(_requestId, _direction, _amountIn, _minAmountOut, msg.sender);
        IOFT oft = _oftFor(_tokenIn);

        // An adapter pulls with transferFrom rather than burning, so it needs an allowance.
        // A native OmniToken reports false and needs none.
        if (oft.approvalRequired()) {
            _tokenIn.forceApprove(address(oft), _amountIn);
        }

        MessagingFee memory fee = oft.quoteSend(sendParam, false);
        if (msg.value < fee.nativeFee) revert InsufficientFee(fee.nativeFee, msg.value);

        (MessagingReceipt memory msgReceipt, OFTReceipt memory oftReceipt) =
            oft.send{ value: msg.value }(sendParam, fee, msg.sender);
        return (oftReceipt.amountSentLD, msgReceipt.nonce);
    }

    /// @notice Native fee required to submit a trade with these arguments.
    function quoteTrade(SwapTypes.Direction _direction, uint256 _amountIn, uint256 _minAmountOut)
        external
        view
        returns (MessagingFee memory)
    {
        IERC20 tokenIn = _direction == SwapTypes.Direction.BUY ? quoteToken : baseToken;
        SendParam memory sendParam =
            _buildSendParam(nextRequestId, _direction, _amountIn, _minAmountOut, msg.sender);
        return _oftFor(tokenIn).quoteSend(sendParam, false);
    }

    function _buildSendParam(
        uint64 _requestId,
        SwapTypes.Direction _direction,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipient
    ) internal view returns (SendParam memory) {
        // The floor crosses in shared decimals, rounded UP: rounding down would let the home
        // chain accept up to one quantum less than the user asked for. See SwapTypes.
        IERC20 tokenOut = _direction == SwapTypes.Direction.BUY ? baseToken : quoteToken;
        uint256 quantum = _bridgeQuantum(tokenOut);
        uint256 minOutSD = _minAmountOut / quantum + (_minAmountOut % quantum == 0 ? 0 : 1);

        // Widened to bytes32 on the wire so a non-EVM mirror can name its own account format.
        bytes memory composeMsg = SwapTypes.encodeOrder(
            SwapTypes.Order({
                requestId: _requestId,
                direction: uint8(_direction),
                minAmountOut: minOutSD,
                recipient: bytes32(uint256(uint160(_recipient)))
            })
        );

        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(homeLzReceiveGas, 0)
            .addExecutorLzComposeOption(0, homeComposeGas, homeComposeValue);

        return SendParam({
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
    function lzCompose(address _from, bytes32, bytes calldata _message, address, bytes calldata)
        external
        payable
        override
    {
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
            _releaseFees(s.requestId, true);
        } else {
            r.status = SwapTypes.Status.REFUNDED;
            r.failureReason = s.reason;
            delivered.safeTransfer(r.user, amountReceived);
            emit SwapRefunded(s.requestId, r.user, address(delivered), amountReceived, s.reason);
            _releaseFees(s.requestId, false);
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
    function _lzReceive(Origin calldata _origin, bytes32, bytes calldata _message, address, bytes calldata)
        internal
        override
    {
        if (_origin.srcEid != homeEid) revert UnexpectedOrigin(_origin.srcEid, _origin.sender);

        SwapTypes.Settlement memory s = SwapTypes.decodeSettlement(_message);

        if (s.status == uint8(SwapTypes.Status.CANCELLED)) {
            _applyCancellation(s.lzNonce, s.cancelledPath);
            return;
        }
        if (s.status != uint8(SwapTypes.Status.STRANDED)) return;

        Request storage r = requests[s.requestId];
        if (r.status != SwapTypes.Status.PENDING) return;

        r.status = SwapTypes.Status.STRANDED;
        r.failureReason = s.reason;
        r.settledAt = uint64(block.timestamp);
        emit SwapStranded(s.requestId, r.user, s.amountIn);
        // A strand may follow a fill whose return leg failed; the mirror cannot tell, so the
        // user is not charged for an order they did not receive here.
        _releaseFees(s.requestId, false);
    }

    /**
     * @notice Restore the input for a message the home chain has permanently killed.
     *
     * @dev Reached only through `_lzReceive`, so the authority is LayerZero's peer check: this
     *      instruction came from the registered SwapRelay and nowhere else. That relay sends it
     *      only *after* proving on its own chain that the original message can never execute,
     *      which is what makes re-creating the amount safe rather than a double spend.
     *
     *      The amount comes from this contract's own record, never from the message. The home
     *      chain never saw the payload — it killed a nonce, not a request — so it cannot state
     *      an amount, and accepting one from the wire would be accepting an unverifiable claim.
     */
    function _applyCancellation(uint64 _lzNonce, bytes32 _path) internal {
        // The path is this chain's OFT that sent the killed message. Anything not addressable
        // as an EVM address cannot be one of ours, so it matches nothing.
        if (uint256(_path) >> 160 != 0) return;
        uint64 requestId = requestIdByNonce[address(uint160(uint256(_path)))][_lzNonce];
        if (requestId == 0) return; // nothing here matches that path and nonce

        Request storage r = requests[requestId];
        if (r.status != SwapTypes.Status.PENDING) return; // already settled; nothing owed

        r.status = SwapTypes.Status.CANCELLED;
        r.settledAt = uint64(block.timestamp);

        // The tokens were burned to leave this chain and now exist nowhere, so making the user
        // whole means re-creating them. Counted as an arrival rather than as new supply — see
        // OmniToken.recoveryCredit.
        IOmniRecovery(address(_oftFor(IERC20(r.tokenIn)))).recoveryCredit(r.user, r.amountIn);
        emit SwapCancelled(requestId, r.user, r.tokenIn, r.amountIn, _lzNonce);
        _releaseFees(requestId, false);
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

    function setGasParams(uint128 _lzReceiveGas, uint128 _composeGas, uint128 _composeValue)
        external
        onlyOwner
    {
        homeLzReceiveGas = _lzReceiveGas;
        homeComposeGas = _composeGas;
        homeComposeValue = _composeValue;
    }

    /**
     * @notice Register, update or deactivate a partner.
     * @dev Deactivating stops new orders at once; fees already escrowed or earned are unaffected.
     */
    function setPartner(
        uint32 _partnerId,
        address _signer,
        address _feeRecipient,
        uint16 _maxFeeBps,
        bool _active
    ) external onlyOwner {
        if (_partnerId == 0 || _signer == address(0) || _feeRecipient == address(0)) {
            revert InvalidPartner();
        }
        if (_maxFeeBps > MAX_PARTNER_FEE_BPS) revert FeeTooHigh(_maxFeeBps, MAX_PARTNER_FEE_BPS);
        partners[_partnerId] = Partner(_signer, _feeRecipient, _maxFeeBps, _active);
        emit PartnerSet(_partnerId, _signer, _feeRecipient, _maxFeeBps, _active);
    }

    /// @notice Close (or reopen) the plain `buy` / `sell` entrypoints to orders without a partner.
    function setPartnerRequired(bool _required) external onlyOwner {
        partnerRequired = _required;
        emit PartnerRequiredSet(_required);
    }

    function setPlatformFee(uint16 _bps, address _recipient) external onlyOwner {
        if (_bps > MAX_PLATFORM_FEE_BPS) revert FeeTooHigh(_bps, MAX_PLATFORM_FEE_BPS);
        if (_bps > 0 && _recipient == address(0)) revert InvalidPartner();
        platformFeeBps = _bps;
        platformFeeRecipient = _recipient;
        emit PlatformFeeSet(_bps, _recipient);
    }

    /// @notice Withdraw an authorisation before it is used. Callable by the partner's signer.
    function invalidateNonce(uint32 _partnerId, uint256 _nonce) external {
        if (msg.sender != partners[_partnerId].signer && msg.sender != owner()) revert NotPartnerSigner();
        nonceUsed[_partnerId][_nonce] = true;
        emit NonceInvalidated(_partnerId, _nonce);
    }

    /**
     * @notice Owner rescue for tokens that arrived without a matching open request.
     * @dev POC-only safety valve. A production version needs a principled claim path instead.
     *      It can never reach fees held for users, partners or the platform.
     */
    function sweep(address _token, address _to, uint256 _amount) external onlyOwner {
        uint256 available = IERC20(_token).balanceOf(address(this)) - feesReserved[_token];
        if (_amount > available) revert WouldSweepFees(available);
        IERC20(_token).safeTransfer(_to, _amount);
    }

    receive() external payable { }
}
