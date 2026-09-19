#!/usr/bin/env tsx
/**
 * Initialises a LayerZero OFT on Solana for each asset, and wires its peer to the home chain.
 *
 * The SVM counterpart to modules 1–3 of the EVM pipeline: it creates the omnichain asset and
 * registers the route to the chain the market lives on.
 *
 *   npm run solana:oft -- --config config/localnet-solana.json --chain solana-devnet
 *
 * Two Solana specifics worth knowing before reading the code:
 *
 * - **Peers are accounts, not a mapping.** Where an EVM OFT stores peers in
 *   `mapping(uint32 => bytes32)`, Solana derives a `PeerConfig` PDA per remote eid. Wiring is
 *   therefore account creation, and "reading a peer back" means fetching that account.
 * - **A native OFT mints on receive**, so the mint authority has to be handed to the OFT store
 *   PDA. Skip that and inbound bridging fails at the mint, long after setup looked complete.
 */
import { execFileSync } from "node:child_process";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { loadConfig, allChains, vmOf } from "../lib/config.js";
import { SolanaChain } from "./chain.js";
import { log } from "../lib/logger.js";

/** Anchor discriminators: first eight bytes of sha256("global:<name>"). */
const DISC = {
  init_oft: Buffer.from([182, 169, 147, 16, 201, 45, 76, 23]),
  set_peer_config: Buffer.from([79, 187, 168, 57, 139, 140, 93, 47]),
};

const OFT_SEED = Buffer.from("OFT");
const PEER_SEED = Buffer.from("Peer");
const LZ_RECEIVE_TYPES_SEED = Buffer.from("LzReceiveTypes");
const OAPP_SEED = Buffer.from("OApp");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** LayerZero's shared decimals. An OFT bridges at this precision on every chain. */
const SHARED_DECIMALS = 6;

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

function programIdFrom(keypairPath: string): PublicKey {
  return new PublicKey(
    execFileSync("solana-keygen", ["pubkey", keypairPath], { encoding: "utf8" }).trim()
  );
}

