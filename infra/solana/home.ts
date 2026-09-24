/**
 * Solana as the HOME chain: the asset's genesis, its pool, and the relay that trades it.
 *
 * The Solana counterpart of modules 1, 4 and 5 on an EVM home chain. The full supply is minted
 * here; mirrors on other chains start empty and are credited only by bridge arrivals. Orders
 * from every mirror execute against one Orca Whirlpool through `swap_relay`.
 *
 * The relay needs more setup than its EVM counterpart, for one reason: Solana requires every
 * account an instruction touches to be named in advance, and the relay's return leg is a full
 * OFT `send`. So for each (asset, mirror) the send's account list is derived once — with
 * LayerZero's own OFT SDK — and recorded on chain as a return route, and the relay's static
 * accounts go into an address lookup table so a delivery fits in one transaction.
 */
import { createHash } from "node:crypto";
import {
  AddressLookupTableProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { oft } from "@layerzerolabs/oft-v2-solana-sdk";

import type { ChainConfig, DeploymentConfig } from "../lib/types.js";
import { isLocal } from "../lib/config.js";
import { Options } from "../lib/options.js";
import { log } from "../lib/logger.js";
import { SolanaChain } from "./chain.js";
import { ataOf, createAtaIdempotent, TOKEN_PROGRAM } from "./client.js";
import { initLocalEndpoint, initOAppPath, lzLocal } from "./lz-local.js";
import { deploySolanaPool, type SolanaPoolDeployment } from "./pool.js";
import { checkExistingMint, toBytes32, initOft, programIdFrom, type OftDeployment } from "./setup.js";
import { localDecimals, SHARED_DECIMALS } from "../lib/decimals.js";
import { WHIRLPOOL_PROGRAM_ID } from "./ids.js";
import { maxReturnFee, svmExecutor } from "../lib/svm-executor.js";

const disc = (name: string): Buffer => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
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

/** A mirror chain as the home chain sees it. */
export interface MirrorPeer {
  eid: number;
  baseOft: string;
  quoteOft: string;
  /** Its SwapRequest; absent until the mirror side is deployed. */
  request?: string;
}

export interface SolanaHomeDeployment {
  name: string;
  vm: "svm";
  role: "home";
  createdAt: string;
  chain: { key: string; name: string; eid: number; rpcUrl: string };
  payer: string;
  programs: { endpoint: string; oft: string; swapRelay: string; whirlpool: string };
  assets: { base: OftDeployment; quote: OftDeployment };
  pool?: SolanaPoolDeployment;
  relay?: { store: string; alt: string; peers: { eid: number; request: string }[]; routes: number };
}

async function send(chain: SolanaChain, ...ixs: TransactionInstruction[]): Promise<string> {
  const sig = await chain.connection.sendTransaction(new Transaction().add(...ixs), [chain.payer]);
  await chain.connection.confirmTransaction(sig, chain.commitment);
  return sig;
}

// ---------------------------------------------------------------------------- 1. the asset

/**
 * Refuses, before any CrossStock contract is deployed, a Solana home the pipeline would fail on
 * halfway: an existing mint to adapt that is missing, not SPL Token, or has other decimals.
 */
export async function preflightSolanaHome(cfg: DeploymentConfig, chainConfig: ChainConfig): Promise<void> {
  const chain = new SolanaChain(chainConfig);
  await chain.preflight();
  for (const [side, asset] of [["base", cfg.token], ["quote", cfg.quoteAsset]] as const) {
    if (asset.existingToken) {
      await checkExistingMint(chain, new PublicKey(asset.existingToken), asset.symbol, localDecimals(cfg, chainConfig, side));
      log.ok(`${asset.symbol}: existing mint ${asset.existingToken} checked — will be adapted, not replaced`);
    }
  }
}

/**
 * Genesis on Solana: both mints, the full supply to the deployer, the OFTs, and peers to every
 * mirror's OFTs.
 */
export async function setupSolanaHomeAssets(
  cfg: DeploymentConfig,
  chainConfig: ChainConfig,
  mirrors: MirrorPeer[]
): Promise<SolanaHomeDeployment> {
  const chain = new SolanaChain(chainConfig);
  await chain.preflight();
  const oftProgram = programIdFrom("solana/keys/oft-keypair.json");
  const relayProgram = programIdFrom("solana/keys/swap_relay-keypair.json");

  log.banner(`Solana home chain — ${chain.name} (eid ${chain.eid})`);
  if (isLocal(cfg)) await initLocalEndpoint(chain, mirrors.map((m) => m.eid));

  const base = await initOft(
    chain,
    chainConfig,
    oftProgram,
    {
      symbol: cfg.token.symbol,
      decimals: localDecimals(cfg, chainConfig, "base"),
      genesisSupply: cfg.token.initialSupply,
      existingMint: cfg.token.existingToken,
    },
    mirrors.map((m) => ({ eid: m.eid, oft: m.baseOft }))
  );
  const quote = await initOft(
    chain,
    chainConfig,
    oftProgram,
    {
      symbol: cfg.quoteAsset.symbol,
      decimals: localDecimals(cfg, chainConfig, "quote"),
      genesisSupply: cfg.quoteAsset.initialSupply,
      existingMint: cfg.quoteAsset.existingToken,
    },
    mirrors.map((m) => ({ eid: m.eid, oft: m.quoteOft }))
  );

  if (isLocal(cfg)) {
    for (const m of mirrors) {
      await initOAppPath(chain, base.oftStore, m.eid, toBytes32(m.baseOft));
      await initOAppPath(chain, quote.oftStore, m.eid, toBytes32(m.quoteOft));
    }
    log.ok(`messaging paths initialised to ${mirrors.length} mirror chain(s)`);
  }

  return {
    name: cfg.name,
    vm: "svm",
    role: "home",
    createdAt: new Date().toISOString(),
    chain: { key: chainConfig.key, name: chainConfig.name, eid: chainConfig.eid, rpcUrl: chainConfig.rpcUrl },
    payer: chain.deployer,
    programs: {
      endpoint: chain.endpointProgramId.toBase58(),
      oft: oftProgram.toBase58(),
      swapRelay: relayProgram.toBase58(),
      whirlpool: WHIRLPOOL_PROGRAM_ID,
    },
    assets: { base, quote },
  };
}

// ---------------------------------------------------------------------------- 2. the pool

export async function setupSolanaHomePool(
  cfg: DeploymentConfig,
  chainConfig: ChainConfig,
  home: SolanaHomeDeployment
): Promise<SolanaHomeDeployment> {
  const chain = new SolanaChain(chainConfig);
  home.pool = await deploySolanaPool(
    cfg,
    chain,
    { mint: new PublicKey(home.assets.base.mint), decimals: home.assets.base.decimals },
    { mint: new PublicKey(home.assets.quote.mint), decimals: home.assets.quote.decimals }
  );
  return home;
}

// ---------------------------------------------------------------------------- 3. the relay

export function relayStoreAddress(relayProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("Relay")], relayProgram)[0];
}

