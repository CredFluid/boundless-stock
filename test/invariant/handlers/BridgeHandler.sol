// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { Test } from "forge-std/Test.sol";
import { OmniToken } from "../../../src/core/OmniToken.sol";
import {
    SendParam,
    MessagingFee,
    MessagingReceipt,
    OFTReceipt
} from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

interface IFixture {
    function deliverTo(uint32 dstEid, address dstAddress) external;

    function tokenAt(uint256 i) external view returns (address);

    function eidAt(uint256 i) external view returns (uint32);

    function chainCount() external view returns (uint256);
}

/**
 * @notice Drives random bridging across the chain set, tracking what is in flight.
 *
 * @dev The point of separating send from deliver is to let the fuzzer leave messages
 *      *in flight* for arbitrary stretches — which is precisely the window in which aggregate
 *      supply is legitimately below what was minted, and precisely what a naive invariant
 *      would flag as a bug. Ghost accounting makes the real invariant checkable:
 *
 *        aggregateSupply + inFlight == MINTED
 */
contract BridgeHandler is Test {
    using OptionsBuilder for bytes;

    IFixture internal immutable fixture;
    address[] internal actors;

    /// @notice Cumulative amount burned by sends.
    uint256 public ghostSent;
    /// @notice Cumulative amount minted by deliveries.
    uint256 public ghostReceived;
    /// @notice Largest in-flight amount seen. Used to prove the fuzzer actually reached the
    ///         in-flight window rather than always settling immediately.
    uint256 public maxInFlight;

    /// @notice Call counters, for the invariant run summary.
    uint256 public callsBridge;
    uint256 public callsDeliver;
    uint256 public callsBridgeAndDeliver;

    constructor(address _fixture, address[] memory _actors) {
        fixture = IFixture(_fixture);
        actors = _actors;
    }

    /// @notice Tokens burned on a source chain but not yet minted on a destination chain.
    function inFlight() public view returns (uint256) {
        return ghostSent - ghostReceived;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // ------------------------------------------------------------------ actions

    /// @notice Send tokens from one chain to another and deliberately leave them in flight.
    function bridge(uint256 actorSeed, uint256 srcSeed, uint256 dstSeed, uint256 amount) public {
        callsBridge++;
        _send(actorSeed, srcSeed, dstSeed, amount);
    }

    /// @notice Deliver whatever is queued for one chain.
    function deliver(uint256 dstSeed) public {
        callsDeliver++;
        uint256 dst = dstSeed % fixture.chainCount();
        _deliver(dst);
    }

    /// @notice The common case: send and settle immediately.
    function bridgeAndDeliver(uint256 actorSeed, uint256 srcSeed, uint256 dstSeed, uint256 amount) public {
        callsBridgeAndDeliver++;
        uint256 dst = dstSeed % fixture.chainCount();
        if (_send(actorSeed, srcSeed, dstSeed, amount)) _deliver(dst);
    }

    /// @notice Move tokens between actors on one chain — supply-neutral, but it reshuffles
    ///         balances so the per-chain balance/supply invariant is doing real work.
    function transferLocal(uint256 fromSeed, uint256 toSeed, uint256 chainSeed, uint256 amount) public {
        OmniToken token = OmniToken(fixture.tokenAt(chainSeed % fixture.chainCount()));
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];

        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);

        vm.prank(from);
        token.transfer(to, amount);
    }

    /// @dev Accepts fee refunds from the endpoint.
    receive() external payable {}

    // ------------------------------------------------------------------ internals

    function _send(
        uint256 actorSeed,
        uint256 srcSeed,
        uint256 dstSeed,
        uint256 amount
    ) internal returns (bool) {
        uint256 n = fixture.chainCount();
        uint256 src = srcSeed % n;
        uint256 dst = dstSeed % n;
        if (src == dst) return false;

        address actor = actors[actorSeed % actors.length];
        OmniToken token = OmniToken(fixture.tokenAt(src));

        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return false;
        amount = bound(amount, 1, bal);

        SendParam memory param = SendParam({
            dstEid: fixture.eidAt(dst),
            to: bytes32(uint256(uint160(actor))),
            amountLD: amount,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });

        MessagingFee memory fee;
        try token.quoteSend(param, false) returns (MessagingFee memory f) {
            fee = f;
        } catch {
            return false;
        }

        // The LayerZero fee is paid by whoever makes the call with `{value:}` — which is this
        // handler, not the pranked actor. `vm.prank` only rewrites msg.sender. Funding the
        // actor instead leaves the handler at zero balance and every send fails silently.
        vm.deal(address(this), address(this).balance + fee.nativeFee);

        uint256 before = token.totalSupply();
        vm.prank(actor);
        try token.send{ value: fee.nativeFee }(param, fee, actor) returns (
            MessagingReceipt memory,
            OFTReceipt memory
        ) {
            // Burned amount is read from the supply delta below rather than the receipt, so
            // the ghost tracks what the ledger actually did rather than what it reported.
        } catch {
            return false;
        }
        ghostSent += before - token.totalSupply();
        if (inFlight() > maxInFlight) maxInFlight = inFlight();
        return true;
    }

    function _deliver(uint256 dst) internal {
        OmniToken token = OmniToken(fixture.tokenAt(dst));
        uint256 before = token.totalSupply();
        try fixture.deliverTo(fixture.eidAt(dst), address(token)) {
            ghostReceived += token.totalSupply() - before;
        } catch {
            // Nothing deliverable; leave the ghosts untouched.
        }
    }
}
