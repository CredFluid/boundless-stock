// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { TestHelperOz5 } from "@layerzerolabs/test-devtools-evm-foundry/contracts/TestHelperOz5.sol";
import { OmniToken } from "../../src/core/OmniToken.sol";
import { SendParam, MessagingFee } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/**
 * @notice Multi-endpoint fixture: one real LayerZero EndpointV2 per simulated chain, with a
 *         fully peer-wired omnichain token deployed to each.
 *
 * @dev Uses LayerZero's own `TestHelperOz5`, so the endpoints, packet encoding, nonce ordering
 *      and payload hashing are the real implementations rather than stand-ins. That matters
 *      for an invariant suite: a supply property proven against a mock of the bridge proves
 *      something about the mock.
 */
abstract contract OmniFixture is TestHelperOz5 {
    using OptionsBuilder for bytes;

    uint8 internal constant CHAIN_COUNT = 3;

    uint32[] internal eids;
    OmniToken[] internal tokens;

    /// @notice Total minted at genesis. The invariant everything is measured against.
    uint256 internal MINTED;

    function _setUpOmni(uint8 tokenDecimals, uint256 initialSupply) internal {
        setUpEndpoints(CHAIN_COUNT, LibraryType.SimpleMessageLib);
        MINTED = initialSupply;

        for (uint8 i = 0; i < CHAIN_COUNT; i++) {
            uint32 eid = uint32(i + 1);
            eids.push(eid);
            // Full supply on the first chain (the "home" chain); every other chain starts empty.
            tokens.push(
                new OmniToken(
                    "Omni",
                    "OMNI",
                    tokenDecimals,
                    endpoints[eid],
                    address(this),
                    i == 0 ? initialSupply : 0
                )
            );
        }

        // Full mesh: every chain peered with every other, in both directions.
        for (uint8 i = 0; i < CHAIN_COUNT; i++) {
            for (uint8 j = 0; j < CHAIN_COUNT; j++) {
                if (i == j) continue;
                tokens[i].setPeer(eids[j], bytes32(uint256(uint160(address(tokens[j])))));
            }
        }
    }

    /// @notice Sum of `totalSupply()` across every chain in the set.
    function aggregateSupply() public view returns (uint256 total) {
        for (uint256 i = 0; i < tokens.length; i++) {
            total += tokens[i].totalSupply();
        }
    }

    /// @notice Deliver any packets queued for a chain's token. Stands in for the executor.
    function deliverTo(uint32 _dstEid, address _dstAddress) public {
        verifyPackets(_dstEid, _dstAddress);
    }

    /**
     * @notice Bridge `amount` from chain 0 to chain `dst` and settle it, as the fixture owner.
     * @dev Used to reach a realistic steady state before fuzzing: with the whole supply sitting
     *      on one chain, two thirds of randomly chosen source chains have nothing to send and
     *      the fuzzer mostly no-ops. Spreading the supply first is what makes the campaign
     *      actually exercise bridging.
     */
    function seedChain(uint256 dst, uint256 amount) internal {
        SendParam memory param = SendParam({
            dstEid: eids[dst],
            to: bytes32(uint256(uint160(address(this)))),
            amountLD: amount,
            minAmountLD: 0,
            extraOptions: OptionsBuilder.newOptions().addExecutorLzReceiveOption(200_000, 0),
            composeMsg: "",
            oftCmd: ""
        });
        MessagingFee memory fee = tokens[0].quoteSend(param, false);
        tokens[0].send{ value: fee.nativeFee }(param, fee, address(this));
        verifyPackets(eids[dst], address(tokens[dst]));
    }

    function tokenAt(uint256 i) public view returns (address) {
        return address(tokens[i]);
    }

    function eidAt(uint256 i) public view returns (uint32) {
        return eids[i];
    }

    function chainCount() public pure returns (uint256) {
        return CHAIN_COUNT;
    }
}
