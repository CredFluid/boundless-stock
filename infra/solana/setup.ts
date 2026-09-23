#!/usr/bin/env tsx
/**
 * Full Solana mirror-chain setup, in one run, ending in a manifest.
 *
 * The SVM counterpart to the EVM pipeline: create the assets, initialise the OFTs, register
 * everything with LayerZero, wire the peers, and write down what was deployed so anything
 * downstream reads a file instead of hunting through logs.
 *
 *   npm run solana:setup -- --config config/localnet-solana.json
 *
 * Ordering is not arbitrary. `init_oft` has to run first because the store records the OFT
 * **store PDAs** — those are what `lz_compose` sees as the delivering OApp, so a store holding
 * program ids instead would reject every settlement as an unexpected source.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { loadConfig, allChains, vmOf, isLocal } from "../lib/config.js";
import { loadManifest } from "../lib/manifest.js";
import { initLocalEndpoint, initOAppPath } from "./lz-local.js";
import type { DeploymentConfig, ChainConfig, Manifest } from "../lib/types.js";
import { SolanaChain } from "./chain.js";
import { log } from "../lib/logger.js";
import { SHARED_DECIMALS, localDecimals } from "../lib/decimals.js";

/** Anchor discriminators: first eight bytes of sha256("global:<name>"). */
const DISC = {
  init_oft: Buffer.from([182, 169, 147, 16, 201, 45, 76, 23]),
  set_peer_config: Buffer.from([79, 187, 168, 57, 139, 140, 93, 47]),
  init_store: Buffer.from([250, 74, 6, 95, 163, 188, 19, 181]),
  set_home_relay: Buffer.from([236, 206, 33, 70, 35, 57, 110, 13]),
};

const SEEDS = {
  oft: Buffer.from("OFT"),
  peer: Buffer.from("Peer"),
  lzReceiveTypes: Buffer.from("LzReceiveTypes"),
  lzComposeTypes: Buffer.from("LzComposeTypes"),
  oapp: Buffer.from("OApp"),
  eventAuthority: Buffer.from("__event_authority"),
  store: Buffer.from("Store"),
};

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");


// ---------------------------------------------------------------------------- helpers

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function programIdFrom(keypairPath: string): PublicKey {
  return new PublicKey(execFileSync("solana-keygen", ["pubkey", keypairPath], { encoding: "utf8" }).trim());
}

/** An EVM address as LayerZero addresses it: left-padded into 32 bytes. */
function evmAddressToBytes32(address: string): Buffer {
  return Buffer.from(address.replace(/^0x/, "").padStart(64, "0"), "hex");
}

