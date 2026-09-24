/**
 * The Solana side of the local relayer.
 *
 * Does for a local Solana validator what `infra/relayer.ts` does for anvil: stands in for
 * LayerZero's DVN and Executor. Three steps, the same three as on EVM:
 *
 *   1. observe `PacketSent` — on Solana an Anchor event CPI inside the transaction, not a log
 *      topic, so it is read out of each endpoint transaction's inner instructions;
 *   2. verify — `init_verify`, then `simple-messagelib::validate_packet`, which CPIs the
 *      endpoint's `verify` exactly as a DVN-backed library would;
 *   3. execute — ask the receiver which instructions and accounts a delivery needs
 *      (`lz_receive_types*`), run them, then do the same for every compose the delivery queued.
 *
 * Step 3 uses LayerZero's own Executor helpers from the SDK (`lzReceive`, `lzCompose`), which
 * detect the receiver's planning version and build the transaction. So a program that plans a
 * delivery wrongly fails here the way it would fail under LayerZero's real Executor.
 *
 * Only for a local validator. On devnet and mainnet LayerZero's own infrastructure delivers.
 */
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createNoopSigner, publicKey, type Instruction as UmiInstruction } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction, toWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import {
  extractComposeSentEventByTxHash,
  extractPacketSentEventByTxHash,
  lzCompose,
  lzReceive,
} from "@layerzerolabs/lz-solana-sdk-v2/umi";
import type { Hex } from "viem";

import type { SolanaChain } from "./chain.js";
import { ENDPOINT_PROGRAM_ID, lzLocal } from "./lz-local.js";
import { decodePacket } from "../relayer.js";
import { log } from "../lib/logger.js";

/** Headroom for `lz_receive` + `lz_compose`, which create token accounts and CPI deeply. */
const COMPUTE_UNITS = 1_400_000;

export interface OutboundPacket {
  encodedPacket: Hex;
  options: Hex;
}

const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

export class SolanaRelayEndpoint {
  /** Newest endpoint transaction already scanned. */
  private cursor?: string;
  private readonly endpointProgram = new PublicKey(ENDPOINT_PROGRAM_ID);

  constructor(readonly chain: SolanaChain) {}

  get eid(): number {
    return this.chain.eid;
  }

  /** Starts from now, ignoring every endpoint transaction already on chain. */
  async syncToHead(): Promise<void> {
    const [latest] = await this.chain.connection.getSignaturesForAddress(this.endpointProgram, { limit: 1 });
    this.cursor = latest?.signature;
  }

  /** `PacketSent` events since the last scan, oldest first. */
  async scanOutbound(): Promise<OutboundPacket[]> {
    const sigs = await this.chain.connection.getSignaturesForAddress(
      this.endpointProgram,
      { until: this.cursor, limit: 1000 },
      "confirmed"
    );
    if (sigs.length === 0) return [];
    this.cursor = sigs[0].signature;

    const out: OutboundPacket[] = [];
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      const events = await extractPacketSentEventByTxHash(
        lzLocal(this.chain).rpc,
        this.endpointProgram,
        s.signature,
        { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
      );
      for (const e of events ?? []) out.push({ encodedPacket: hex(e.encodedPacket), options: hex(e.options) });
    }
    return out;
  }

  /**
   * Verifies and executes one packet addressed to this chain, then every compose it queued.
   * Returns how many composes ran.
   */
  async deliver(encodedPacket: Hex): Promise<number> {
    const packet = decodePacket(encodedPacket);
    const { endpoint, messageLib, rpc } = lzLocal(this.chain);
    const payer = createNoopSigner(publicKey(this.chain.payer.publicKey.toBase58()));
    const receiver = publicKey(Buffer.from(packet.receiver.slice(2), "hex"));

    // Step 2 — verification: the payload-hash account must exist before `verify` writes it.
    const [payloadHash] = endpoint.pda.payloadHash(
      receiver,
      packet.srcEid,
      Buffer.from(packet.sender.slice(2), "hex"),
      Number(packet.nonce)
    );
    const verifyIxs: UmiInstruction[] = [];
    if (!(await this.chain.accountInfo(payloadHash.toString()))) {
      verifyIxs.push(
        endpoint.initVerify(payer, {
          srcEid: packet.srcEid,
          sender: Buffer.from(packet.sender.slice(2), "hex"),
          receiver,
          nonce: packet.nonce,
        }).instruction
      );
    }
    verifyIxs.push(messageLib.validatePacket(payer, Buffer.from(encodedPacket.slice(2), "hex")).instruction);
    await this.send(verifyIxs.map((i) => toWeb3JsInstruction(i)));

    // Step 3 — execution, planned by the receiver itself.
    const receipt = await this.execute(
      await lzReceive(rpc, payer.publicKey, {
        srcEid: packet.srcEid,
        sender: packet.sender,
        receiver: packet.receiver,
        guid: packet.guid,
        message: packet.message,
        nonce: packet.nonce.toString(),
      })
    );
    log.dim(`packet ${packet.srcEid}→${packet.dstEid} nonce ${packet.nonce} delivered on Solana`);

    let composed = 0;
    const composes = await extractComposeSentEventByTxHash(rpc, this.endpointProgram, receipt, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    for (const c of composes ?? []) {
      await this.execute(await lzCompose(rpc, payer.publicKey, c));
      log.dim(`compose index ${c.index} executed on ${c.to}`);
      composed++;
    }
    return composed;
  }

  /** Runs either shape the SDK's Executor helpers return: one V1 instruction, or a V2 plan. */
  private async execute(
    plan:
      | { instruction: UmiInstruction; contextVersion: number }
      | { instructions: UmiInstruction[]; signers: { secretKey: Uint8Array; publicKey: string }[]; addressLookupTables: unknown[] }
  ): Promise<string> {
    if ("instruction" in plan) return this.send([toWeb3JsInstruction(plan.instruction)]);
    const extra = plan.signers.map((s) => toWeb3JsKeypair(s as never));
    // A plan that names more accounts than a transaction can list carries lookup tables; the
    // relay's return leg is the case in point. Resolved from the chain, as an Executor would.
    const tables: AddressLookupTableAccount[] = [];
    for (const t of plan.addressLookupTables as { publicKey: string }[]) {
      const table = (await this.chain.connection.getAddressLookupTable(new PublicKey(t.publicKey))).value;
      if (!table) throw new Error(`lookup table ${t.publicKey} named by the plan does not exist`);
      tables.push(table);
    }
    return this.send(
      plan.instructions.map((i) => toWeb3JsInstruction(i)),
      extra,
      tables
    );
  }

  private async send(
    ixs: TransactionInstruction[],
    extraSigners: ReturnType<typeof toWeb3JsKeypair>[] = [],
    tables: AddressLookupTableAccount[] = []
  ): Promise<string> {
    const conn = this.chain.connection;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: this.chain.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }), ...ixs],
    }).compileToV0Message(tables);
    const tx = new VersionedTransaction(message);
    tx.sign([this.chain.payer, ...extraSigners]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`Solana transaction ${sig} failed: ${JSON.stringify(res.value.err)}`);
    return sig;
  }
}
