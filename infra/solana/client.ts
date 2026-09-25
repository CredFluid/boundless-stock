/**
 * A user-side client for CrossStock on a Solana mirror chain.
 *
 * The Solana counterpart to calling `SwapRequest.buy()` / `sell()` with viem. Most of the work
 * is accounts: `open_request` forwards LayerZero's OFT `send` by CPI, so the transaction must
 * carry every account that send — and the endpoint and message library beneath it — will
 * touch. Those are derived with LayerZero's own OFT SDK rather than listed by hand.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { oft } from "@layerzerolabs/oft-v2-solana-sdk";
import type { Hex } from "viem";

import type { DeploymentConfig } from "../lib/types.js";
import { SolanaChain } from "./chain.js";
import { lzLocal } from "./lz-local.js";
import { solanaManifestPath, toBytes32, type SolanaDeployment } from "./setup.js";
import { repoRoot } from "../lib/root.js";

export { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./token.js";
import { TOKEN_PROGRAM, programOf } from "./token.js";
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export enum SolanaDirection {
  Buy = 0,
  Sell = 1,
}

/** Mirrors `swap_request::state::Status`, which mirrors `SwapTypes.Status`. */
export enum SolanaStatus {
  None = 0,
  Pending = 1,
  Filled = 2,
  Refunded = 3,
  Stranded = 4,
  Cancelled = 5,
}

export interface SolanaRequest {
  user: PublicKey;
  direction: SolanaDirection;
  amountIn: bigint;
  minAmountOut: bigint;
  amountOut: bigint;
  status: SolanaStatus;
  failureReason: number;
  /** Nonce of the outbound message, on the path of the input asset's OFT. */
  lzNonce: bigint;
  /** Unix seconds; `settledAt` is zero while pending. */
  createdAt: bigint;
  settledAt: bigint;
}

/** Mirrors `swap_request::state::FeeState`, which mirrors `SwapRequest.FeeState` on EVM. */
export enum SolanaFeeState {
  None = 0,
  Escrowed = 1,
  Paid = 2,
  Returned = 3,
}

export interface SolanaFeeEscrow {
  partnerId: number;
  user: PublicKey;
  mint: PublicKey;
  partnerRecipient: PublicKey;
  platformRecipient: PublicKey;
  partnerFee: bigint;
  platformFee: bigint;
  state: SolanaFeeState;
}

/** The associated token account of `owner` for `mint`, under the mint's token program. */
export const ataOf = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** `CreateIdempotent`: creates the associated token account if missing, else does nothing. */
export const createAtaIdempotent = (
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM
): TransactionInstruction =>
  new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataOf(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

const discriminator = (name: string): Buffer => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64le = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u64be = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};

export class SolanaSwapClient {
  readonly chain: SolanaChain;
  readonly deployment: SolanaDeployment;
  readonly store: PublicKey;
  readonly program: PublicKey;
  readonly baseMint: PublicKey;
  readonly quoteMint: PublicKey;

  constructor(cfg: DeploymentConfig, chain: SolanaChain) {
    this.chain = chain;
    this.deployment = JSON.parse(readFileSync(solanaManifestPath(cfg, chain.config.key), "utf8"));
    this.store = new PublicKey(this.deployment.swapRequest.store);
    this.program = new PublicKey(this.deployment.programs.swapRequest);
    this.baseMint = new PublicKey(this.deployment.assets.base.mint);
    this.quoteMint = new PublicKey(this.deployment.assets.quote.mint);
  }

  get eid(): number {
    return this.chain.eid;
  }

  mint(side: "base" | "quote"): PublicKey {
    return side === "base" ? this.baseMint : this.quoteMint;
  }

  /** The token program of one asset's mint on this chain: SPL Token or Token-2022. */
  tokenProgram(side: "base" | "quote"): PublicKey {
    return programOf(this.deployment.assets[side]);
  }

  /** The token program of one of this deployment's mints. */
  programForMint(mint: PublicKey): PublicKey {
    return this.tokenProgram(mint.equals(this.baseMint) ? "base" : "quote");
  }

  /** A holder's balance of one asset, in this chain's local decimals. Zero if no account yet. */
  async balance(owner: PublicKey, side: "base" | "quote"): Promise<bigint> {
    const ata = ataOf(owner, this.mint(side), this.tokenProgram(side));
    if (!(await this.chain.connection.getAccountInfo(ata))) return 0n;
    return BigInt((await this.chain.connection.getTokenAccountBalance(ata)).value.amount);
  }