function createMint(rpcUrl: string, keypairPath: string, decimals: number): PublicKey {
  const out = execFileSync(
    "spl-token",
    ["create-token", "--decimals", String(decimals), "--url", rpcUrl, "--fee-payer", keypairPath, "--owner", keypairPath],
    { encoding: "utf8" }
  );
  const m = out.match(/Address:\s+([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (!m) throw new Error(`Could not parse a mint address from:\n${out}`);
  return new PublicKey(m[1]);
}

// ---------------------------------------------------------------------------- OFT

interface OftDeployment {
  symbol: string;
  decimals: number;
  mint: string;
  oftStore: string;
  escrow: string;
  peers: PeerLink[];
}

/** One remote chain this chain's OApps talk to, and each OApp's counterpart there. */
export interface RemoteChain {
  eid: number;
  /** This asset's OFT handle there — the token, or its adapter. */
  baseOft: string;
  quoteOft: string;
  /** The SwapRelay, on the home chain only. */
  relay?: string;
}

interface PeerLink {
  remoteEid: number;
  address: string;
  verified: boolean;
}

async function initOft(
  chain: SolanaChain,
  chainConfig: ChainConfig,
  oftProgram: PublicKey,
  asset: { symbol: string; decimals: number },
  remotes: { eid: number; oft: string }[]
): Promise<OftDeployment> {
  log.step(`${asset.symbol} — OFT`);

  const keypairPath = chainConfig.svm!.keypairPath!;
  const mint = createMint(chainConfig.rpcUrl, keypairPath, asset.decimals);

  // Declared `init` with no seeds, so it is a fresh keypair rather than a PDA — and Anchor
  // allocates it, so it only has to sign, not already exist.
  const escrow = Keypair.generate();

  const [oftStore] = PublicKey.findProgramAddressSync([SEEDS.oft, escrow.publicKey.toBuffer()], oftProgram);
  const [lzReceiveTypes] = PublicKey.findProgramAddressSync(
    [SEEDS.lzReceiveTypes, oftStore.toBuffer()],
    oftProgram
  );
  const [oappRegistry] = PublicKey.findProgramAddressSync(
    [SEEDS.oapp, oftStore.toBuffer()],
    chain.endpointProgramId
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [SEEDS.eventAuthority],
    chain.endpointProgramId
  );

  log.kv("mint", mint.toBase58());
  log.kv("OFT store", oftStore.toBase58());

  const data = Buffer.concat([
    DISC.init_oft,
    Buffer.from([0]), // OFTType::Native
    chain.payer.publicKey.toBuffer(),
    Buffer.from([SHARED_DECIMALS]),
    Buffer.from([1]), // Some(endpoint_program)
    chain.endpointProgramId.toBuffer(),
  ]);

  const keys = [
    { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: oftStore, isSigner: false, isWritable: true },
    { pubkey: lzReceiveTypes, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: escrow.publicKey, isSigner: true, isWritable: true },
    { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // register_oapp: target program first, then its declared accounts, then #[event_cpi]'s two
    { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
    { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: oftStore, isSigner: false, isWritable: false },
    { pubkey: oappRegistry, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
  ];

  const tx = new Transaction().add(new TransactionInstruction({ programId: oftProgram, keys, data }));
  await chain.connection.confirmTransaction(
    await chain.connection.sendTransaction(tx, [chain.payer, escrow]),
    chain.commitment
  );
  log.ok("init_oft confirmed");

  // A native OFT mints on inbound delivery, so the store must hold mint authority. Skip this
  // and setup looks complete while the first inbound bridge fails at the mint.
  execFileSync(
    "spl-token",
    ["authorize", mint.toBase58(), "mint", oftStore.toBase58(), "--url", chainConfig.rpcUrl, "--fee-payer", keypairPath, "--owner", keypairPath],
    { stdio: "pipe" }
  );
  log.ok("mint authority transferred to the OFT store");

  // ---- peer wiring: this asset's OFT on every other chain. The peer is that chain's OFT for
  // the SAME asset — never the relay, which an earlier version wired here by mistake, so the
  // OFT would have rejected every genuine transfer from the home chain.
  const peers: PeerLink[] = [];
  for (const r of remotes) peers.push(await wireOftPeer(chain, oftProgram, oftStore, r.eid, r.oft));

  return {
    symbol: asset.symbol,
    decimals: asset.decimals,
    mint: mint.toBase58(),
    oftStore: oftStore.toBase58(),
    escrow: escrow.publicKey.toBase58(),
    peers,
  };
}

/** On Solana a peer is a PDA per remote eid, not a mapping slot. Written, then read back. */
async function wireOftPeer(
  chain: SolanaChain,
  oftProgram: PublicKey,
  oftStore: PublicKey,
  remoteEid: number,
  remoteOft: string
): Promise<PeerLink> {
  const [peer] = PublicKey.findProgramAddressSync([SEEDS.peer, oftStore.toBuffer(), u32be(remoteEid)], oftProgram);
  const expected = evmAddressToBytes32(remoteOft);
  const peerTx = new Transaction().add(
    new TransactionInstruction({
      programId: oftProgram,
      keys: [
        { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: peer, isSigner: false, isWritable: true },
        { pubkey: oftStore, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        DISC.set_peer_config,
        u32le(remoteEid),
        Buffer.from([0]), // PeerConfigParam::PeerAddress
        expected,
      ]),
    })
  );
  await chain.connection.confirmTransaction(
    await chain.connection.sendTransaction(peerTx, [chain.payer]),
    chain.commitment
  );

  // Read it back, exactly as the EVM peer-wiring module does.
  const stored = (await chain.accountInfo(peer.toBase58()))?.data.subarray(8, 40).toString("hex") ?? "";
  const verified = stored === expected.toString("hex");
  if (!verified) throw new Error(`Peer read-back mismatch: wrote ${expected.toString("hex")}, chain has ${stored}`);
  log.ok(`peer to eid ${remoteEid} wired and verified`);
  return { remoteEid, address: `0x${stored}`, verified };
}

// ---------------------------------------------------------------------------- store

async function initStore(
  chain: SolanaChain,
  swapRequestProgram: PublicKey,
  cfg: DeploymentConfig,
  base: OftDeployment,
  quote: OftDeployment,
  homeRelay: string
): Promise<{ store: string; lzComposeTypes: string }> {
  log.step("swap_request store");

  const [store] = PublicKey.findProgramAddressSync([SEEDS.store], swapRequestProgram);
  const [lzComposeTypes] = PublicKey.findProgramAddressSync(
    [SEEDS.lzComposeTypes, store.toBuffer()],
    swapRequestProgram
  );
  const [oappRegistry] = PublicKey.findProgramAddressSync(
    [SEEDS.oapp, store.toBuffer()],
    chain.endpointProgramId
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [SEEDS.eventAuthority],
    chain.endpointProgramId
  );

  if (!(await chain.accountInfo(store.toBase58()))) {
    // The store records the OFT **store PDAs**, not the program ids: those are what
    // `lz_compose` sees as the delivering OApp, so anything else rejects every settlement.
    const data = Buffer.concat([
      DISC.init_store,
      u32le(cfg.homeChain.eid),
      new PublicKey(base.oftStore).toBuffer(),
      new PublicKey(quote.oftStore).toBuffer(),
      chain.endpointProgramId.toBuffer(),
      chain.payer.publicKey.toBuffer(),
      Buffer.from([SHARED_DECIMALS]),
    ]);

    const keys = [
      { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: true },
      { pubkey: lzComposeTypes, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(base.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(quote.mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
      { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: false },
      { pubkey: oappRegistry, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
    ];

    const tx = new Transaction().add(
      new TransactionInstruction({ programId: swapRequestProgram, keys, data })
    );
    await chain.connection.confirmTransaction(
      await chain.connection.sendTransaction(tx, [chain.payer]),
      chain.commitment
    );
    log.ok(`init_store confirmed — store ${store.toBase58()}`);
  } else {
    log.dim(`store already initialised at ${store.toBase58()}`);
  }

  await setHomeRelay(chain, swapRequestProgram, store, homeRelay);

  const registry = await chain.accountInfo(oappRegistry.toBase58());
  if (!registry?.owner.equals(chain.endpointProgramId)) {
    throw new Error("the endpoint did not register swap_request as an OApp");
  }
  log.ok("registered with LayerZero as an OApp");

  return { store: store.toBase58(), lzComposeTypes: lzComposeTypes.toBase58() };
}

/** Points the store at the home-chain SwapRelay. Idempotent. */
async function setHomeRelay(
  chain: SolanaChain,
  swapRequestProgram: PublicKey,
  store: PublicKey,
  homeRelay: string
): Promise<void> {
  const relayTx = new Transaction().add(
    new TransactionInstruction({
      programId: swapRequestProgram,
      keys: [
        { pubkey: chain.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: store, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([DISC.set_home_relay, evmAddressToBytes32(homeRelay)]),
    })
  );
  await chain.connection.confirmTransaction(
    await chain.connection.sendTransaction(relayTx, [chain.payer]),
    chain.commitment
  );
  log.ok(`home relay set to ${homeRelay}`);
}

// ---------------------------------------------------------------------------- deployment

export interface SolanaDeployment {
  name: string;
  vm: "svm";
  createdAt: string;
  chain: { key: string; name: string; eid: number; rpcUrl: string };
  homeChain: { key: string; eid: number; relay: string };
  payer: string;
  programs: { endpoint: string; oft: string; swapRequest: string };
  assets: { base: OftDeployment; quote: OftDeployment };
  swapRequest: { store: string; lzComposeTypes: string };
}

export const solanaManifestPath = (cfg: DeploymentConfig, chainKey: string): string =>
  resolve(process.cwd(), "deployments", `${cfg.name}.${chainKey}.solana.json`);

/**
 * Sets up one Solana mirror chain against the EVM chains in the deployment.
 *
 * Re-runnable: a deployment already recorded for this chain, whose store still exists on it,
 * is reused — mints are never recreated, since that would strand every balance on the old
 * ones — and only its peers and messaging paths are re-asserted.
 *
 * @param remotes Every other chain, with each OApp's counterpart there.
 */
export async function setupSolanaMirror(
  cfg: DeploymentConfig,
  chainConfig: ChainConfig,
  remotes: RemoteChain[]
): Promise<SolanaDeployment> {
  const chain = new SolanaChain(chainConfig);
  await chain.preflight();

  const oftProgram = programIdFrom("solana/keys/oft-keypair.json");
  const swapRequestProgram = programIdFrom("solana/keys/swap_request-keypair.json");
  for (const [label, id] of [["oft", oftProgram], ["swap_request", swapRequestProgram]] as const) {
    if (!(await chain.isProgramDeployed(id.toBase58()))) {
      throw new Error(`${label} is not deployed on ${chain.name}. Run \`npm run solana:deploy\` first.`);
    }
  }

  const home = remotes.find((r) => r.relay);
  if (!home?.relay) throw new Error("No home-chain SwapRelay among the remotes; deploy the EVM side first.");

  log.banner(`Solana setup — ${chain.name} (eid ${chain.eid})`);
  log.kv("home chain", `${cfg.homeChain.name} (eid ${cfg.homeChain.eid})`);
  log.kv("home relay", home.relay);

  // On a local validator the endpoint has no state until this runs; on a live cluster
  // LayerZero administers it and this step is skipped.
  if (isLocal(cfg)) await initLocalEndpoint(chain, remotes.map((r) => r.eid));

  const path = solanaManifestPath(cfg, chainConfig.key);
  const previous: SolanaDeployment | undefined = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
  let deployment: SolanaDeployment;

  if (previous && (await chain.accountInfo(previous.swapRequest.store))) {
    log.dim(`reusing Solana deployment recorded in ${path}`);
    deployment = previous;
    for (const [asset, key] of [[deployment.assets.base, "baseOft"], [deployment.assets.quote, "quoteOft"]] as const) {
      log.step(`${asset.symbol} — OFT peers`);
      asset.peers = [];
      for (const r of remotes) {
        asset.peers.push(await wireOftPeer(chain, oftProgram, new PublicKey(asset.oftStore), r.eid, r[key]));
      }
    }
    await setHomeRelay(chain, swapRequestProgram, new PublicKey(deployment.swapRequest.store), home.relay);
  } else {
    // Each mint takes THIS chain's decimals, not the home chain's: an 18-decimal supply does
    // not fit a u64. Amounts cross in shared decimals, so the two ends need not agree.
    const baseDecimals = localDecimals(cfg, chainConfig, "base");
    const quoteDecimals = localDecimals(cfg, chainConfig, "quote");
    log.kv(
      "local decimals",
      `${cfg.token.symbol} ${baseDecimals}, ${cfg.quoteAsset.symbol} ${quoteDecimals} (shared ${SHARED_DECIMALS})`
    );

    const base = await initOft(chain, chainConfig, oftProgram, { symbol: cfg.token.symbol, decimals: baseDecimals },
      remotes.map((r) => ({ eid: r.eid, oft: r.baseOft })));
    const quote = await initOft(chain, chainConfig, oftProgram, { symbol: cfg.quoteAsset.symbol, decimals: quoteDecimals },
      remotes.map((r) => ({ eid: r.eid, oft: r.quoteOft })));
    const store = await initStore(chain, swapRequestProgram, cfg, base, quote, home.relay);

    deployment = {
      name: cfg.name,
      vm: "svm",
      createdAt: new Date().toISOString(),
      chain: { key: chainConfig.key, name: chainConfig.name, eid: chainConfig.eid, rpcUrl: chainConfig.rpcUrl },
      homeChain: { key: cfg.homeChain.key, eid: cfg.homeChain.eid, relay: home.relay },
      payer: chain.deployer,
      programs: {
        endpoint: chain.endpointProgramId.toBase58(),
        oft: oftProgram.toBase58(),
        swapRequest: swapRequestProgram.toBase58(),
      },
      assets: { base, quote },
      swapRequest: store,
    };
  }

  // Messaging paths for every OApp on this chain, to its counterpart on every remote. An OApp
  // without these can neither send nor receive on that path.
  if (isLocal(cfg)) {
    log.step("LayerZero messaging paths");
    for (const r of remotes) {
      await initOAppPath(chain, deployment.assets.base.oftStore, r.eid, evmAddressToBytes32(r.baseOft));
      await initOAppPath(chain, deployment.assets.quote.oftStore, r.eid, evmAddressToBytes32(r.quoteOft));
      if (r.relay) await initOAppPath(chain, deployment.swapRequest.store, r.eid, evmAddressToBytes32(r.relay));
    }
    log.ok(`paths initialised to ${remotes.length} remote chain(s)`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(deployment, null, 2) + "\n");

  log.banner("Solana mirror chain ready");
  log.kv("manifest", path);
  log.kv("swap_request store", deployment.swapRequest.store);
  log.kv(`${deployment.assets.base.symbol} OFT store`, deployment.assets.base.oftStore);
  log.kv(`${deployment.assets.quote.symbol} OFT store`, deployment.assets.quote.oftStore);
  return deployment;
}

// ---------------------------------------------------------------------------- CLI

/**
 * Standalone entry: reads the EVM side's addresses from its manifest.
 *
 *   npm run solana:setup -- --config config/localnet-solana.json
 */
async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet-solana.json"));
  const chainKey = arg("chain", "");
  const chainConfig = allChains(cfg).find((c) => vmOf(c) === "svm" && (chainKey === "" || c.key === chainKey));
  if (!chainConfig) throw new Error(`No Solana chain${chainKey ? ` "${chainKey}"` : ""} in ${cfg.name}.`);

  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No EVM manifest for "${cfg.name}" — run \`npm run deploy\` first.`);
  await setupSolanaMirror(cfg, chainConfig, remotesFromManifest(manifest));
}

/** Every EVM chain in a manifest, with each OApp's address there. */
export function remotesFromManifest(manifest: Manifest): RemoteChain[] {
  return Object.values(manifest.chains)
    .filter((c) => (c.vm ?? "evm") === "evm")
    .map((c) => ({
      eid: c.eid,
      baseOft: c.contracts.TokenizedStockOft,
      quoteOft: c.contracts.QuoteAssetOft,
      relay: c.role === "home" ? c.contracts.SwapRelay : undefined,
    }));
}

if (process.argv[1]?.endsWith("setup.ts")) {
  main().catch((e) => {
    log.fail(e instanceof Error ? e.message : String(e));
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  });
}
