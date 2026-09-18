#!/usr/bin/env tsx
/**
 * CrossStock deployment pipeline.
 *
 * Runs every module in order against one config file and emits one manifest. This is the
 * entry point an issuer-facing "select base chain, select supported chains" flow would call.
 *
 *   npm run deploy -- --config config/localnet.json
 */
import { loadConfig, allChains, isLocal } from "./lib/config.js";
import { buildChains, deployerKey } from "./lib/chains.js";
import { privateKeyToAccount } from "viem/accounts";
import { formatEther } from "viem";
import { loadManifest, emptyManifest, saveManifest, getContract } from "./lib/manifest.js";
import { ensureEndpoints } from "./modules/00-endpoints.js";
import { deployHomeToken } from "./modules/01-token.js";
import { deployMirrorTokens } from "./modules/02-mirrors.js";
import { wirePeers, type PeerNode } from "./modules/03-peers.js";
import { deployPool } from "./modules/04-pool.js";
import { deployRelays } from "./modules/05-relays.js";
import { finalizeManifest, printManifest } from "./modules/06-manifest.js";
import { log } from "./lib/logger.js";
import type { Address } from "viem";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

async function main(): Promise<void> {
  const configPath = arg("config", "config/localnet.json");
  const fresh = process.argv.includes("--fresh");

  const cfg = loadConfig(configPath);
  const deployer = privateKeyToAccount(deployerKey()).address;

  log.banner(`CrossStock deployment — ${cfg.name}`);
  log.kv("config", configPath);
  log.kv("environment", isLocal(cfg) ? "local (infra deploys its own LayerZero endpoints)" : "live");
  log.kv("deployer", deployer);
  log.kv("token", `${cfg.token.name} (${cfg.token.symbol})`);
  log.kv("home chain", `${cfg.homeChain.name} — eid ${cfg.homeChain.eid}`);
  log.kv("mirror chains", cfg.mirrorChains.map((c) => `${c.name} (${c.eid})`).join(", "));

  const chains = buildChains(allChains(cfg));

  // Preflight every chain before writing anything anywhere. A partial deployment caused by an
  // unreachable third chain is far more annoying than a refusal up front.
  log.step("Preflight");
  for (const chain of chains.values()) {
    await chain.preflight();
    const bal = await chain.balance();
    log.ok(`${chain.name}: reachable, deployer holds ${formatEther(bal)} ${chain.config.nativeSymbol ?? "ETH"}`);
    if (bal === 0n) throw new Error(`Deployer has zero balance on ${chain.name} — fund it before deploying.`);
  }

  const manifest = (!fresh && loadManifest(cfg.name)) || emptyManifest(cfg, deployer);

  // ------------------------------------------------------------------ pipeline

  await ensureEndpoints(cfg, chains, manifest);
  saveManifest(manifest);

  await deployHomeToken(cfg, chains, manifest);
  saveManifest(manifest);

  await deployMirrorTokens(cfg, chains, manifest);
  saveManifest(manifest);

  log.step("Module 3 — peer wiring (OFT mesh)");
  const oftNodes: PeerNode[] = allChains(cfg).map((c) => ({
    chainKey: c.key,
    chainName: c.name,
    eid: c.eid,
    address: getContract(manifest, c.key, "TokenizedStock") as Address,
  }));
  const oftWiring = await wirePeers({ kind: "oft", nodes: oftNodes, chains, manifest, topology: "mesh" });
  saveManifest(manifest);
  if (oftWiring.failures.length > 0) {
    throw new Error(`OFT peer wiring failed verification on ${oftWiring.failures.length} link(s).`);
  }
  log.ok(`OFT mesh: ${oftWiring.verified}/${oftWiring.wired} links verified bidirectionally`);

  await deployPool(cfg, chains, manifest);
  saveManifest(manifest);

  await deployRelays(cfg, chains, manifest);
  saveManifest(manifest);

  const result = finalizeManifest(manifest);
  printManifest(manifest);

  if (!result.complete) {
    log.fail("Deployment finished with problems — see above.");
    process.exit(1);
  }

  log.banner("Deployment complete — no manual follow-up steps required");
  log.info(`Manifest: ${result.path}`);
  log.info(`Next: npm run validate -- --manifest ${result.path}`);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
