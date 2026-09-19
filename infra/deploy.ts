#!/usr/bin/env tsx
/**
 * CrossStock deployment pipeline.
 *
 * Runs every module in order against one config file and emits one manifest. This is the
 * entry point an issuer-facing "select base chain, select supported chains" flow would call.
 *
 *   npm run deploy -- --config config/localnet.json
 */
import { loadConfig, allChains, isLocal, vmOf } from "./lib/config.js";
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

  // Route by VM before touching anything. A Solana chain reaching the EVM backend produces a
  // confusing viem error several layers down; naming the gap here is far more useful.
  const svmChains = allChains(cfg).filter((c) => vmOf(c) === "svm");
  if (svmChains.length > 0) {
    log.step("VM routing");
    for (const c of svmChains) {
      log.warn(`${c.name} (eid ${c.eid}) is a Solana chain — the SVM backend is not implemented yet.`);
    }
    log.fail("Solana chains are configured but cannot be deployed to yet.");
    log.info("");
    log.info("The multi-VM config schema, validation and local validator harness are in place");
    log.info("(`npm run solana:up` clones LayerZero's real EndpointV2 onto a local validator).");
    log.info("What remains is the SVM backend itself — see agents.md §12 for the exact list.");
    process.exit(1);
  }

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

  // Two omnichain assets means two independent peer meshes. The module is called twice with
  // different nodes rather than being taught about a second token — adding a third asset later
  // is another call, not a code change.
  log.step("Module 3 — peer wiring (one OFT mesh per omnichain asset)");
  let totalLinks = 0;
  let totalVerified = 0;

  // Peers are wired between OFT HANDLES. For a launched asset that is the token itself; for
  // an adapted one it is the adapter, since the adapter is what speaks LayerZero.
  for (const [assetLabel, contractName] of [
    [cfg.token.symbol, "TokenizedStockOft"],
    [cfg.quoteAsset.symbol, "QuoteAssetOft"],
  ] as const) {
    log.group(`${assetLabel} mesh`);
    const nodes: PeerNode[] = allChains(cfg).map((c) => ({
      chainKey: c.key,
      chainName: c.name,
      eid: c.eid,
      address: getContract(manifest, c.key, contractName) as Address,
    }));
    const wiring = await wirePeers({
      kind: "oft",
      nodes,
      chains,
      manifest,
      topology: "mesh",
      label: contractName,
    });
    log.groupEnd();
    saveManifest(manifest);
    if (wiring.failures.length > 0) {
      throw new Error(`${assetLabel} peer wiring failed verification on ${wiring.failures.length} link(s).`);
    }
    totalLinks += wiring.wired;
    totalVerified += wiring.verified;
  }
  log.ok(`OFT meshes: ${totalVerified}/${totalLinks} links verified bidirectionally across 2 assets`);

  await deployPool(cfg, chains, manifest);
  saveManifest(manifest);

  await deployRelays(cfg, chains, manifest);
  saveManifest(manifest);

  const result = finalizeManifest(manifest, chains);
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
