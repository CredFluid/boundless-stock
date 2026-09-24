/**
 * Recovery operations on a Solana home's `swap_relay`: the counterparts of `SwapRelay.sol`'s
 * `retryReturn` and `cancelStuckInbound`, plus `strand_compose`, which Solana needs and EVM does
 * not (see the program's docs: a failed return cannot be caught on Solana, so stranding is an
 * explicit step rather than a `catch`).
 *
 * Each builds the full account list the program checks — the recorded routes, the endpoint's
 * PDAs — and sends it as a V0 transaction through the relay's lookup table, since these lists
 * do not fit a legacy transaction.
 */
import { createHash } from "node:crypto";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { keccak256 } from "viem";

import type { SolanaChain } from "./chain.js";
import { lzLocal } from "./lz-local.js";
import { relayStoreAddress, type SolanaHomeDeployment } from "./home.js";

const disc = (name: string): Buffer => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u64be = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};
const bytes = (b: Uint8Array) => Buffer.concat([u32le(b.length), Buffer.from(b)]);

/** A compose the Executor could not complete, as the endpoint's `ComposeSent` event names it. */
export interface QueuedCompose {
  from: string;
  to: string;
  guid: Uint8Array;
  index: number;
  message: Uint8Array;
}

interface RouteAccount {
  pubkey: PublicKey;
  isWritable: boolean;
  isPayer: boolean;
}

export class SolanaRelayAdmin {
  readonly program: PublicKey;
  readonly store: PublicKey;
  readonly endpoint: PublicKey;

  constructor(readonly chain: SolanaChain, readonly home: SolanaHomeDeployment) {
    this.program = new PublicKey(home.programs.swapRelay);
    this.store = relayStoreAddress(this.program);
    this.endpoint = chain.endpointProgramId;
  }

