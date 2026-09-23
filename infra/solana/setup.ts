#!/usr/bin/env tsx
/**
 * Full Solana mirror-chain setup, in one run, ending in a manifest.
 *
 * The SVM counterpart to the EVM pipeline: create the assets, initialise the OFTs, register
 * everything with LayerZero, wire the peers, and write down what was deployed so anything
 * downstream reads a file instead of hunting through logs.
 *
 *   npm run solana:setup -- --config config/localnet-solana.json --home-relay 0x...
 *
 * Ordering is not arbitrary. `init_oft` has to run first because the store records the OFT
 * **store PDAs** — those are what `lz_compose` sees as the delivering OApp, so a store holding
 * program ids instead would reject every settlement as an unexpected source.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { loadConfig, allChains, vmOf } from "../lib/config.js";
import type { DeploymentConfig, ChainConfig } from "../lib/types.js";
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

const ZERO_EVM = "0x0000000000000000000000000000000000000000";

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
  peer: { remoteEid: number; address: string; verified: boolean };
}

async function initOft(
  chain: SolanaChain,
  chainConfig: ChainConfig,
  oftProgram: PublicKey,
  asset: { symbol: string; decimals: number },
  homeEid: number,
  homeRelay: string
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

  // ---- peer wiring. On Solana a peer is a PDA per remote eid, not a mapping slot.
  const [peer] = PublicKey.findProgramAddressSync(
    [SEEDS.peer, oftStore.toBuffer(), u32be(homeEid)],
    oftProgram
  );
  const peerData = Buffer.concat([
    DISC.set_peer_config,
    u32le(homeEid),
    Buffer.from([0]), // PeerConfigParam::PeerAddress
    evmAddressToBytes32(homeRelay),
  ]);
  const peerTx = new Transaction().add(
    new TransactionInstruction({
      programId: oftProgram,
      keys: [
        { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: peer, isSigner: false, isWritable: true },
        { pubkey: oftStore, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: peerData,
    })
  );
  await chain.connection.confirmTransaction(
    await chain.connection.sendTransaction(peerTx, [chain.payer]),
    chain.commitment
  );

  // Read it back, exactly as the EVM peer-wiring module does.
  const peerAccount = await chain.accountInfo(peer.toBase58());
  const stored = peerAccount?.data.subarray(8, 40).toString("hex") ?? "";
  const expected = evmAddressToBytes32(homeRelay).toString("hex");
  const verified = stored === expected;
  if (!verified) throw new Error(`Peer read-back mismatch: wrote ${expected}, chain has ${stored}`);
  log.ok(`peer to eid ${homeEid} wired and verified`);

  return {
    symbol: asset.symbol,
    decimals: asset.decimals,
    mint: mint.toBase58(),
    oftStore: oftStore.toBase58(),
    escrow: escrow.publicKey.toBase58(),
    peer: { remoteEid: homeEid, address: `0x${expected}`, verified },
  };
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

  // Point the store at the home-chain relay.
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

  const registry = await chain.accountInfo(oappRegistry.toBase58());
  if (!registry?.owner.equals(chain.endpointProgramId)) {
    throw new Error("the endpoint did not register swap_request as an OApp");
  }
  log.ok("registered with LayerZero as an OApp");

  return { store: store.toBase58(), lzComposeTypes: lzComposeTypes.toBase58() };
}

// ---------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet-solana.json"));
  const chainKey = arg("chain", "");
  const homeRelay = arg("home-relay", ZERO_EVM);

  const chainConfig = allChains(cfg).find(
    (c) => vmOf(c) === "svm" && (chainKey === "" || c.key === chainKey)
  );
  if (!chainConfig) throw new Error(`No Solana chain${chainKey ? ` "${chainKey}"` : ""} in ${cfg.name}.`);

  const chain = new SolanaChain(chainConfig);
  await chain.preflight();

  const oftProgram = programIdFrom("solana/keys/oft-keypair.json");
  const swapRequestProgram = programIdFrom("solana/keys/swap_request-keypair.json");

  for (const [label, id] of [["oft", oftProgram], ["swap_request", swapRequestProgram]] as const) {
    if (!(await chain.isProgramDeployed(id.toBase58()))) {
      throw new Error(`${label} is not deployed on ${chain.name}. Run \`npm run solana:deploy\` first.`);
    }
  }

  log.banner(`Solana setup — ${chain.name} (eid ${chain.eid})`);
  log.kv("home chain", `${cfg.homeChain.name} (eid ${cfg.homeChain.eid})`);
  log.kv("home relay", homeRelay === ZERO_EVM ? "not set — pass --home-relay" : homeRelay);

  // Each mint takes THIS chain's decimals, not the home chain's: an 18-decimal supply does not
  // fit a u64. Amounts cross in shared decimals, so the two ends need not agree.
  const baseDecimals = localDecimals(cfg, chainConfig, "base");
  const quoteDecimals = localDecimals(cfg, chainConfig, "quote");
  log.kv("local decimals", `${cfg.token.symbol} ${baseDecimals}, ${cfg.quoteAsset.symbol} ${quoteDecimals} (shared ${SHARED_DECIMALS})`);

  const base = await initOft(chain, chainConfig, oftProgram, { symbol: cfg.token.symbol, decimals: baseDecimals }, cfg.homeChain.eid, homeRelay);
  const quote = await initOft(chain, chainConfig, oftProgram, { symbol: cfg.quoteAsset.symbol, decimals: quoteDecimals }, cfg.homeChain.eid, homeRelay);
  const store = await initStore(chain, swapRequestProgram, cfg, base, quote, homeRelay);

  // ---- manifest
  const manifest = {
    name: cfg.name,
    vm: "svm" as const,
    createdAt: new Date().toISOString(),
    chain: { key: chainConfig.key, name: chainConfig.name, eid: chainConfig.eid, rpcUrl: chainConfig.rpcUrl },
    homeChain: { key: cfg.homeChain.key, eid: cfg.homeChain.eid, relay: homeRelay },
    payer: chain.deployer,
    programs: {
      endpoint: chain.endpointProgramId.toBase58(),
      oft: oftProgram.toBase58(),
      swapRequest: swapRequestProgram.toBase58(),
    },
    assets: { base, quote },
    swapRequest: store,
  };

  const path = resolve(process.cwd(), "deployments", `${cfg.name}.solana.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");

  log.banner("Solana mirror chain ready");
  log.kv("manifest", path);
  log.kv("swap_request store", store.store);
  log.kv(`${base.symbol} OFT store`, base.oftStore);
  log.kv(`${quote.symbol} OFT store`, quote.oftStore);

  if (homeRelay === ZERO_EVM) {
    log.warn("Peers point at the zero address. Re-run with --home-relay <SwapRelay address>,");
    log.warn("and setPeer on the EVM side back to these OFT store PDAs.");
  }
  log.info("\nRemaining: relayer support for the SVM delivery path — see agents.md section 12.");
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
