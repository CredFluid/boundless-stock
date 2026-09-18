// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IMessageLib, MessageLibType } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLib.sol";
import { ISendLib, Packet } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ISendLib.sol";
import {
    ILayerZeroEndpointV2,
    MessagingFee,
    Origin
} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { SetConfigParam } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/IMessageLibManager.sol";
import { PacketV1Codec } from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import { ExecutorOptions } from "@layerzerolabs/lz-evm-messagelib-v2/contracts/libs/ExecutorOptions.sol";

/**
 * @title LocalMessageLib
 * @notice A send+receive MessageLib for the **local three-chain development environment only**.
 *
 * @dev WHY THIS EXISTS
 *      On live testnets, LayerZero's own SendUln302 / ReceiveUln302 libraries, DVNs and
 *      Executor are already deployed and configured — this contract is never used there.
 *      Locally, three independent `anvil` chains each get a real `EndpointV2`, but there is
 *      no DVN network to verify packets between them, so a library is needed that:
 *
 *        1. encodes an outbound `Packet` in the real PacketV1 wire format, and
 *        2. exposes `validatePacket()` so an off-chain relayer can drive the same
 *           `verify()` -> `lzReceive()` sequence that a DVN + Executor drive in production.
 *
 *      Everything above this library — the endpoint, the OApp/OFT contracts, the packet
 *      encoding, nonce ordering, payload hashing — is the real LayerZero machinery.
 *
 *      FEES: quoting is options-aware on purpose. It charges a flat base fee plus every unit
 *      of native value the options actually request (lzReceive value, lzCompose value, native
 *      drop). That matters because the home-chain SwapRelay pays for its return-leg message
 *      out of the value forwarded with the inbound compose — so this local library exercises
 *      the same value-flow path production uses, instead of hiding it behind a free mock.
 *
 *      NOT FOR PRODUCTION: there is no verification of any kind. Any address may call
 *      `validatePacket()`. That is acceptable for a local harness and catastrophic anywhere else.
 */
