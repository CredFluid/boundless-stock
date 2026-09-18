import { parseEther, type Address } from "viem";
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { upsertChain, recordStep } from "../lib/manifest.js";
import { allChains } from "../lib/config.js";
import { reuseAddress } from "../lib/reuse.js";
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

    const endpointArtifact = forgeArtifact("LocalEndpointV2");
    const libArtifact = forgeArtifact("LocalMessageLib");

    // Reuse an endpoint stack this infra deployed on a previous run. Redeploying it would
    // orphan every contract already bound to the old endpoint address.
    const recorded = manifest.chains[cc.key];
    const existingEndpoint = await reuseAddress(chain, recorded?.lzEndpoint, "EndpointV2");
    const existingLib = await reuseAddress(chain, recorded?.localMessageLib, "LocalMessageLib");

    const isNew = !existingEndpoint || !existingLib;
    log.group(`${cc.name} (eid ${cc.eid}) — ${isNew ? "deploying" : "reusing"} local endpoint stack`);

    const endpoint = existingEndpoint ?? (await chain.deploy(endpointArtifact, [cc.eid, chain.deployer]));
    const messageLib = existingLib ?? (await chain.deploy(libArtifact, [endpoint, chain.deployer, baseFee]));
    log.kv("EndpointV2", endpoint);
    log.kv("LocalMessageLib", messageLib);

    if (isNew) {
      await chain.write(endpoint, endpointArtifact.abi, "registerLibrary", [messageLib]);
    }

    // Default libraries are configured per remote eid. On an incremental run only the newly
    // added chains lack a route, so each one is checked rather than blindly rewritten.
    for (const other of configs) {
      if (other.eid === cc.eid) continue;
      const current = await chain.read<string>(endpoint, endpointArtifact.abi, "defaultSendLibrary", [other.eid]);
      if (current.toLowerCase() === messageLib.toLowerCase()) continue;

      await chain.write(endpoint, endpointArtifact.abi, "setDefaultSendLibrary", [other.eid, messageLib]);
      await chain.write(endpoint, endpointArtifact.abi, "setDefaultReceiveLibrary", [other.eid, messageLib, 0n]);
      log.dim(`route to eid ${other.eid} configured`);
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
