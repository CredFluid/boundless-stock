// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Vm } from "forge-std/Vm.sol";
import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
/// @dev Minimal view of the endpoint. Importing the full `EndpointV2` drags in its
///      constructor requirements for no benefit — only `lzCompose` is needed here.
interface IComposeExecutor {
    function lzCompose(
        address _from,
        address _to,
        bytes32 _guid,
        uint16 _index,
        bytes calldata _message,
        bytes calldata _extraData
    ) external payable;
}

import { OmniToken } from "../../src/core/OmniToken.sol";
import { SwapRelay } from "../../src/relay/SwapRelay.sol";
import { SwapRequest } from "../../src/relay/SwapRequest.sol";
import { MockSwapRouter } from "./MockSwapRouter.sol";

/**
 * @notice Two-chain fixture carrying the whole CrossStock relay stack, with delivery that
 *         understands composed messages.
 *
 * @dev `TestHelperOz5.verifyPackets` can deliver a packet but cannot execute an OFT compose:
 *      it passes the raw packet message to `lzCompose`, whereas the endpoint queued an
 *      `OFTComposeMsgCodec`-wrapped payload, so the queue hash never matches. Since the whole
 *      CrossStock mechanism rides on composed messages, this fixture drives them itself —
 *      recording logs, reading the `ComposeSent` the delivery emitted, and calling
 *      `lzCompose` with exactly the payload the endpoint is holding. That is the same
 *      verify -> lzReceive -> lzCompose sequence a DVN and Executor perform.
 */
