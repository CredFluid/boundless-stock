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
import { deployRelays, deployMirrorRequests } from "./modules/05-relays.js";
import { finalizeManifest, printManifest } from "./modules/06-manifest.js";
import { log } from "./lib/logger.js";
import { setupSolanaMirror, remotesFromManifest, solanaManifestPath } from "./solana/setup.js";
import { preflightSolanaHome, setupSolanaHomeAssets, setupSolanaHomePool, setupSolanaHomeRelay } from "./solana/home.js";
import { writeFileSync } from "node:fs";
import type { DeploymentConfig, Manifest } from "./lib/types.js";
import type { Chain } from "./lib/chains.js";
import { PublicKey } from "@solana/web3.js";
import { forgeArtifact } from "./lib/artifacts.js";
import { svmExecutor } from "./lib/svm-executor.js";
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

  // Route by VM. The EVM modules see only the EVM chains; each Solana chain is set up by its
  // own backend once the EVM side exists, because its peers are the EVM contracts' addresses.
  const svmChains = allChains(cfg).filter((c) => vmOf(c) === "svm");
  const solanaHome = vmOf(cfg.homeChain) === "svm";
  if (solanaHome && svmChains.length > 1) {
    throw new Error("A Solana home chain with further Solana mirrors is not supported yet; mirrors must be EVM.");
  }
  const evmCfg = { ...cfg, mirrorChains: cfg.mirrorChains.filter((c) => vmOf(c) === "evm") };
  if (svmChains.length > 0) {
    log.kv("Solana chains", svmChains.map((c) => `${c.name} (${c.eid})`).join(", "));
  }

  const chains = buildChains(allChains(evmCfg).filter((c) => vmOf(c) === "evm"));

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

  if (solanaHome) {
    await deployWithSolanaHome(cfg, evmCfg, chains, manifest);
    return;
  }

  await deployHomeToken(evmCfg, chains, manifest);
  saveManifest(manifest);

  await deployMirrorTokens(evmCfg, chains, manifest);
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
    const nodes: PeerNode[] = allChains(evmCfg).map((c) => ({
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

  await deployPool(evmCfg, chains, manifest);
  saveManifest(manifest);

  await deployRelays(evmCfg, chains, manifest);
  saveManifest(manifest);

  // ------------------------------------------------------------------ Solana chains
  for (const sc of svmChains) {
    const sol = await setupSolanaMirror(cfg, sc, remotesFromManifest(manifest));

    // The EVM half of each link: every EVM chain's OFT for an asset peers with that asset's
    // OFT store on Solana, and the home relay with the Solana request store. Same module,
    // same read-back verification; the Solana half was written by its own backend above.
    log.step(`EVM peers → ${sc.name}`);
    const svmNode = (address: string) => ({
      chainKey: sc.key,
      chainName: sc.name,
      eid: sc.eid,
      address: solanaPeerId(address),
      vm: "svm" as const,
    });
    for (const [contractName, store] of [
      ["TokenizedStockOft", sol.assets.base.oftStore],
      ["QuoteAssetOft", sol.assets.quote.oftStore],
    ] as const) {
      const nodes: PeerNode[] = [
        ...allChains(evmCfg).map((c) => ({
          chainKey: c.key,
          chainName: c.name,
          eid: c.eid,
          address: getContract(manifest, c.key, contractName) as Address,
        })),
        svmNode(store),
      ];
      const w = await wirePeers({ kind: "oft", nodes, chains, manifest, topology: "mesh", label: contractName });
      if (w.failures.length > 0) throw new Error(`${contractName} → ${sc.name} peer wiring failed verification.`);
    }
    const relayNodes: PeerNode[] = [
      {
        chainKey: evmCfg.homeChain.key,
        chainName: evmCfg.homeChain.name,
        eid: evmCfg.homeChain.eid,
        address: getContract(manifest, evmCfg.homeChain.key, "SwapRelay") as Address,
      },
      svmNode(sol.swapRequest.store),
    ];
    const r = await wirePeers({
      kind: "relay",
      nodes: relayNodes,
      chains,
      manifest,
      topology: "star",
      hubKey: evmCfg.homeChain.key,
      label: "SwapRelay",
    });
    if (r.failures.length > 0) throw new Error(`SwapRelay → ${sc.name} peer wiring failed verification.`);

    // Return legs to Solana ask for compute units and lamports, not EVM gas: the figures the
    // relay puts in its executor options are set per eid, in the destination's own terms.
    const home = chains.get(evmCfg.homeChain.key)!;
    const relay = getContract(manifest, evmCfg.homeChain.key, "SwapRelay") as Address;
    const relayAbi = forgeArtifact("SwapRelay").abi;
    const ex = svmExecutor(sc);
    await home.write(relay, relayAbi, "setReturnGas", [sc.eid, ex.lzReceiveComputeUnits]);
    await home.write(relay, relayAbi, "setReturnComposeGas", [sc.eid, ex.lzComposeComputeUnits]);
    await home.write(relay, relayAbi, "setReturnValue", [sc.eid, ex.lzReceiveValueLamports]);
    log.ok(
      `return legs to ${sc.name}: ${ex.lzReceiveComputeUnits} + ${ex.lzComposeComputeUnits} CU, ` +
        `${ex.lzReceiveValueLamports} lamports for rent`
    );
    saveManifest(manifest);
  }

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

/**
 * The pipeline when the HOME chain is Solana: genesis, pool and relay on Solana; empty OFTs and
 * a SwapRequest on every EVM mirror, all pointed at it.
 *
 * Ordered by what each step needs: the Solana OFTs peer with the mirrors' OFTs, so those come
 * first; the relay's peers are the mirrors' SwapRequests, so they come before the relay.
 */
async function deployWithSolanaHome(
  cfg: DeploymentConfig,
  evmCfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<void> {
  const homeCfg = cfg.homeChain;
  const mirrors = { ...evmCfg, homeChain: homeCfg };
  await preflightSolanaHome(cfg, homeCfg);

  // EVM mirrors: empty OFTs, wired to each other.
  await deployMirrorTokens(mirrors, chains, manifest);
  saveManifest(manifest);

  const peersOf = () =>
    evmCfg.mirrorChains.map((c) => ({
      eid: c.eid,
      baseOft: getContract(manifest, c.key, "TokenizedStockOft"),
      quoteOft: getContract(manifest, c.key, "QuoteAssetOft"),
      request: manifest.chains[c.key]?.contracts.SwapRequest ?? "",
    }));

  // Solana: genesis and the OFTs, peered with every mirror; then the pool.
  let home = await setupSolanaHomeAssets(cfg, homeCfg, peersOf());
  home = await setupSolanaHomePool(cfg, homeCfg, home);

  // The mesh, EVM half: every mirror OFT with every other, and with the Solana OFT store.
  log.step("Module 3 — peer wiring (Solana home)");
  for (const [contractName, store] of [
    ["TokenizedStockOft", home.assets.base.oftStore],
    ["QuoteAssetOft", home.assets.quote.oftStore],
  ] as const) {
    const nodes: PeerNode[] = [
      ...evmCfg.mirrorChains.map((c) => ({
        chainKey: c.key,
        chainName: c.name,
        eid: c.eid,
        address: getContract(manifest, c.key, contractName) as Address,
      })),
      { chainKey: homeCfg.key, chainName: homeCfg.name, eid: homeCfg.eid, address: solanaPeerId(store), vm: "svm" },
    ];
    const w = await wirePeers({ kind: "oft", nodes, chains, manifest, topology: "mesh", label: contractName });
    if (w.failures.length > 0) throw new Error(`${contractName} peer wiring failed verification.`);
  }

  // SwapRequests on the mirrors, pointed at the Solana relay by eid; then the relay itself,
  // which peers with them.
  await deployMirrorRequests(mirrors, chains, manifest);
  saveManifest(manifest);
  home = await setupSolanaHomeRelay(cfg, homeCfg, home, peersOf());

  const relayNodes: PeerNode[] = [
    { chainKey: homeCfg.key, chainName: homeCfg.name, eid: homeCfg.eid, address: solanaPeerId(home.relay!.store), vm: "svm" },
    ...evmCfg.mirrorChains.map((c) => ({
      chainKey: c.key,
      chainName: c.name,
      eid: c.eid,
      address: getContract(manifest, c.key, "SwapRequest") as Address,
    })),
  ];
  const r = await wirePeers({
    kind: "relay",
    nodes: relayNodes,
    chains,
    manifest,
    topology: "star",
    hubKey: homeCfg.key,
    label: "swap_relay↔SwapRequest",
  });
  if (r.failures.length > 0) throw new Error("SwapRequest → Solana relay peer wiring failed verification.");

  // Record the Solana side, and the pool in the shape the manifest summarises.
  const path = solanaManifestPath(cfg, homeCfg.key);
  writeFileSync(path, JSON.stringify(home, null, 2) + "\n");
  const pool = home.pool!;
  manifest.pool = {
    address: pool.whirlpool,
    token0: pool.mintA,
    token1: pool.mintB,
    feeTier: cfg.pool.feeTier,
    initialPrice: cfg.pool.initialPrice,
    sqrtPriceX96: "n/a — Orca Whirlpool (Q64.64), see the Solana deployment file",
    liquidity: "see the Solana deployment file",
    reserves: { base: cfg.pool.baseLiquidity, quote: cfg.pool.quoteLiquidity },
  };
  saveManifest(manifest);

  const result = finalizeManifest(manifest, chains);
  printManifest(manifest);
  if (!result.complete) {
    log.fail("Deployment finished with problems — see above.");
    process.exit(1);
  }
  log.banner("Deployment complete — Solana home chain, no manual follow-up steps required");
  log.info(`Manifest: ${result.path}`);
  log.info(`Solana home: ${path}`);
}

/** A Solana pubkey as LayerZero addresses it on an EVM chain: its 32 bytes, as hex. */
function solanaPeerId(base58: string): `0x${string}` {
  return `0x${Buffer.from(new PublicKey(base58).toBytes()).toString("hex")}`;
}
