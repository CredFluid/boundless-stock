/**
 * A user-side client for CrossStock on a Solana mirror chain.
 *
 * The Solana counterpart to calling `SwapRequest.buy()` / `sell()` with viem. Most of the work
 * is accounts: `open_request` forwards LayerZero's OFT `send` by CPI, so the transaction must
 * carry every account that send — and the endpoint and message library beneath it — will
 * touch. Those are derived with LayerZero's own OFT SDK rather than listed by hand.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  Keypair,
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
import { solanaManifestPath, type SolanaDeployment } from "./setup.js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
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
}

export const ataOf = (owner: PublicKey, mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

/** `CreateIdempotent`: creates the associated token account if missing, else does nothing. */
export const createAtaIdempotent = (payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction =>
  new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
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

  /** A holder's balance of one asset, in this chain's local decimals. Zero if no account yet. */
  async balance(owner: PublicKey, side: "base" | "quote"): Promise<bigint> {
    const ata = ataOf(owner, this.mint(side));
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
    o += 24 + 16; // amounts, created_at, settled_at
    const status = d[o] as SolanaStatus;
    const failureReason = d[o + 1];
    const lzNonce = d.readBigUInt64LE(o + 3); // after status, failure_reason, bump
    return { user, direction, amountIn, minAmountOut, amountOut, status, failureReason, lzNonce };
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
    const [tokenIn, tokenOut, inAsset] =
      direction === SolanaDirection.Buy
        ? [this.quoteMint, this.baseMint, this.deployment.assets.quote]
        : [this.baseMint, this.quoteMint, this.deployment.assets.base];

    const requestId = await this.nextRequestId();
    const optionBytes = Buffer.from(options.slice(2), "hex");
    const inOftStore = new PublicKey(inAsset.oftStore);
    const homePeer = Buffer.from(inAsset.peers.find((p) => p.remoteEid === this.deployment.homeChain.eid)!.address.slice(2), "hex");
    const nonceIndex = this.nonceIndexAddress(inOftStore, await this.nextOutboundNonce(inOftStore, homePeer));
    const storeEscrow = ataOf(this.store, tokenIn);
    const homeRelay = Buffer.from(this.deployment.homeChain.relay.slice(2).padStart(64, "0"), "hex");

    // The messaging fee, quoted as the send will be made: the same path, options, and a
    // composeMsg of the order's size (four ABI words), since a real library prices by size.
    // The user pays it — the program passes it through as the send's `native_fee` cap.
    const { nativeFee } = await oft.quote(
      lzLocal(this.chain).rpc,
      {
        payer: publicKey(user.publicKey.toBase58()),
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
        payer: createNoopSigner(publicKey(user.publicKey.toBase58())),
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
      { oft: publicKey(this.deployment.programs.oft) }
    );
    const remaining = toWeb3JsInstruction(oftIx.instruction).keys.map((k, i) =>
      i === 0
        ? { pubkey: this.store, isSigner: false, isWritable: k.isWritable }
        : { ...k, isSigner: k.pubkey.equals(user.publicKey) }
    );

    const len = Buffer.alloc(4);
    len.writeUInt32LE(optionBytes.length);
    const data = Buffer.concat([
      discriminator("open_request"),
      Buffer.from([direction]),
      u64le(amountIn),
      u64le(minAmountOut),
      len,
      optionBytes,
      u64le(nativeFee),
      u64le(0n), // lz_token_fee
    ]);

    const ix = new TransactionInstruction({
      programId: this.program,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: this.store, isSigner: false, isWritable: true },
        { pubkey: this.requestAddress(requestId), isSigner: false, isWritable: true },
        { pubkey: nonceIndex, isSigner: false, isWritable: true },
        { pubkey: tokenIn, isSigner: false, isWritable: false },
        { pubkey: tokenOut, isSigner: false, isWritable: false },
        { pubkey: ataOf(user.publicKey, tokenIn), isSigner: false, isWritable: true },
        { pubkey: storeEscrow, isSigner: false, isWritable: true },
        { pubkey: new PublicKey(this.deployment.programs.oft), isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...remaining,
      ],
      data,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      createAtaIdempotent(user.publicKey, this.store, tokenIn),
      ix
    );
    const signature = await this.chain.connection.sendTransaction(tx, [user]);
    await this.chain.connection.confirmTransaction(signature, "confirmed");
    return { requestId, signature, nativeFee };
  }
}