contract LocalMessageLib is ISendLib, ERC165, Ownable {
    using PacketV1Codec for Packet;
    using PacketV1Codec for bytes;

    /// @notice The EndpointV2 this library is bound to.
    address public immutable endpoint;
    /// @notice The LayerZero endpoint id of the chain this library lives on.
    uint32 public immutable localEid;

    /// @notice Flat native fee charged per message, on top of any value the options request.
    uint256 public baseNativeFee;
    /// @notice Flat lzToken fee. Unused locally (payInLzToken is not exercised).
    uint256 public baseLzTokenFee;

    error OnlyEndpoint();

    event PacketValidated(uint32 indexed srcEid, bytes32 indexed sender, address indexed receiver, uint64 nonce);

    constructor(address _endpoint, address _owner, uint256 _baseNativeFee) Ownable(_owner) {
        endpoint = _endpoint;
        localEid = ILayerZeroEndpointV2(_endpoint).eid();
        baseNativeFee = _baseNativeFee;
    }

    // --------------------------------------------------------------------- send side

    /// @inheritdoc ISendLib
    function send(
        Packet calldata _packet,
        bytes calldata _options,
        bool _payInLzToken
    ) external returns (MessagingFee memory fee, bytes memory encodedPacket) {
        if (msg.sender != endpoint) revert OnlyEndpoint();
        encodedPacket = PacketV1Codec.encode(_packet);
        fee = _quote(_options, _payInLzToken);
    }

    /// @inheritdoc ISendLib
    function quote(
        Packet calldata,
        bytes calldata _options,
        bool _payInLzToken
    ) external view returns (MessagingFee memory) {
        return _quote(_options, _payInLzToken);
    }

    /**
     * @dev Base fee plus every unit of native value the executor options ask to be delivered
     *      on the destination chain. Options that are empty or not type-3 fall back to the
     *      base fee alone.
     */
    function _quote(bytes calldata _options, bool _payInLzToken) internal view returns (MessagingFee memory) {
        uint256 nativeFee = baseNativeFee + _requestedNativeValue(_options);
        return MessagingFee({ nativeFee: nativeFee, lzTokenFee: _payInLzToken ? baseLzTokenFee : 0 });
    }

    /**
     * @notice Sums the native value requested by executor options (lzReceive value,
     *         lzCompose value, native drop amount).
     * @dev Mirrors how a real Executor prices the value it must front on the destination
     *      chain. Returns 0 for malformed or non-type-3 options rather than reverting, so a
     *      quote never fails for a reason the caller cannot act on.
     */
    function _requestedNativeValue(bytes calldata _options) public pure returns (uint256 total) {
        if (_options.length < 2) return 0;
        if (uint16(bytes2(_options[0:2])) != 3) return 0; // only TYPE_3 options carry worker options

        uint256 cursor = 2;
        while (cursor < _options.length) {
            // Bounds-guard: a truncated trailing option must not read past the end.
            if (cursor + 3 > _options.length) break;

            (uint8 optionType, bytes calldata option, uint256 next) = ExecutorOptions.nextExecutorOption(
                _options,
                cursor
            );
            cursor = next;

            if (optionType == ExecutorOptions.OPTION_TYPE_LZRECEIVE) {
                (, uint128 value) = ExecutorOptions.decodeLzReceiveOption(option);
                total += value;
            } else if (optionType == ExecutorOptions.OPTION_TYPE_LZCOMPOSE) {
                (, , uint128 value) = ExecutorOptions.decodeLzComposeOption(option);
                total += value;
            } else if (optionType == ExecutorOptions.OPTION_TYPE_NATIVE_DROP) {
                (uint128 amount, ) = ExecutorOptions.decodeNativeDropOption(option);
                total += amount;
            }
        }
    }

    // --------------------------------------------------------------------- receive side

    /**
     * @notice Stands in for DVN verification: marks a packet as verified on the destination
     *         endpoint so it becomes executable.
     * @dev Permissionless by design — this is a local harness. The off-chain relayer calls
     *      this, then calls `endpoint.lzReceive(...)`, which is exactly the two-step sequence
     *      a DVN and an Executor perform in production.
     */
    function validatePacket(bytes calldata _packetBytes) external {
        Origin memory origin = Origin({
            srcEid: _packetBytes.srcEid(),
            sender: _packetBytes.sender(),
            nonce: _packetBytes.nonce()
        });
        address receiver = _packetBytes.receiverB20();
        ILayerZeroEndpointV2(endpoint).verify(origin, receiver, keccak256(_packetBytes.payload()));
        emit PacketValidated(origin.srcEid, origin.sender, receiver, origin.nonce);
    }

    // --------------------------------------------------------------------- IMessageLib

    function setConfig(address, SetConfigParam[] calldata) external {}

    function getConfig(uint32, address, uint32) external pure returns (bytes memory) {
        return "";
    }

    /// @dev Every eid is reachable in the local environment; the relayer decides routing.
    function isSupportedEid(uint32) external pure returns (bool) {
        return true;
    }

    function version() external pure returns (uint64 major, uint8 minor, uint8 endpointVersion) {
        return (1, 0, 2);
    }

    function messageLibType() external pure returns (MessageLibType) {
        return MessageLibType.SendAndReceive;
    }

    function supportsInterface(bytes4 _interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return _interfaceId == type(IMessageLib).interfaceId || super.supportsInterface(_interfaceId);
    }

    // --------------------------------------------------------------------- treasury / admin

    function setTreasury(address) external {}

    function setBaseNativeFee(uint256 _fee) external onlyOwner {
        baseNativeFee = _fee;
    }

    function withdrawFee(address _to, uint256 _amount) external onlyOwner {
        (bool ok, ) = _to.call{ value: _amount }("");
        require(ok, "LocalMessageLib: withdraw failed");
    }

    function withdrawLzTokenFee(address, address, uint256) external {}

    receive() external payable {}
}
