// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { EndpointV2Mock } from "@layerzerolabs/test-devtools-evm-foundry/contracts/mocks/EndpointV2Mock.sol";

/**
 * @title LocalEndpointV2
 * @notice LayerZero's `EndpointV2Mock`, re-exported so Foundry emits a deployable artifact.
 *
 * @dev Despite the upstream name, this is not a simplified stand-in: it inherits the same
 *      `MessagingChannel`, `MessageLibManager`, `MessagingComposer` and `MessagingContext`
 *      that the production `EndpointV2` does, and differs only in taking `(eid, owner)`
 *      directly in its constructor instead of going through LayerZero's deployment scripts.
 *      Nonce ordering, payload hashing, compose queuing and library dispatch are the real
 *      implementations.
 *
 *      Deployed only by the local development environment. On live chains the infra uses the
 *      canonical EndpointV2 address from config and never touches this contract.
 */
contract LocalEndpointV2 is EndpointV2Mock {
    constructor(uint32 _eid, address _owner) EndpointV2Mock(_eid, _owner) {}
}