  peerAddress(eid: number): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("Peer"), u32be(eid)], this.program)[0];
  }

  routeAddress(mint: PublicKey, eid: number): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from("Route"), mint.toBuffer(), u32be(eid)], this.program)[0];
  }

  strandedAddress(eid: number, requestId: bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("Stranded"), u32be(eid), u64be(requestId)],
      this.program
    )[0];
  }

  /** The recorded peer: its SwapRequest, return fee cap and return options. */
  async readPeer(eid: number): Promise<{ address: Buffer; maxReturnFee: bigint; returnOptions: Buffer }> {
    const d = (await this.chain.accountInfo(this.peerAddress(eid).toBase58()))!.data;
    const len = d.readUInt32LE(48);
    return { address: d.subarray(8, 40), maxReturnFee: d.readBigUInt64LE(40), returnOptions: d.subarray(52, 52 + len) };
  }

  /** Re-records a peer with a different return fee cap; everything else as it was. */
  async setMaxReturnFee(eid: number, maxReturnFee: bigint): Promise<string> {
    const peer = await this.readPeer(eid);
    return this.send([
      new TransactionInstruction({
        programId: this.program,
        keys: [
          { pubkey: this.chain.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: this.store, isSigner: false, isWritable: false },
          { pubkey: this.peerAddress(eid), isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("set_peer"), u32le(eid), peer.address, u64le(maxReturnFee), bytes(peer.returnOptions)]),
      }),
    ]);
  }

  async readRoute(address: PublicKey): Promise<RouteAccount[]> {
    const d = (await this.chain.accountInfo(address.toBase58()))!.data;
    const n = d.readUInt32LE(8 + 32 + 4);
    const out: RouteAccount[] = [];
    for (let i = 0, o = 8 + 32 + 4 + 4; i < n; i++, o += 34) {
      out.push({ pubkey: new PublicKey(d.subarray(o, o + 32)), isWritable: d[o + 32] === 1, isPayer: d[o + 33] === 1 });
    }
    return out;
  }

  /** A recorded route's accounts, with the fee payer filled in as this chain's payer. */
  private async routeMetas(address: PublicKey): Promise<AccountMeta[]> {
    return (await this.readRoute(address)).map((a) =>
      a.isPayer
        ? { pubkey: this.chain.payer.publicKey, isSigner: true, isWritable: true }
        : { pubkey: a.pubkey, isSigner: false, isWritable: a.isWritable }
    );
  }

  private noticeRoute(eid: number): PublicKey {
    return this.routeAddress(PublicKey.default, eid);
  }

  /**
   * Consumes a compose whose return cannot be sent, holds its input on this chain, and sends
   * the mirror a STRANDED notice.
   */
  async strandCompose(compose: QueuedCompose, noticeOptions: Uint8Array, maxNoticeFee: bigint): Promise<{ eid: number; requestId: bigint; signature: string }> {
    const msg = Buffer.from(compose.message);
    // ComposeFrame: nonce 8 | src_eid 4 | amount_ld 8 | compose_from 32 | order (request id is
    // its first ABI word, right-aligned).
    const eid = msg.readUInt32BE(8);
    const requestId = msg.readBigUInt64BE(52 + 24);
    const from = new PublicKey(compose.from);
    const to = new PublicKey(compose.to);
    const composed = new PublicKey(
      lzLocal(this.chain)
        .endpoint.pda.composedMessage(
          publicKey(compose.from),
          compose.guid,
          compose.index,
          publicKey(compose.to),
          Buffer.from(keccak256(msg).slice(2), "hex")
        )[0]
        .toString()
    );
    const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], this.endpoint);

    const data = Buffer.concat([
      disc("strand_compose"),
      u32le(eid),
      u64le(requestId),
      from.toBuffer(),
      to.toBuffer(),
      Buffer.from(compose.guid),
      u16le(compose.index),
      bytes(msg),
      bytes(new Uint8Array()), // extra_data
      bytes(noticeOptions),
      u64le(maxNoticeFee),
    ]);
    const keys: AccountMeta[] = [
      { pubkey: this.chain.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.store, isSigner: false, isWritable: false },
      { pubkey: this.peerAddress(eid), isSigner: false, isWritable: false },
      { pubkey: this.strandedAddress(eid, requestId), isSigner: false, isWritable: true },
      { pubkey: this.noticeRoute(eid), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(this.home.assets.base.mint), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(this.home.assets.quote.mint), isSigner: false, isWritable: false },
      { pubkey: this.endpoint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // clear_compose, as the endpoint derives it
      { pubkey: this.endpoint, isSigner: false, isWritable: false },
      { pubkey: to, isSigner: false, isWritable: false },
      { pubkey: composed, isSigner: false, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: this.endpoint, isSigner: false, isWritable: false },
      ...(await this.routeMetas(this.noticeRoute(eid))),
    ];
    const signature = await this.send([new TransactionInstruction({ programId: this.program, keys, data })]);
    return { eid, requestId, signature };
  }

  /** Sends a stranded amount back to its mirror as a refund. Anyone may; the payer pays the fee. */
  async retryReturn(eid: number, requestId: bigint): Promise<string> {
    const strandedAddr = this.strandedAddress(eid, requestId);
    const d = (await this.chain.accountInfo(strandedAddr.toBase58()))?.data;
    if (!d) throw new Error(`nothing stranded for request ${requestId} from eid ${eid}`);
    // Stranded: disc 8 | eid 4 | request_id 8 | mint 32 | amount 8 | amount_sd 8 | recipient 32 | rent_payer 32
    const mint = new PublicKey(d.subarray(20, 52));
    const rentPayer = new PublicKey(d.subarray(100, 132));
    const route = this.routeAddress(mint, eid);
    const keys: AccountMeta[] = [
      { pubkey: this.store, isSigner: false, isWritable: false },
      { pubkey: this.peerAddress(eid), isSigner: false, isWritable: false },
      { pubkey: strandedAddr, isSigner: false, isWritable: true },
      { pubkey: rentPayer, isSigner: false, isWritable: true },
      { pubkey: route, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(this.home.programs.oft), isSigner: false, isWritable: false },
      ...(await this.routeMetas(route)),
    ];
    return this.send([
      new TransactionInstruction({
        programId: this.program,
        keys,
        data: Buffer.concat([disc("retry_return"), u32le(eid), u64le(requestId)]),
      }),
    ]);
  }

  /**
   * Kills an inbound OFT message to this chain that will never arrive, then sends the mirror a
   * CANCELLED notice so the user's input is re-created there.
   *
   * An unverified message is skipped, which needs its payload-hash account to exist: created
   * here first with `init_verify`, which anyone may call. A verified one is burned.
   */
  async cancelStuckInbound(
    p: { srcEid: number; sender: Uint8Array; oftStore: string; nonce: bigint; payloadHash?: Uint8Array },
    noticeOptions: Uint8Array,
    maxNoticeFee: bigint
  ): Promise<string> {
    const { endpoint } = lzLocal(this.chain);
    const receiver = publicKey(p.oftStore);
    const pk = (x: { toString(): string }) => new PublicKey(x.toString());
    const [payloadHash] = endpoint.pda.payloadHash(receiver, p.srcEid, p.sender, p.nonce);
    const verified = p.payloadHash !== undefined && p.payloadHash.some((b) => b !== 0);

    if (!verified && !(await this.chain.accountInfo(payloadHash.toString()))) {
      const ix = endpoint.initVerify(createNoopSigner(publicKey(this.chain.payer.publicKey.toBase58())), {
        srcEid: p.srcEid,
        sender: p.sender,
        receiver,
        nonce: p.nonce,
      });
      await this.send([toWeb3JsInstruction(ix.instruction)]);
    }

    const kill: AccountMeta[] = [
      { pubkey: this.endpoint, isSigner: false, isWritable: false },
      { pubkey: this.store, isSigner: false, isWritable: false },
      { pubkey: pk(endpoint.pda.oappRegistry(receiver)[0]), isSigner: false, isWritable: false },
      { pubkey: pk(endpoint.pda.nonce(receiver, p.srcEid, p.sender)[0]), isSigner: false, isWritable: !verified },
      ...(verified
        ? []
        : [{ pubkey: pk(endpoint.pda.pendingNonce(receiver, p.srcEid, p.sender)[0]), isSigner: false, isWritable: true }]),
      { pubkey: pk(payloadHash), isSigner: false, isWritable: true },
      { pubkey: pk(endpoint.pda.setting()[0]), isSigner: false, isWritable: true },
      { pubkey: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], this.endpoint)[0], isSigner: false, isWritable: false },
      { pubkey: this.endpoint, isSigner: false, isWritable: false },
    ];
    const keys: AccountMeta[] = [
      { pubkey: this.chain.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: this.store, isSigner: false, isWritable: false },
      { pubkey: this.peerAddress(p.srcEid), isSigner: false, isWritable: false },
      { pubkey: this.noticeRoute(p.srcEid), isSigner: false, isWritable: false },
      { pubkey: this.endpoint, isSigner: false, isWritable: false },
      ...kill,
      ...(await this.routeMetas(this.noticeRoute(p.srcEid))),
    ];
    const data = Buffer.concat([
      disc("cancel_stuck_inbound"),
      u32le(p.srcEid),
      Buffer.from(p.sender),
      new PublicKey(p.oftStore).toBuffer(),
      u64le(p.nonce),
      Buffer.from(verified ? p.payloadHash! : new Uint8Array(32)),
      bytes(noticeOptions),
      u64le(maxNoticeFee),
    ]);
    return this.send([new TransactionInstruction({ programId: this.program, keys, data })]);
  }

  /**
   * Whether an inbound message could still be verified — i.e. whether `init_verify`, the first
   * step of any delivery, would be accepted for it. False for a message this relay has killed.
   */
  async isVerifiable(p: { srcEid: number; sender: Uint8Array; oftStore: string; nonce: bigint }): Promise<boolean> {
    const { endpoint } = lzLocal(this.chain);
    const ix = endpoint.initVerify(createNoopSigner(publicKey(this.chain.payer.publicKey.toBase58())), {
      srcEid: p.srcEid,
      sender: p.sender,
      receiver: publicKey(p.oftStore),
      nonce: p.nonce,
    });
    const { blockhash } = await this.chain.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: this.chain.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [toWeb3JsInstruction(ix.instruction)],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([this.chain.payer]);
    const sim = await this.chain.connection.simulateTransaction(tx, { commitment: "confirmed" });
    return sim.value.err === null;
  }

  /** V0 through the relay's lookup table: these account lists do not fit a legacy transaction. */
  private async send(ixs: TransactionInstruction[]): Promise<string> {
    const conn = this.chain.connection;
    const table = this.home.relay?.alt ? (await conn.getAddressLookupTable(new PublicKey(this.home.relay.alt))).value : null;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: this.chain.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs],
    }).compileToV0Message(table ? [table] : []);
    const tx = new VersionedTransaction(message);
    tx.sign([this.chain.payer]);
    const sig = await conn.sendTransaction(tx);
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Solana transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }
}