/**
 * Initialises `swap_relay`, points it at every mirror's SwapRequest, records each return
 * route, and builds the lookup table.
 */
export async function setupSolanaHomeRelay(
  cfg: DeploymentConfig,
  chainConfig: ChainConfig,
  home: SolanaHomeDeployment,
  mirrors: Required<MirrorPeer>[]
): Promise<SolanaHomeDeployment> {
  const chain = new SolanaChain(chainConfig);
  const program = new PublicKey(home.programs.swapRelay);
  if (!(await chain.isProgramDeployed(program.toBase58()))) {
    throw new Error("swap_relay is not deployed. Run `npm run solana:build:relay` and `npm run solana:deploy`.");
  }
  if (!home.pool) throw new Error("the pool must exist before the relay");
  log.step("swap_relay — the home-chain relay");

  const store = relayStoreAddress(program);
  const endpoint = chain.endpointProgramId;
  const baseMint = new PublicKey(home.assets.base.mint);
  const quoteMint = new PublicKey(home.assets.quote.mint);
  const whirlpool = new PublicKey(home.pool.whirlpool);

  // ---- init
  if (!(await chain.accountInfo(store.toBase58()))) {
    const [oappRegistry] = PublicKey.findProgramAddressSync([Buffer.from("OApp"), store.toBuffer()], endpoint);
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], endpoint);
    const data = Buffer.concat([
      disc("init_relay"),
      u32le(chain.eid),
      endpoint.toBuffer(),
      new PublicKey(home.programs.oft).toBuffer(),
      new PublicKey(home.assets.base.oftStore).toBuffer(),
      new PublicKey(home.assets.quote.oftStore).toBuffer(),
      Buffer.from([SHARED_DECIMALS]),
      chain.payer.publicKey.toBuffer(), // delegate
    ]);
    await send(
      chain,
      new TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: store, isSigner: false, isWritable: true },
          { pubkey: whirlpool, isSigner: false, isWritable: false },
          { pubkey: baseMint, isSigner: false, isWritable: false },
          { pubkey: quoteMint, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          // register_oapp: endpoint, then its accounts, then #[event_cpi]'s two
          { pubkey: endpoint, isSigner: false, isWritable: false },
          { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: store, isSigner: false, isWritable: false },
          { pubkey: oappRegistry, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: endpoint, isSigner: false, isWritable: false },
        ],
        data,
      })
    );
    log.ok(`relay initialised and registered as an OApp: ${store.toBase58()}`);
  }

  // The relay holds tokens only mid-delivery — arriving input, swap output — in its own
  // associated accounts, which the OFT and the pool both address.
  await send(
    chain,
    createAtaIdempotent(chain.payer.publicKey, store, baseMint),
    createAtaIdempotent(chain.payer.publicKey, store, quoteMint)
  );

  // ---- peers: each mirror's SwapRequest, with the executor options for returns to it — in
  // that mirror's own terms: EVM gas, or compute units and lamports for a Solana mirror.
  const optionsFor = (eid: number): Buffer => {
    const mc = cfg.mirrorChains.find((c) => c.eid === eid);
    const o =
      mc && (mc.vm ?? "evm") === "svm"
        ? (() => {
            const ex = svmExecutor(mc);
            return Options.new()
              .addExecutorLzReceive(ex.lzReceiveComputeUnits, ex.lzReceiveValueLamports)
              .addExecutorLzCompose(0, ex.lzComposeComputeUnits);
          })()
        : Options.new()
            .addExecutorLzReceive(BigInt(cfg.relay.returnGas))
            .addExecutorLzCompose(0, BigInt(cfg.relay.returnComposeGas ?? cfg.relay.returnGas));
    return Buffer.from(o.build().slice(2), "hex");
  };
  const feeCap = Buffer.alloc(8);
  feeCap.writeBigUInt64LE(maxReturnFee(chainConfig));
  for (const m of mirrors) {
    const returnOptions = optionsFor(m.eid);
    const [peer] = PublicKey.findProgramAddressSync([Buffer.from("Peer"), u32be(m.eid)], program);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(returnOptions.length);
    await send(
      chain,
      new TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: store, isSigner: false, isWritable: false },
          { pubkey: peer, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("set_peer"), u32le(m.eid), toBytes32(m.request), feeCap, len, returnOptions]),
      })
    );
    const stored = (await chain.accountInfo(peer.toBase58()))?.data.subarray(8, 40).toString("hex");
    if (stored !== toBytes32(m.request).toString("hex")) throw new Error(`peer to eid ${m.eid} did not land`);
  }
  log.ok(`peers wired and verified to ${mirrors.length} mirror SwapRequest(s)`);

  // ---- return routes: the full OFT `send` account list, per (asset, mirror)
  const alt = new Set<string>();
  const rpc = lzLocal(chain).rpc;
  let routes = 0;
  for (const m of mirrors) {
    for (const asset of [home.assets.base, home.assets.quote]) {
      const mint = new PublicKey(asset.mint);
      // Built with the deployer as payer — the SDK simulates with it — then account 0, the
      // OFT's signer and token authority, is the relay. Every other place the deployer appears
      // is a fee payer, which the executor supplies at delivery.
      const ix = await oft.send(
        rpc,
        {
          payer: createNoopSigner(publicKey(chain.payer.publicKey.toBase58())),
          tokenMint: publicKey(asset.mint),
          tokenEscrow: publicKey(asset.escrow),
          tokenSource: publicKey(ataOf(store, mint).toBase58()),
        },
        { dstEid: m.eid, to: toBytes32(m.request), amountLd: 1n, minAmountLd: 0n, nativeFee: 0n },
        { oft: publicKey(home.programs.oft) }
      );
      const keys = toWeb3JsInstruction(ix.instruction).keys;
      const accounts = keys.map((k, i) => ({
        pubkey: i === 0 ? store : k.pubkey,
        isWritable: k.isWritable,
        isPayer: i !== 0 && k.pubkey.equals(chain.payer.publicKey),
      }));
      const [route] = PublicKey.findProgramAddressSync([Buffer.from("Route"), mint.toBuffer(), u32be(m.eid)], program);
      const vec = Buffer.alloc(4);
      vec.writeUInt32LE(accounts.length);
      await send(
        chain,
        new TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: store, isSigner: false, isWritable: false },
            { pubkey: route, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([
            disc("set_return_route"),
            mint.toBuffer(),
            u32le(m.eid),
            vec,
            ...accounts.map((a) => Buffer.concat([a.pubkey.toBuffer(), Buffer.from([a.isWritable ? 1 : 0, a.isPayer ? 1 : 0])])),
          ]),
        })
      );
      routes++;
      alt.add(route.toBase58());
      for (const a of accounts) if (!a.isPayer) alt.add(a.pubkey.toBase58());
      alt.add(PublicKey.findProgramAddressSync([Buffer.from("Peer"), u32be(m.eid)], program)[0].toBase58());
    }
  }
  log.ok(`${routes} return routes recorded (${mirrors.length} mirrors × 2 assets)`);

  // ---- notices: the relay's own messaging path to each mirror's SwapRequest
  // A STRANDED or CANCELLED notice carries no tokens, so it is a plain endpoint `send` from the
  // relay, not an OFT transfer. Its accounts are recorded like a return route; the fee payer is
  // whoever sends the notice (the admin), so it is not pinned.
  const lz = lzLocal(chain);
  for (const m of mirrors) {
    const receiver = toBytes32(m.request);
    if (isLocal(cfg)) await initOAppPath(chain, store.toBase58(), m.eid, receiver);
    const metas = await lz.endpoint.getSendIXAccountMetaForCPI(rpc, publicKey(chain.payer.publicKey.toBase58()), {
      path: { sender: publicKey(store.toBase58()), dstEid: m.eid, receiver },
      msgLibProgram: lz.messageLib,
    });
    const accounts = metas.map((k) => {
      const pubkey = new PublicKey(k.pubkey.toString());
      return { pubkey, isWritable: k.isWritable, isPayer: pubkey.equals(chain.payer.publicKey) };
    });
    const [noticeRoute] = PublicKey.findProgramAddressSync(
      [Buffer.from("Route"), PublicKey.default.toBuffer(), u32be(m.eid)],
      program
    );
    const vec = Buffer.alloc(4);
    vec.writeUInt32LE(accounts.length);
    await send(
      chain,
      new TransactionInstruction({
        programId: program,
        keys: [
          { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: store, isSigner: false, isWritable: false },
          { pubkey: noticeRoute, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          disc("set_notice_route"),
          u32le(m.eid),
          vec,
          ...accounts.map((a) => Buffer.concat([a.pubkey.toBuffer(), Buffer.from([a.isWritable ? 1 : 0, a.isPayer ? 1 : 0])])),
        ]),
      })
    );
    alt.add(noticeRoute.toBase58());
    for (const a of accounts) if (!a.isPayer) alt.add(a.pubkey.toBase58());
  }
  log.ok(`notice routes recorded to ${mirrors.length} mirror SwapRequest(s)`);

  // ---- the relay as each home OFT's endpoint delegate
  // So it can kill an inbound OFT message that will never arrive (`cancel_stuck_inbound`), as
  // `SwapRelay` is its OFTs' delegate on an EVM home. Done last: the delegate is also who may
  // configure the OFT's paths, so every path above had to be set up first.
  for (const asset of [home.assets.base, home.assets.quote]) {
    await send(
      chain,
      toWeb3JsInstruction(
        oft.setOFTConfig(
          { oftStore: publicKey(asset.oftStore), admin: createNoopSigner(publicKey(chain.payer.publicKey.toBase58())) },
          { __kind: "Delegate", delegate: publicKey(store.toBase58()) },
          { oft: publicKey(home.programs.oft), endpoint: publicKey(endpoint.toBase58()) }
        ).instruction
      )
    );
  }
  log.ok("relay set as both OFT stores' endpoint delegate (can cancel stuck inbound messages)");

  // ---- lookup table: everything static a delivery names
  const whirlpoolProgram = new PublicKey(WHIRLPOOL_PROGRAM_ID);
  const poolInfo = await chain.connection.getAccountInfo(whirlpool);
  // Whirlpool layout: discriminator 8 | config 32 | bump 1 | tick_spacing 2 | seed 2 | fee 2 |
  // protocol fee 2 | liquidity 16 | sqrt_price 16 | tick 4 | owed a 8 | owed b 8 | mint a 32 |
  // vault a 32 | growth a 16 | mint b 32 | vault b 32
  const d = poolInfo!.data;
  const vaultA = new PublicKey(d.subarray(133, 165));
  const vaultB = new PublicKey(d.subarray(213, 245));
  for (const k of [
    store,
    whirlpool,
    vaultA,
    vaultB,
    PublicKey.findProgramAddressSync([Buffer.from("oracle"), whirlpool.toBuffer()], whirlpoolProgram)[0],
    ataOf(store, baseMint),
    ataOf(store, quoteMint),
    baseMint,
    quoteMint,
    whirlpoolProgram,
    new PublicKey(home.programs.oft),
    TOKEN_PROGRAM,
    endpoint,
    SystemProgram.programId,
    PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], endpoint)[0],
    ...home.pool.tickArrays.map((t) => new PublicKey(t)),
  ]) {
    alt.add(k.toBase58());
  }
  const altAddress = await createLookupTable(chain, [...alt].map((a) => new PublicKey(a)));
  await send(
    chain,
    new TransactionInstruction({
      programId: program,
      keys: [
        { pubkey: chain.payer.publicKey, isSigner: true, isWritable: false },
        { pubkey: store, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([disc("set_alt"), altAddress.toBuffer()]),
    })
  );
  log.ok(`lookup table ${altAddress.toBase58()} with ${alt.size} accounts`);

  home.relay = {
    store: store.toBase58(),
    alt: altAddress.toBase58(),
    peers: mirrors.map((m) => ({ eid: m.eid, request: m.request })),
    routes,
  };
  return home;
}

/** Creates and fills an address lookup table, then waits until it can be used. */
async function createLookupTable(chain: SolanaChain, addresses: PublicKey[]): Promise<PublicKey> {
  const slot = await chain.connection.getSlot("finalized");
  const [create, table] = AddressLookupTableProgram.createLookupTable({
    authority: chain.payer.publicKey,
    payer: chain.payer.publicKey,
    recentSlot: slot,
  });
  await send(chain, create);
  for (let i = 0; i < addresses.length; i += 20) {
    await send(
      chain,
      AddressLookupTableProgram.extendLookupTable({
        lookupTable: table,
        authority: chain.payer.publicKey,
        payer: chain.payer.publicKey,
        addresses: addresses.slice(i, i + 20),
      })
    );
  }
  // A table is usable only from the slot after its last extension.
  const extended = await chain.connection.getSlot("confirmed");
  while ((await chain.connection.getSlot("confirmed")) <= extended + 1) await new Promise((r) => setTimeout(r, 400));
  return table;
}