  /** Total supply of one asset's mint on this chain, in local decimals. */
  async mintSupply(side: "base" | "quote"): Promise<{ amount: bigint; decimals: number }> {
    const s = await this.chain.connection.getTokenSupply(this.mint(side));
    return { amount: BigInt(s.value.amount), decimals: s.value.decimals };
  }

  /** A fresh, SOL-funded user — distinct from the deployer, for the same reason as on EVM. */
  async newUser(sol = 10): Promise<Keypair> {
    const user = Keypair.generate();
    const sig = await this.chain.connection.requestAirdrop(user.publicKey, sol * 1e9);
    await this.chain.connection.confirmTransaction(sig, "confirmed");
    return user;
  }

  /** The request id the next `open_request` will use. */
  async nextRequestId(): Promise<bigint> {
    const data = (await this.chain.connection.getAccountInfo(this.store))!.data;
    // discriminator | admin | home_eid | home_relay, base/quote mint, base/quote oft, endpoint | next id
    return data.readBigUInt64LE(8 + 32 + 4 + 32 * 6);
  }

  /**
   * The nonce the next message on an OFT's path home will carry: the endpoint's
   * `outbound_nonce` + 1. `open_request` records the request under it, and the index account's
   * address depends on it, so the transaction has to name it in advance.
   */
  async nextOutboundNonce(oftStore: PublicKey, homeOft: Buffer): Promise<bigint> {
    const endpoint = new PublicKey(this.deployment.programs.endpoint);
    const eid = Buffer.alloc(4);
    eid.writeUInt32BE(this.deployment.homeChain.eid);
    const [nonce] = PublicKey.findProgramAddressSync([Buffer.from("Nonce"), oftStore.toBuffer(), eid, homeOft], endpoint);
    const info = await this.chain.connection.getAccountInfo(nonce);
    // discriminator (8) | bump (1) | outbound_nonce (8) | inbound_nonce (8)
    return (info ? info.data.readBigUInt64LE(9) : 0n) + 1n;
  }