function createMint(rpcUrl: string, keypairPath: string, decimals: number): PublicKey {
  const out = execFileSync(
    "spl-token",
    [
      "create-token",
      "--decimals", String(decimals),
      "--url", rpcUrl,
      "--fee-payer", keypairPath,
      "--owner", keypairPath,
    ],
    { encoding: "utf8" }
  );
  const m = out.match(/Address:\s+([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (!m) throw new Error(`Could not parse a mint address from:\n${out}`);
  return new PublicKey(m[1]);
}

/** An EVM address as LayerZero addresses it: left-padded into 32 bytes. */
function evmAddressToBytes32(address: string): Buffer {
  const clean = address.replace(/^0x/, "").padStart(64, "0");
  return Buffer.from(clean, "hex");
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet-solana.json"));
  const chainKey = arg("chain", "");
  /** The home-chain relay this OFT should trust, as a hex address. Optional at this stage. */
  const homeRelay = arg("home-relay", "0x0000000000000000000000000000000000000000");

  const chainConfig = allChains(cfg).find(
    (c) => vmOf(c) === "svm" && (chainKey === "" || c.key === chainKey)
  );
  if (!chainConfig) throw new Error(`No Solana chain${chainKey ? ` "${chainKey}"` : ""} in ${cfg.name}.`);

  const chain = new SolanaChain(chainConfig);
  await chain.preflight();

  const oftProgram = programIdFrom("solana/keys/oft-keypair.json");
  if (!(await chain.isProgramDeployed(oftProgram.toBase58()))) {
    throw new Error(`The OFT program is not deployed on ${chain.name}. Run \`npm run solana:deploy\`.`);
  }

  log.banner(`Initialising OFTs — ${chain.name} (eid ${chain.eid})`);
  log.kv("OFT program", oftProgram.toBase58());
  log.kv("endpoint", chain.endpointProgramId.toBase58());
  log.kv("home chain", `${cfg.homeChain.name} (eid ${cfg.homeChain.eid})`);

  const keypairPath = chainConfig.svm!.keypairPath!;
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [EVENT_AUTHORITY_SEED],
    chain.endpointProgramId
  );

  const assets = [
    { label: cfg.token.symbol, decimals: cfg.token.decimals },
    { label: cfg.quoteAsset.symbol, decimals: cfg.quoteAsset.decimals },
  ];

  const results: Record<string, { mint: string; oftStore: string; escrow: string }> = {};

  for (const asset of assets) {
    log.step(`${asset.label} — OFT setup`);

    // A native OFT mints and burns, so it needs a mint it controls.
    const mint = createMint(chainConfig.rpcUrl, keypairPath, asset.decimals);
    log.kv("mint", mint.toBase58());

    // The escrow is created with `init` and no seeds, so it is a fresh keypair rather than a
    // PDA, and has to sign its own creation.
    const escrow = Keypair.generate();

    const [oftStore] = PublicKey.findProgramAddressSync(
      [OFT_SEED, escrow.publicKey.toBuffer()],
      oftProgram
    );
    const [lzReceiveTypes] = PublicKey.findProgramAddressSync(
      [LZ_RECEIVE_TYPES_SEED, oftStore.toBuffer()],
      oftProgram
    );
    const [oappRegistry] = PublicKey.findProgramAddressSync(
      [OAPP_SEED, oftStore.toBuffer()],
      chain.endpointProgramId
    );

    log.kv("OFT store PDA", oftStore.toBase58());
    log.kv("token escrow", escrow.publicKey.toBase58());

    // InitOFTParams: oft_type (0 = Native) ‖ admin ‖ shared_decimals ‖ Option<endpoint_program>
    const data = Buffer.concat([
      DISC.init_oft,
      Buffer.from([0]), // OFTType::Native
      chain.payer.publicKey.toBuffer(),
      Buffer.from([SHARED_DECIMALS]),
      Buffer.from([1]), // Some(...)
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

      // --- remaining_accounts: endpoint register_oapp (target program first)
      { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
      { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: oftStore, isSigner: false, isWritable: false },
      { pubkey: oappRegistry, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
    ];

    // Anchor's `#[account(init, ...)]` allocates and funds the escrow itself. Pre-creating it
    // with SystemProgram.createAccount makes the program's own allocate fail with
    // "account already in use" — the escrow only has to sign, not exist.
    const tx = new Transaction().add(new TransactionInstruction({ programId: oftProgram, keys, data }));

    const sig = await chain.connection.sendTransaction(tx, [chain.payer, escrow]);
    await chain.connection.confirmTransaction(sig, chain.commitment);
    log.ok(`init_oft confirmed: ${sig.slice(0, 16)}…`);

    // A native OFT mints on inbound delivery, so the store PDA must hold mint authority.
    // Without this, setup looks complete and the first inbound bridge fails at the mint.
    execFileSync(
      "spl-token",
      [
        "authorize", mint.toBase58(), "mint", oftStore.toBase58(),
        "--url", chainConfig.rpcUrl,
        "--fee-payer", keypairPath,
        "--owner", keypairPath,
      ],
      { stdio: "pipe" }
    );
    log.ok("mint authority transferred to the OFT store");

    // ---------------------------------------------------------------- peer wiring
    const [peer] = PublicKey.findProgramAddressSync(
      [PEER_SEED, oftStore.toBuffer(), Buffer.from(u32be(cfg.homeChain.eid))],
      oftProgram
    );

    // SetPeerConfigParams: remote_eid u32(LE) ‖ enum PeerAddress(0) ‖ [u8;32]
    const peerData = Buffer.concat([
      DISC.set_peer_config,
      u32le(cfg.homeChain.eid),
      Buffer.from([0]), // PeerConfigParam::PeerAddress
      evmAddressToBytes32(homeRelay),
    ]);

    const peerKeys = [
      { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: peer, isSigner: false, isWritable: true },
      { pubkey: oftStore, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const peerTx = new Transaction().add(
      new TransactionInstruction({ programId: oftProgram, keys: peerKeys, data: peerData })
    );
    const peerSig = await chain.connection.sendTransaction(peerTx, [chain.payer]);
    await chain.connection.confirmTransaction(peerSig, chain.commitment);

    // Read the peer back, exactly as the EVM peer-wiring module does. An unverified peer
    // produces a deployment that looks complete and drops messages at runtime.
    const peerAccount = await chain.accountInfo(peer.toBase58());
    if (!peerAccount) throw new Error(`Peer PDA for eid ${cfg.homeChain.eid} was not created`);
    const storedPeer = peerAccount.data.subarray(8, 40).toString("hex");
    const expectedPeer = evmAddressToBytes32(homeRelay).toString("hex");
    if (storedPeer !== expectedPeer) {
      throw new Error(`Peer read-back mismatch: wrote ${expectedPeer}, chain has ${storedPeer}`);
    }
    log.ok(`peer to eid ${cfg.homeChain.eid} wired and verified by read-back`);

    results[asset.label] = {
      mint: mint.toBase58(),
      oftStore: oftStore.toBase58(),
      escrow: escrow.publicKey.toBase58(),
    };
  }

  log.banner("OFTs initialised");
  for (const [label, r] of Object.entries(results)) {
    log.group(label);
    log.kv("mint", r.mint);
    log.kv("OFT store", r.oftStore);
    log.kv("escrow", r.escrow);
    log.groupEnd();
  }

  if (homeRelay === "0x0000000000000000000000000000000000000000") {
    log.warn("Peers point at the zero address — pass --home-relay <SwapRelay address> to wire them");
    log.warn("for real. The EVM side must also setPeer back to these OFT stores.");
  }
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

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
