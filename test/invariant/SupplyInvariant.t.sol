// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { console2 } from "forge-std/console2.sol";
import { OmniFixture } from "../helpers/OmniFixture.sol";
import { BridgeHandler } from "./handlers/BridgeHandler.sol";
import { OmniToken } from "../../src/core/OmniToken.sol";

/**
 * @title SupplyInvariant
 * @notice Stateful fuzzing of the property the whole omnichain design rests on.
 *
 * @dev An OFT's `totalSupply()` is per chain. A bridge burns on the source and mints on the
 *      destination, so only the sum across the set is meaningful — and even that legitimately
 *      dips while a message is in flight, because the burn has happened and the mint has not.
 *
 *      That in-flight window is exactly what makes the naive invariant
 *      (`sum == minted`) unmonitorable, and exactly why this suite exists: the handler leaves
 *      messages in flight for arbitrary stretches and tracks the amount, so the *real*
 *      invariant can be asserted continuously:
 *
 *          aggregateSupply + inFlight == MINTED
 *
 *      The direction of the error matters more than its size. Supply going *under* is the safe
 *      failure — value is stuck, recoverable, and nobody gained. Supply going *over* is
 *      inflation, and `invariant_neverInflates` is the one that must never break.
 */
contract SupplyInvariant is OmniFixture {
    BridgeHandler internal handler;

    uint256 internal constant SUPPLY = 1_000_000e18;
    uint256 internal constant ACTOR_COUNT = 4;

    function setUp() public override {
        super.setUp();
        _setUpOmni(18, SUPPLY);

        address[] memory actors = new address[](ACTOR_COUNT);
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            vm.deal(actors[i], 100 ether);
        }

        handler = new BridgeHandler(address(this), actors);

        // Reach a realistic steady state before fuzzing: move a third of supply onto each
        // mirror chain through the real bridge, then spread it across the actors everywhere.
        // Without this the whole supply sits on one chain, most randomly chosen source chains
        // have nothing to send, and the campaign mostly no-ops.
        seedChain(1, SUPPLY / 3);
        seedChain(2, SUPPLY / 3);

        for (uint256 c = 0; c < tokens.length; c++) {
            uint256 each = tokens[c].balanceOf(address(this)) / ACTOR_COUNT;
            for (uint256 i = 0; i < ACTOR_COUNT; i++) {
                tokens[c].transfer(actors[i], each);
            }
        }

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = BridgeHandler.bridge.selector;
        selectors[1] = BridgeHandler.deliver.selector;
        selectors[2] = BridgeHandler.bridgeAndDeliver.selector;
        selectors[3] = BridgeHandler.transferLocal.selector;

        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------ invariants

    /**
     * @notice THE core invariant. Every token is either sitting on some chain or in flight
     *         between two — never anywhere else, never duplicated, never destroyed.
     */
    function invariant_supplyPlusInFlightEqualsMinted() public view {
        assertEq(
            aggregateSupply() + handler.inFlight(),
            MINTED,
            "tokens must be either on a chain or in flight; anything else is a leak or inflation"
        );
    }

    /**
     * @notice Supply may never exceed what was minted. This is the inflation check, and it is
     *         the one that must never break under any interleaving.
     */
    function invariant_neverInflates() public view {
        assertLe(aggregateSupply(), MINTED, "aggregate supply must never exceed the amount minted");
    }

    /// @notice A destination can never mint more than a source burned.
    function invariant_deliveredNeverExceedsSent() public view {
        assertLe(handler.ghostReceived(), handler.ghostSent(), "deliveries must never outpace sends");
    }

    /**
     * @notice Per chain, `totalSupply()` must equal the sum of every balance that exists.
     * @dev Catches a mint or burn that updated supply without a matching balance change, which
     *      a purely aggregate check would miss entirely.
     */
    function invariant_perChainBalancesSumToSupply() public view {
        uint256 actorCount = handler.actorCount();

        for (uint256 c = 0; c < tokens.length; c++) {
            OmniToken token = tokens[c];
            uint256 sum = token.balanceOf(address(this)); // deployer's remainder

            for (uint256 a = 0; a < actorCount; a++) {
                sum += token.balanceOf(handler.actorAt(a));
            }
            assertEq(sum, token.totalSupply(), "per-chain balances must sum to that chain's totalSupply");
        }
    }

    /// @notice Every mirror chain's supply is bounded by what has ever been bridged to it.
    function invariant_noChainExceedsTotal() public view {
        for (uint256 c = 0; c < tokens.length; c++) {
            assertLe(tokens[c].totalSupply(), MINTED, "no single chain may hold more than was ever minted");
        }
    }

    /**
     * @notice Proves the suite actually exercised the state it claims to test.
     * @dev An invariant that never reaches the interesting condition passes vacuously. This
     *      asserts the fuzzer genuinely left tokens in flight at some point, so
     *      `invariant_supplyPlusInFlightEqualsMinted` was doing real work rather than
     *      comparing two numbers that happened to be equal because nothing was pending.
     */
    function afterInvariant() public view {
        assertGt(handler.ghostSent(), 0, "fuzzer never bridged anything - invariants passed vacuously");
        assertGt(handler.maxInFlight(), 0, "fuzzer never left a message in flight - the in-flight window was never tested");
        console2.log("max in-flight reached:   ", handler.maxInFlight());
    }

    function invariant_callSummary() public view {
        console2.log("bridge (left in flight): ", handler.callsBridge());
        console2.log("deliver:                 ", handler.callsDeliver());
        console2.log("bridgeAndDeliver:        ", handler.callsBridgeAndDeliver());
        console2.log("currently in flight:     ", handler.inFlight());
        console2.log("aggregate supply:        ", aggregateSupply());
    }
}