  nonceIndexAddress(oftStore: PublicKey, nonce: bigint): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("Nonce"), oftStore.toBuffer(), u64be(nonce)], this.program)[0];
  }

  requestAddress(id: bigint): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("Request"), u64be(id)], this.program)[0];
  }

  async getRequest(id: bigint): Promise<SolanaRequest | null> {
    const info = await this.chain.connection.getAccountInfo(this.requestAddress(id));
    if (!info) return null;
    const d = info.data;
    let o = 8;
    const user = new PublicKey(d.subarray(o, (o += 32)));
    const direction = d[o++] as SolanaDirection;
    o += 64; // token_in, token_out
    const amountIn = d.readBigUInt64LE(o);
    const minAmountOut = d.readBigUInt64LE(o + 8);
    const amountOut = d.readBigUInt64LE(o + 16);
    const createdAt = d.readBigInt64LE(o + 24);
    const settledAt = d.readBigInt64LE(o + 32);
    o += 24 + 16; // amounts, created_at, settled_at
    const status = d[o] as SolanaStatus;
    const failureReason = d[o + 1];
    const lzNonce = d.readBigUInt64LE(o + 3); // after status, failure_reason, bump
    return { user, direction, amountIn, minAmountOut, amountOut, status, failureReason, lzNonce, createdAt, settledAt };
  }

  /**
   * Opens a trade: the user's one transaction on this chain.
   *
   * @param minAmountOut In the OUTPUT mint's local decimals on this chain; the program converts
   *                     it to shared decimals before it crosses.
   * @param options      LayerZero executor options for the leg to the home chain, which must
   *                     fund the relay's compose (its return leg is paid from that value).
   */
  async openRequest(
    user: Keypair,
    direction: SolanaDirection,
    amountIn: bigint,
    minAmountOut: bigint,
    options: Hex
  ): Promise<{ requestId: bigint; signature: string; nativeFee: bigint }> {
    const o = await this.buildOpen(user.publicKey, direction, amountIn, minAmountOut, options);
    const ix = new TransactionInstruction({
      programId: this.program,
      keys: [...o.baseKeys, ...o.remaining],
      data: Buffer.concat([discriminator("open_request"), o.params]),
    });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      createAtaIdempotent(user.publicKey, this.store, o.tokenIn, o.tokenProgram),
      ix
    );
    const signature = await this.chain.connection.sendTransaction(tx, [user]);
    await this.chain.connection.confirmTransaction(signature, "confirmed");
    return { requestId: o.requestId, signature, nativeFee: o.nativeFee };
  }

  /**
   * Opens a trade through a partner, carrying the partner's fee.
   *
   * `partnerSigner` co-signs: in production that signature comes from the partner's backend,
   * which checks the transaction is the order it approved before adding it. `amountIn` is what
   * the user pays; the fees come off it and the rest is traded.
   */
  async openRequestViaPartner(
    user: Keypair,
    partnerSigner: Keypair,
    partnerId: number,
    feeBps: number,
    direction: SolanaDirection,
    amountIn: bigint,
    minAmountOut: bigint,
    options: Hex
  ): Promise<{ requestId: bigint; signature: string; nativeFee: bigint }> {
    const built = await this.buildPartnerOrder(
      user.publicKey, partnerSigner.publicKey, partnerId, feeBps, direction, amountIn, minAmountOut, options
    );
    built.tx.sign([user, partnerSigner]);
    const signature = await this.submit(built.tx);
    return { requestId: built.requestId, signature, nativeFee: built.nativeFee };
  }

  /**
   * A partner order as an unsigned v0 transaction: what the partner API hands out. The user is
   * the fee payer; the partner's authoriser and the user sign it, in either order.
   *
   * A second signature and the partner's accounts take it past Solana's 1,232-byte packet
   * limit as a legacy transaction, so it names the static LayerZero and OFT accounts through
   * the deployment's lookup table (one byte each instead of 32).
   */
  async buildPartnerOrder(
    user: PublicKey,
    partnerSigner: PublicKey,
    partnerId: number,
    feeBps: number,
    direction: SolanaDirection,
    amountIn: bigint,
    minAmountOut: bigint,
    options: Hex
  ): Promise<{ tx: VersionedTransaction; requestId: bigint; nativeFee: bigint; lookupTable: PublicKey; blockhash: string }> {
    const { instructions, requestId, nativeFee } = await this.partnerInstructions(
      user, partnerSigner, partnerId, feeBps, direction, amountIn, minAmountOut, options
    );
    const lut = await this.lookupTable();
    const { blockhash } = await this.chain.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions }).compileToV0Message([lut]);
    return { tx: new VersionedTransaction(message), requestId, nativeFee, lookupTable: lut.key, blockhash };
  }

  /** A plain order (no partner) as an unsigned v0 transaction, for a deployment that allows them. */
  async buildOpenOrder(
    user: PublicKey,
    direction: SolanaDirection,
    amountIn: bigint,
    minAmountOut: bigint,
    options: Hex
  ): Promise<{ tx: VersionedTransaction; requestId: bigint; nativeFee: bigint; lookupTable: PublicKey }> {
    const o = await this.buildOpen(user, direction, amountIn, minAmountOut, options);
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      createAtaIdempotent(user, this.store, o.tokenIn, o.tokenProgram),
      new TransactionInstruction({
        programId: this.program,
        keys: [...o.baseKeys, ...o.remaining],
        data: Buffer.concat([discriminator("open_request"), o.params]),
      }),
    ];
    const lut = await this.lookupTable();
    const { blockhash } = await this.chain.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions }).compileToV0Message([lut]);
    return { tx: new VersionedTransaction(message), requestId: o.requestId, nativeFee: o.nativeFee, lookupTable: lut.key };
  }

  /** Sends a fully signed transaction and waits for it to confirm. */
  async submit(tx: VersionedTransaction): Promise<string> {
    const conn = this.chain.connection;
    const signature = await conn.sendTransaction(tx);
    const { lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    await conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, "confirmed");
    return signature;
  }

  private async partnerInstructions(
    user: PublicKey,
    partnerSigner: PublicKey,
    partnerId: number,
    feeBps: number,
    direction: SolanaDirection,
    amountIn: bigint,
    minAmountOut: bigint,
    options: Hex
  ): Promise<{ instructions: TransactionInstruction[]; requestId: bigint; nativeFee: bigint }> {
    const o = await this.buildOpen(user, direction, amountIn, minAmountOut, options);
    const fee = Buffer.alloc(2);
    fee.writeUInt16LE(feeBps);
    const ix = new TransactionInstruction({
      programId: this.program,
      keys: [
        ...o.baseKeys,
        { pubkey: partnerSigner, isSigner: true, isWritable: false },
        { pubkey: this.partnerAddress(partnerId), isSigner: false, isWritable: false },
        { pubkey: this.feeEscrowAddress(o.requestId), isSigner: false, isWritable: true },
        { pubkey: ataOf(this.feeVault(), o.tokenIn, o.tokenProgram), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...o.remaining,
      ],
      data: Buffer.concat([discriminator("open_request_via_partner"), o.params, fee]),
    });
    return {
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        createAtaIdempotent(user, this.store, o.tokenIn, o.tokenProgram),
        createAtaIdempotent(user, this.feeVault(), o.tokenIn, o.tokenProgram),
        ix,
      ],
      requestId: o.requestId,
      nativeFee: o.nativeFee,
    };
  }

  private lut: AddressLookupTableAccount | null = null;

  /**
   * The deployment's address lookup table for this chain: every account an order names that is
   * the same for all orders, in both directions — programs, mints, the store, escrows, the fee
   * vault's accounts, and the OFT sends' LayerZero accounts. What a production deployment
   * publishes alongside its program ids.
   *
   * Created once by the operator's key (this chain's payer) and recorded under
   * `.crossstock/lut/`, so every process reuses it. A recorded table that no longer exists — local
   * chains restarted — is replaced.
   */
  async lookupTable(): Promise<AddressLookupTableAccount> {
    if (this.lut) return this.lut;
    const conn = this.chain.connection;
    const record = resolve(repoRoot(), ".crossstock", "lut", `${this.deployment.name}.${this.chain.config.key}.json`);
    if (existsSync(record)) {
      const { address } = JSON.parse(readFileSync(record, "utf8")) as { address: string };
      const found = (await conn.getAddressLookupTable(new PublicKey(address))).value;
      if (found) return (this.lut = found);
    }

    // Sample orders in both directions, from a throwaway user and partner, give the full set.
    // The OFT fee quote simulates with the user as fee payer, so the sample user must exist:
    // the operator's own key. It is excluded from the table like any signer.
    const [sampleUser, samplePartner] = [this.chain.payer.publicKey, Keypair.generate().publicKey];
    const perOrder = new Set<string>();
    const keys = new Set<string>();
    for (const dir of [SolanaDirection.Buy, SolanaDirection.Sell]) {
      const { instructions, requestId } = await this.partnerInstructions(
        sampleUser, samplePartner, 1, 0, dir, 1_000_000n, 1n, "0x"
      );
      [this.requestAddress(requestId), this.feeEscrowAddress(requestId), this.partnerAddress(1)].forEach((k) => perOrder.add(k.toBase58()));
      const main = instructions.at(-1)!;
      perOrder.add(main.keys[3].pubkey.toBase58()); // nonce index
      for (const i of instructions) {
        keys.add(i.programId.toBase58());
        for (const k of i.keys) if (!k.isSigner) keys.add(k.pubkey.toBase58());
      }
    }
    for (const side of ["base", "quote"] as const) {
      perOrder.add(ataOf(sampleUser, this.mint(side), this.tokenProgram(side)).toBase58());
    }
    const addresses = [...keys].filter((k) => !perOrder.has(k) && k !== sampleUser.toBase58()).map((k) => new PublicKey(k));

    const payer = this.chain.payer;
    const [create, table] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: await conn.getSlot("finalized"),
    });
    const send = async (ix: TransactionInstruction) => {
      const sig = await conn.sendTransaction(new Transaction().add(ix), [payer]);
      await conn.confirmTransaction(sig, "confirmed");
    };
    await send(create);
    for (let i = 0; i < addresses.length; i += 20) {
      await send(
        AddressLookupTableProgram.extendLookupTable({
          lookupTable: table,
          authority: payer.publicKey,
          payer: payer.publicKey,
          addresses: addresses.slice(i, i + 20),
        })
      );
    }
    // A table's new entries are usable from the slot after they were added.
    const extendedAt = await conn.getSlot("confirmed");
    while ((await conn.getSlot("confirmed")) <= extendedAt) await new Promise((r) => setTimeout(r, 200));
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, JSON.stringify({ address: table.toBase58(), addresses: addresses.length }, null, 2) + "\n");
    this.lut = (await conn.getAddressLookupTable(table)).value!;
    return this.lut;
  }

  /**
   * Everything `open_request` and `open_request_via_partner` share: the request and nonce
   * accounts, the OFT send's accounts, and the encoded `OpenRequestParams`.
   */
  private async buildOpen(
    user: PublicKey,
    direction: SolanaDirection,
    amountIn: bigint,
    minAmountOut: bigint,
    options: Hex
  ) {
    const [tokenIn, tokenOut, inAsset] =
      direction === SolanaDirection.Buy
        ? [this.quoteMint, this.baseMint, this.deployment.assets.quote]
        : [this.baseMint, this.quoteMint, this.deployment.assets.base];

    const requestId = await this.nextRequestId();
    const optionBytes = Buffer.from(options.slice(2), "hex");
    const inOftStore = new PublicKey(inAsset.oftStore);
    const homePeer = Buffer.from(inAsset.peers.find((p) => p.remoteEid === this.deployment.homeChain.eid)!.address.slice(2), "hex");
    const nonceIndex = this.nonceIndexAddress(inOftStore, await this.nextOutboundNonce(inOftStore, homePeer));
    const tokenProgram = this.programForMint(tokenIn);
    const storeEscrow = ataOf(this.store, tokenIn, tokenProgram);
    const homeRelay = toBytes32(this.deployment.homeChain.relay);

    // The messaging fee, quoted as the send will be made: the same path, options, and a
    // composeMsg of the order's size (four ABI words), since a real library prices by size.
    // The user pays it — the program passes it through as the send's `native_fee` cap.
    const { nativeFee } = await oft.quote(
      lzLocal(this.chain).rpc,
      {
        payer: publicKey(user.toBase58()),
        tokenMint: publicKey(tokenIn.toBase58()),
        tokenEscrow: publicKey(inAsset.escrow),
      },
      {
        dstEid: this.deployment.homeChain.eid,
        to: homeRelay,
        amountLd: amountIn,
        minAmountLd: 0n,
        options: optionBytes,
        composeMsg: new Uint8Array(128),
      },
      { oft: publicKey(this.deployment.programs.oft) }
    );

    // The OFT send's accounts, as LayerZero's SDK derives them. Built with the user as payer —
    // the SDK simulates with it, and a PDA cannot pay fees — then account 0, the OFT's token
    // authority, becomes the store: it owns the escrow the input is burned from, and signs for
    // it inside the program. Anything else the libraries name the user for stays the user.
    const oftIx = await oft.send(
      lzLocal(this.chain).rpc,
      {
        payer: createNoopSigner(publicKey(user.toBase58())),
        tokenMint: publicKey(tokenIn.toBase58()),
        tokenEscrow: publicKey(inAsset.escrow),
        tokenSource: publicKey(storeEscrow.toBase58()),
      },
      {
        dstEid: this.deployment.homeChain.eid,
        to: homeRelay,
        amountLd: amountIn,
        minAmountLd: amountIn,
        options: optionBytes,
        nativeFee,
      },
      { oft: publicKey(this.deployment.programs.oft), token: publicKey(tokenProgram.toBase58()) }
    );
    const remaining = toWeb3JsInstruction(oftIx.instruction).keys.map((k, i) =>
      i === 0
        ? { pubkey: this.store, isSigner: false, isWritable: k.isWritable }
        : { ...k, isSigner: k.pubkey.equals(user) }
    );

    const len = Buffer.alloc(4);
    len.writeUInt32LE(optionBytes.length);
    const params = Buffer.concat([
      Buffer.from([direction]),
      u64le(amountIn),
      u64le(minAmountOut),
      len,
      optionBytes,
      u64le(nativeFee),
      u64le(0n), // lz_token_fee
    ]);

    const baseKeys = [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: this.store, isSigner: false, isWritable: true },
      { pubkey: this.requestAddress(requestId), isSigner: false, isWritable: true },
      { pubkey: nonceIndex, isSigner: false, isWritable: true },
      { pubkey: tokenIn, isSigner: false, isWritable: false },
      { pubkey: tokenOut, isSigner: false, isWritable: false },
      { pubkey: ataOf(user, tokenIn, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: storeEscrow, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(this.deployment.programs.oft), isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    return { requestId, nativeFee, tokenIn, tokenProgram, params, baseKeys, remaining };
  }

  /** The native fee an order would pay for its leg home, in lamports. */
  async quoteMessagingFee(user: PublicKey, direction: SolanaDirection, amountIn: bigint, options: Hex): Promise<bigint> {
    return (await this.buildOpen(user, direction, amountIn, 1n, options)).nativeFee;
  }

  /** The OFTs' cross-chain precision, as this store records it. */
  async sharedDecimals(): Promise<number> {
    const d = (await this.chain.connection.getAccountInfo(this.store))!.data;
    return d[8 + 32 + 4 + 32 * 6 + 8 + 1]; // after next_request_id and bump
  }

  // ------------------------------------------------------------------ partners and fees

  partnerAddress(partnerId: number): PublicKey {
    const id = Buffer.alloc(4);
    id.writeUInt32BE(partnerId);
    return PublicKey.findProgramAddressSync([Buffer.from("Partner"), id], this.program)[0];
  }

  feeEscrowAddress(requestId: bigint): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("Fee"), u64be(requestId)], this.program)[0];
  }

  /** A registered partner, or null if the id has never been registered. */
  async getPartner(partnerId: number): Promise<{ signer: PublicKey; feeRecipient: PublicKey; maxFeeBps: number; active: boolean } | null> {
    const info = await this.chain.connection.getAccountInfo(this.partnerAddress(partnerId));
    if (!info) return null;
    const d = info.data;
    // discriminator | partner_id u32 | signer | fee_recipient | max_fee_bps u16 | active u8
    return {
      signer: new PublicKey(d.subarray(12, 44)),
      feeRecipient: new PublicKey(d.subarray(44, 76)),
      maxFeeBps: d.readUInt16LE(76),
      active: d[78] === 1,
    };
  }

  /** The PDA that owns the fee vault's token accounts. */
  feeVault(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("FeeVault")], this.program)[0];
  }

  /** A request's fee escrow, or null if it carried none (an order not placed through a partner). */
  async getFeeEscrow(requestId: bigint): Promise<SolanaFeeEscrow | null> {
    const info = await this.chain.connection.getAccountInfo(this.feeEscrowAddress(requestId));
    if (!info) return null;
    const d = info.data;
    const key = (o: number) => new PublicKey(d.subarray(o, o + 32));
    // discriminator | request_id u64 | partner_id u32 | user | mint | partner_recipient |
    // platform_recipient | partner_fee u64 | platform_fee u64 | state u8
    return {
      partnerId: d.readUInt32LE(16),
      user: key(20),
      mint: key(52),
      partnerRecipient: key(84),
      platformRecipient: key(116),
      partnerFee: d.readBigUInt64LE(148),
      platformFee: d.readBigUInt64LE(156),
      state: d[164] as SolanaFeeState,
    };
  }

  /**
   * Releases a finished request's fees — to the partner and platform if it filled, back to the
   * user otherwise. Permissionless; `payer` only pays for the transaction and any token
   * accounts it creates.
   */
  async settleFees(payer: Keypair, requestId: bigint): Promise<string> {
    const e = await this.getFeeEscrow(requestId);
    if (!e) throw new Error(`request ${requestId} has no fee escrow`);
    const vault = this.feeVault();
    const recipients = [e.partnerRecipient, e.platformRecipient, e.user];
    const tp = this.programForMint(e.mint);
    const keys = [
      { pubkey: this.requestAddress(requestId), isSigner: false, isWritable: false },
      { pubkey: this.feeEscrowAddress(requestId), isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: false },
      { pubkey: e.mint, isSigner: false, isWritable: false },
      { pubkey: ataOf(vault, e.mint, tp), isSigner: false, isWritable: true },
      ...recipients.map((r) => ({ pubkey: ataOf(r, e.mint, tp), isSigner: false, isWritable: true })),
      { pubkey: tp, isSigner: false, isWritable: false },
    ];
    const tx = new Transaction();
    // A recipient that has never held this mint needs its account first. A zero platform
    // recipient is only named when its fee is zero, and then nothing is paid to it.
    for (const r of recipients) {
      if (!r.equals(PublicKey.default)) tx.add(createAtaIdempotent(payer.publicKey, r, e.mint, tp));
    }
    tx.add(new TransactionInstruction({ programId: this.program, keys, data: discriminator("settle_fees") }));
    const sig = await this.chain.connection.sendTransaction(tx, [payer]);
    await this.chain.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  /** Registers a partner, or updates it if already registered. Signed by the store admin. */
  async setPartner(
    admin: Keypair,
    partnerId: number,
    terms: { signer: PublicKey; feeRecipient: PublicKey; maxFeeBps: number; active: boolean }
  ): Promise<string> {
    const partner = this.partnerAddress(partnerId);
    const exists = (await this.chain.connection.getAccountInfo(partner)) !== null;
    const maxFee = Buffer.alloc(2);
    maxFee.writeUInt16LE(terms.maxFeeBps);
    const encoded = Buffer.concat([terms.signer.toBuffer(), terms.feeRecipient.toBuffer(), maxFee, Buffer.from([terms.active ? 1 : 0])]);
    const id = Buffer.alloc(4);
    id.writeUInt32LE(partnerId);
    const ix = exists
      ? new TransactionInstruction({
          programId: this.program,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: false },
            { pubkey: this.store, isSigner: false, isWritable: false },
            { pubkey: partner, isSigner: false, isWritable: true },
          ],
          data: Buffer.concat([discriminator("update_partner"), encoded]),
        })
      : new TransactionInstruction({
          programId: this.program,
          keys: [
            { pubkey: admin.publicKey, isSigner: true, isWritable: true },
            { pubkey: this.store, isSigner: false, isWritable: false },
            { pubkey: partner, isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([discriminator("register_partner"), id, encoded]),
        });
    return this.adminSend(admin, ix);
  }

  async setPartnerRequired(admin: Keypair, required: boolean): Promise<string> {
    return this.adminSend(admin, this.adminIx(admin, "set_partner_required", Buffer.from([required ? 1 : 0])));
  }

  async setPlatformFee(admin: Keypair, bps: number, recipient: PublicKey): Promise<string> {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(bps);
    return this.adminSend(admin, this.adminIx(admin, "set_platform_fee", Buffer.concat([b, recipient.toBuffer()])));
  }

  /** The store's partner settings, read from the fields appended after `oft_program`. */
  async partnerSettings(): Promise<{ partnerRequired: boolean; platformFeeBps: number; platformFeeRecipient: PublicKey }> {
    const d = (await this.chain.connection.getAccountInfo(this.store))!.data;
    // … next_request_id u64 | bump u8 | shared_decimals u8 | oft_program | partner_required u8 | bps u16 | recipient
    const o = 8 + 32 + 4 + 32 * 6 + 8 + 1 + 1 + 32;
    return { partnerRequired: d[o] === 1, platformFeeBps: d.readUInt16LE(o + 1), platformFeeRecipient: new PublicKey(d.subarray(o + 3, o + 35)) };
  }

  private adminIx(admin: Keypair, name: string, args: Buffer): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.program,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.store, isSigner: false, isWritable: true },
      ],
      data: Buffer.concat([discriminator(name), args]),
    });
  }

  private async adminSend(admin: Keypair, ix: TransactionInstruction): Promise<string> {
    const sig = await this.chain.connection.sendTransaction(new Transaction().add(ix), [admin]);
    await this.chain.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }
}

