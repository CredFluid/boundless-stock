import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { setContract, recordStep } from "../lib/manifest.js";
import { endpointOf } from "./00-endpoints.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 2 — mirror deployment.
 *
 * Loops the configured mirror chain list and deploys an empty TokenizedStock OFT on each one.
 * Adding a chain to the set is a config edit; there is no per-chain code path here, which is
 * the property the multi-mirror validation scenario exists to confirm.
 *
 * Every mirror is deployed with `initialSupply = 0`. A mirror instance therefore starts
 * structurally empty — it can only ever be credited by an inbound bridge message, which is
 * what makes "zero liquidity on the mirror chain" a property of the deployment rather than a
 * matter of operational discipline.
 */
export async function deployMirrorTokens(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<Record<string, string>> {
  log.step(`Module 2 — mirror deployment (${cfg.mirrorChains.length} chains)`);

  const artifact = forgeArtifact("TokenizedStock");
  const deployed: Record<string, string> = {};

  for (const mc of cfg.mirrorChains) {
    const chain = chains.get(mc.key)!;
    const endpoint = endpointOf(manifest, mc.key);

    log.group(`${mc.name} (mirror, eid ${mc.eid})`);

    const token = await chain.deploy(artifact, [
      cfg.token.name,
      cfg.token.symbol,
      endpoint,
      chain.deployer,
      0n, // empty by construction
    ]);
    log.kv(`${cfg.token.symbol} (OFT)`, token);

    const supply = await chain.read<bigint>(token, artifact.abi, "totalSupply");
    if (supply !== 0n) {
      throw new Error(`Mirror ${mc.name} deployed with non-zero supply ${supply} — zero-liquidity premise violated.`);
    }
    log.kv("total supply", "0 (verified)");

    setContract(manifest, mc.key, "TokenizedStock", token);
    deployed[mc.key] = token;

    log.groupEnd();
    log.ok(`${mc.name}: mirror instance live and empty`);
  }

  recordStep(manifest, "02-mirrors", "ok", `${cfg.mirrorChains.length} mirrors`);
  return deployed;
}
