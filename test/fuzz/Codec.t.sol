// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { SwapTypes } from "../../src/relay/SwapTypes.sol";
import { LocalMessageLib } from "../../src/mocks/LocalMessageLib.sol";
import { LocalEndpointV2 } from "../../src/mocks/LocalEndpointV2.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @title CodecFuzz
 * @notice Property tests for everything that crosses the wire.
 *
 * @dev A codec bug in a cross-chain system is uniquely nasty: the message is accepted, decoded
 *      into plausible-looking values, and acted on. There is no revert to notice. So the
 *      encode/decode pair is fuzzed over the full input domain rather than spot-checked, and
 *      the executor-option parser — which decides how much native value gets moved — is fuzzed
 *      against independently built options.
 */
contract CodecFuzz is Test {
    using OptionsBuilder for bytes;

    LocalMessageLib internal lib;

    function setUp() public {
        LocalEndpointV2 endpoint = new LocalEndpointV2(1, address(this));
        lib = new LocalMessageLib(address(endpoint), address(this), 0.0001 ether);
    }

    // ------------------------------------------------------------------ Order

    /// @dev `recipient` is fuzzed over the full bytes32 domain, not just EVM addresses — the
    ///      field is 32 bytes wide precisely so a Solana pubkey survives the trip, and a codec
    ///      tested only with left-padded addresses would not catch a regression there.
    function testFuzz_orderRoundTrip(
        uint64 requestId,
        uint8 direction,
        uint256 minAmountOut,
        bytes32 recipient
    ) public pure {
        SwapTypes.Order memory o = SwapTypes.Order({
            requestId: requestId,
            direction: direction,
            minAmountOut: minAmountOut,
            recipient: recipient
        });

        SwapTypes.Order memory back = SwapTypes.decodeOrder(SwapTypes.encodeOrder(o));

        assertEq(back.requestId, requestId, "requestId must survive the wire");
        assertEq(back.direction, direction, "direction must survive the wire");
        assertEq(back.minAmountOut, minAmountOut, "minAmountOut must survive the wire");
        assertEq(back.recipient, recipient, "recipient must survive the wire");
    }

    // ------------------------------------------------------------------ Settlement

    function testFuzz_settlementRoundTrip(
        uint64 requestId,
        uint8 status,
        uint8 reason,
        uint256 amountIn,
        uint256 amountOut,
        uint64 lzNonce
    ) public pure {
        SwapTypes.Settlement memory s = SwapTypes.Settlement({
            requestId: requestId,
            status: status,
            reason: reason,
            amountIn: amountIn,
            amountOut: amountOut,
            lzNonce: lzNonce
        });

        SwapTypes.Settlement memory back = SwapTypes.decodeSettlement(SwapTypes.encodeSettlement(s));

        assertEq(back.requestId, requestId, "requestId must survive the wire");
        assertEq(back.status, status, "status must survive the wire");
        assertEq(back.reason, reason, "reason must survive the wire");
        assertEq(back.amountIn, amountIn, "amountIn must survive the wire");
        assertEq(back.amountOut, amountOut, "amountOut must survive the wire");
        assertEq(back.lzNonce, lzNonce, "the LayerZero nonce must survive the wire");
    }

    /// @dev The two payloads must never be confusable. They travel on the same channel, so a
    ///      Settlement decoded as an Order (or vice versa) must not produce a usable struct.
    function testFuzz_orderAndSettlementAreDistinguishable(uint64 requestId, uint256 amount) public pure {
        bytes memory order = SwapTypes.encodeOrder(
            SwapTypes.Order({ requestId: requestId, direction: 0, minAmountOut: amount, recipient: bytes32(uint256(0xBEEF)) })
        );
        bytes memory settlement = SwapTypes.encodeSettlement(
            SwapTypes.Settlement({
                requestId: requestId,
                status: 2,
                reason: 0,
                amountIn: amount,
                amountOut: amount,
                lzNonce: 0
            })
        );
        assertTrue(order.length != settlement.length, "payload lengths must differ so a mis-decode reverts");
    }

    // ------------------------------------------------------------------ executor options

    /**
     * @dev The parser decides how much native value the endpoint charges and the executor
     *      forwards. If it under-counts, a composed call arrives unfunded and the return leg
     *      cannot be paid; if it over-counts, users are overcharged.
     */
    function testFuzz_optionsValueAccounting(uint128 receiveGas, uint128 receiveValue, uint128 composeValue) public view {
        receiveGas = uint128(bound(receiveGas, 1, type(uint64).max));
        receiveValue = uint128(bound(receiveValue, 0, type(uint64).max));
        composeValue = uint128(bound(composeValue, 0, type(uint64).max));

        bytes memory options = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(receiveGas, receiveValue)
            .addExecutorLzComposeOption(0, 500_000, composeValue);

        uint256 parsed = lib._requestedNativeValue(options);
        assertEq(parsed, uint256(receiveValue) + uint256(composeValue), "parser must account for every requested wei");
    }

    /// @dev Gas-only options request no value, so they must be free beyond the base fee.
    function testFuzz_gasOnlyOptionsRequestNoValue(uint128 gas) public view {
        gas = uint128(bound(gas, 1, type(uint64).max));
        bytes memory options = OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas, 0);
        assertEq(lib._requestedNativeValue(options), 0, "gas-only options must request no native value");
    }

    /// @dev Malformed or truncated options must return 0 rather than revert. A quote that
    ///      reverts for a reason the caller cannot act on is worse than one that under-quotes.
    function testFuzz_malformedOptionsDoNotRevert(bytes calldata garbage) public view {
        uint256 v = lib._requestedNativeValue(garbage);
        assertGe(v, 0, "parser must always return, never revert");
    }

    /// @dev Options that are not TYPE_3 carry no executor instructions at all.
    function testFuzz_nonType3OptionsRequestNothing(uint16 optionType, bytes calldata tail) public view {
        vm.assume(optionType != 3);
        bytes memory options = abi.encodePacked(bytes2(optionType), tail);
        assertEq(lib._requestedNativeValue(options), 0, "only TYPE_3 options carry worker instructions");
    }
}
