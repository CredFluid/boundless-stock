import { parseEther, type Address } from "viem";
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { upsertChain, recordStep } from "../lib/manifest.js";
import { allChains } from "../lib/config.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 0 — LayerZero endpoint bootstrap.
 *
 * On live chains LayerZero's EndpointV2 already exists; config supplies the address and this
 * module simply records it. On a local chain there is no LayerZero deployment at all, so it
 * stands one up: a real EndpointV2 plus a LocalMessageLib registered as the default send and
 * receive library for every *other* chain in the set.
 *
 * Keeping both paths in one module is what lets the rest of the pipeline stay identical
 * between a local run and a Base Sepolia run.
 */
export async function ensureEndpoints(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<void> {
  log.step("Module 0 — LayerZero endpoints");

  const configs = allChains(cfg);
  const baseFee = parseEther(cfg.localMessageLibFee ?? "0.0001");

  for (const cc of configs) {
    const chain = chains.get(cc.key)!;
    const role = cc.key === cfg.homeChain.key ? "home" : "mirror";

    if (cc.lzEndpoint) {
      log.ok(`${cc.name}: using configured endpoint ${cc.lzEndpoint}`);
      upsertChain(manifest, {
        key: cc.key,
        name: cc.name,
        chainId: cc.chainId,
        eid: cc.eid,
        role,
        lzEndpoint: cc.lzEndpoint,
        contracts: {},
      });
      continue;
    }

    log.group(`${cc.name} (eid ${cc.eid}) — deploying local endpoint stack`);

    const endpointArtifact = forgeArtifact("LocalEndpointV2");
    const endpoint = await chain.deploy(endpointArtifact, [cc.eid, chain.deployer]);
    log.kv("EndpointV2", endpoint);

    const libArtifact = forgeArtifact("LocalMessageLib");
    const messageLib = await chain.deploy(libArtifact, [endpoint, chain.deployer, baseFee]);
    log.kv("LocalMessageLib", messageLib);

    await chain.write(endpoint, endpointArtifact.abi, "registerLibrary", [messageLib]);

    // Default libraries are configured per remote eid, so every peer chain needs a route.
    for (const other of configs) {
      if (other.eid === cc.eid) continue;
      await chain.write(endpoint, endpointArtifact.abi, "setDefaultSendLibrary", [other.eid, messageLib]);
      await chain.write(endpoint, endpointArtifact.abi, "setDefaultReceiveLibrary", [other.eid, messageLib, 0n]);
      log.dim(`routes to eid ${other.eid} configured`);
    }

    upsertChain(manifest, {
      key: cc.key,
      name: cc.name,
      chainId: cc.chainId,
      eid: cc.eid,
      role,
      lzEndpoint: endpoint,
      localMessageLib: messageLib,
      contracts: {},
    });

    log.groupEnd();
    log.ok(`${cc.name}: endpoint stack ready`);
  }

  recordStep(manifest, "00-endpoints", "ok", `${configs.length} chains`);
}

/** Endpoint address for a chain, after module 0 has run. */
export function endpointOf(manifest: Manifest, chainKey: string): Address {
  const e = manifest.chains[chainKey]?.lzEndpoint;
  if (!e) throw new Error(`No endpoint recorded for chain "${chainKey}".`);
  return e as Address;
}