abstract contract RelayFixture is TestHelperOz5 {
    /// keccak256("ComposeSent(address,address,bytes32,uint16,bytes)")
    bytes32 internal constant COMPOSE_SENT_TOPIC = keccak256("ComposeSent(address,address,bytes32,uint16,bytes)");

    uint32 internal constant HOME_EID = 1;
    uint32 internal constant MIRROR_EID = 2;

    OmniToken internal homeStock;
    OmniToken internal homeQuote;
    OmniToken internal mirrorStock;
    OmniToken internal mirrorQuote;

    MockSwapRouter internal router;
    SwapRelay internal relay;
    SwapRequest internal request;

    uint8 internal constant STOCK_DECIMALS = 18;
    uint8 internal constant QUOTE_DECIMALS = 6;
    uint24 internal constant POOL_FEE = 3000;

    /// @notice Diagnostics, so a campaign can prove it actually moved messages.
    uint256 public packetsDelivered;
    uint256 public composesExecuted;
    uint256 public composesFailed;

    /// @notice Everything minted at genesis, including the router's float.
    uint256 internal MINTED_STOCK;
    uint256 internal MINTED_QUOTE;

    function _setUpRelay(uint256 stockSupply, uint256 quoteSupply, uint256 stockFloat, uint256 quoteFloat) internal {
        setUpEndpoints(2, LibraryType.SimpleMessageLib);

        homeStock = new OmniToken("Stock", "STK", STOCK_DECIMALS, endpoints[HOME_EID], address(this), stockSupply);
        homeQuote = new OmniToken("USDC", "USDC", QUOTE_DECIMALS, endpoints[HOME_EID], address(this), quoteSupply);
        mirrorStock = new OmniToken("Stock", "STK", STOCK_DECIMALS, endpoints[MIRROR_EID], address(this), 0);
        mirrorQuote = new OmniToken("USDC", "USDC", QUOTE_DECIMALS, endpoints[MIRROR_EID], address(this), 0);

        _wirePeer(homeStock, MIRROR_EID, address(mirrorStock));
        _wirePeer(mirrorStock, HOME_EID, address(homeStock));
        _wirePeer(homeQuote, MIRROR_EID, address(mirrorQuote));
        _wirePeer(mirrorQuote, HOME_EID, address(homeQuote));

        router = new MockSwapRouter(address(homeStock), address(homeQuote), STOCK_DECIMALS, 150e6);
        relay = new SwapRelay(
            endpoints[HOME_EID],
            address(this),
            address(homeStock),
            address(homeQuote),
            address(router),
            POOL_FEE
        );
        request = new SwapRequest(
            endpoints[MIRROR_EID],
            address(this),
            address(mirrorStock),
            address(mirrorQuote),
            HOME_EID
        );

        relay.setPeer(MIRROR_EID, bytes32(uint256(uint160(address(request)))));
        request.setPeer(HOME_EID, bytes32(uint256(uint160(address(relay)))));

        // The router's float stands in for pool reserves. Minted at genesis so supply
        // accounting stays exact.
        homeStock.mint(address(router), stockFloat);
        homeQuote.mint(address(router), quoteFloat);

        MINTED_STOCK = stockSupply + stockFloat;
        MINTED_QUOTE = quoteSupply + quoteFloat;

        // The relay pays for return legs out of its own balance.
        vm.deal(address(relay), 100 ether);
    }

    function _wirePeer(OmniToken _token, uint32 _eid, address _peerAddr) private {
        _token.setPeer(_eid, bytes32(uint256(uint160(_peerAddr))));
    }

    // ------------------------------------------------------------------ delivery

    /// @dev A compose the endpoint has queued but that has not been executed yet.
    struct PendingCompose {
        address endpoint;
        address from;
        address to;
        bytes32 guid;
        uint16 index;
        bytes message;
    }

    PendingCompose[] internal pendingComposes;

    function pendingComposeCount() public view returns (uint256) {
        return pendingComposes.length;
    }

    /**
     * @notice Deliver every pending packet and execute every compose, until the system quiets.
     * @dev Several rounds are needed because one user action fans out: the order packet
     *      triggers a compose on the home chain, which emits the return packet, whose delivery
     *      queues another compose on the mirror chain.
     */
    function deliverAll() public {
        for (uint256 round = 0; round < 6; round++) {
            bool progressed = _deliverPackets();
            if (_executePendingComposes()) progressed = true;
            if (!progressed) break;
        }
    }

    /**
     * @notice Deliver packets but execute NO composes — reproduces an under-gassed or failing
     *         composed call, leaving tokens sitting in the relay.
     * @dev The composes stay QUEUED, exactly as LayerZero keeps them, so a later `deliverAll()`
     *      can still run them. An earlier version discarded them, which made a stall permanent
     *      and meant the campaign could never reach a fill.
     */
    function deliverPacketsOnly() public {
        _deliverPackets();
    }

    function _deliverPackets() private returns (bool progressed) {
        address[4] memory targets = [
            address(homeStock),
            address(homeQuote),
            address(mirrorStock),
            address(mirrorQuote)
        ];
        uint32[4] memory targetEids = [HOME_EID, HOME_EID, MIRROR_EID, MIRROR_EID];

        vm.recordLogs();
        for (uint256 i = 0; i < targets.length; i++) {
            bytes32 asBytes32 = bytes32(uint256(uint160(targets[i])));
            if (hasPendingPackets(uint16(targetEids[i]), asBytes32)) {
                verifyPackets(targetEids[i], asBytes32);
                packetsDelivered++;
                progressed = true;
            }
        }
        _collectComposes(vm.getRecordedLogs());
    }

    /// @dev Reads the `ComposeSent` events a delivery emitted and queues them for execution.
    function _collectComposes(Vm.Log[] memory _logs) private {
        for (uint256 i = 0; i < _logs.length; i++) {
            if (_logs[i].topics.length == 0 || _logs[i].topics[0] != COMPOSE_SENT_TOPIC) continue;

            (address from, address to, bytes32 guid, uint16 index, bytes memory message) = abi.decode(
                _logs[i].data,
                (address, address, bytes32, uint16, bytes)
            );
            // The emitter is the endpoint holding the queued compose.
            pendingComposes.push(PendingCompose(_logs[i].emitter, from, to, guid, index, message));
        }
    }

    function _executePendingComposes() private returns (bool progressed) {
        uint256 n = pendingComposes.length;
        if (n == 0) return false;

        PendingCompose[] memory queue = new PendingCompose[](n);
        for (uint256 i = 0; i < n; i++) queue[i] = pendingComposes[i];
        delete pendingComposes;

        for (uint256 i = 0; i < n; i++) {
            PendingCompose memory c = queue[i];
            try
                IComposeExecutor(c.endpoint).lzCompose{ value: 0.01 ether, gas: 3_000_000 }(
                    c.from,
                    c.to,
                    c.guid,
                    c.index,
                    c.message,
                    ""
                )
            {
                composesExecuted++;
                progressed = true;
            } catch {
                composesFailed++;
                // Still queued on the endpoint; keep it so a later round can retry.
                pendingComposes.push(c);
            }
        }
    }

}