/**
 * A plain OFT transfer from a Solana chain: `amountLd` of an asset from `sender`'s token account
 * to `to` on `dstEid`, with the messaging fee quoted and paid by the sender. What a user does to
 * move tokens between chains — including between two Solana chains.
 */
export async function sendOftFromSolana(
  chain: SolanaChain,
  sender: Keypair,
  asset: { mint: string; escrow: string; tokenProgram?: string },
  oftProgram: string,
  dstEid: number,
  to: Uint8Array,
  amountLd: bigint,
  options: Uint8Array
): Promise<string> {
  const rpc = lzLocal(chain).rpc;
  const params = { dstEid, to, amountLd, minAmountLd: amountLd, options };
  const { nativeFee } = await oft.quote(
    rpc,
    { payer: publicKey(sender.publicKey.toBase58()), tokenMint: publicKey(asset.mint), tokenEscrow: publicKey(asset.escrow) },
    params,
    { oft: publicKey(oftProgram) }
  );
  const ix = await oft.send(
    rpc,
    {
      payer: createNoopSigner(publicKey(sender.publicKey.toBase58())),
      tokenMint: publicKey(asset.mint),
      tokenEscrow: publicKey(asset.escrow),
      tokenSource: publicKey(ataOf(sender.publicKey, new PublicKey(asset.mint), programOf(asset)).toBase58()),
    },
    { ...params, nativeFee },
    { oft: publicKey(oftProgram), token: publicKey(programOf(asset).toBase58()) }
  );
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    toWeb3JsInstruction(ix.instruction)
  );
  const sig = await chain.connection.sendTransaction(tx, [sender]);
  await chain.connection.confirmTransaction(sig, "confirmed");
  return sig;
}
