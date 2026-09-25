import { createHash } from "node:crypto";
import { PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";
import type { Side } from "./types.js";

/** Anchor's discriminator for `open_request_via_partner`: sha256("global:open_request_via_partner")[..8]. */
const DISCRIMINATOR = createHash("sha256").update("global:open_request_via_partner").digest().subarray(0, 8);

export interface SolanaOrderToAuthorize {
  /** The `swap_request` program, from the deployment descriptor. */
  program: string;
  user: string;
  side: Side;
  amountIn: string;
  /** If set, the order's floor must be at least this. */
  minAmountOut?: string;
  feeBps: number;
}

export interface DecodedPartnerOrder {
  side: Side;
  amountIn: bigint;
  minAmountOut: bigint;
  feeBps: number;
  feePayer: string;
}

/**
 * Reads the order out of a partner-order transaction, without trusting anything about it.
 * Throws unless the transaction contains exactly one call to `program`, and that call is
 * `open_request_via_partner`.
 */
export function decodePartnerOrder(tx: VersionedTransaction, program: string): DecodedPartnerOrder {
  const keys = tx.message.staticAccountKeys;
  const calls = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex]?.toBase58() === program);
  if (calls.length !== 1) throw new Error(`Expected exactly one call to ${program}, found ${calls.length}.`);
  const data = Buffer.from(calls[0].data);
  if (!data.subarray(0, 8).equals(DISCRIMINATOR)) throw new Error("The call is not open_request_via_partner.");
  let o = 8;
  const direction = data[o++];
  const amountIn = data.readBigUInt64LE(o);
  const minAmountOut = data.readBigUInt64LE(o + 8);
  o += 16;
  const optionsLen = data.readUInt32LE(o);
  o += 4 + optionsLen + 8 + 8; // options, native fee, lz token fee
  if (data.length !== o + 2) throw new Error("Unexpected instruction data length.");
  const feeBps = data.readUInt16LE(o);
  if (direction !== 0 && direction !== 1) throw new Error(`Unknown direction ${direction}.`);
  return { side: direction === 0 ? "buy" : "sell", amountIn, minAmountOut, feeBps, feePayer: keys[0].toBase58() };
}

/**
 * The partner's approval of one order on a Solana mirror: checks the transaction is exactly
 * the order approved, then co-signs it. Run it on the partner's backend, after the partner's own
 * checks (KYC, limits) pass.
 *
 * Never co-sign a transaction you have not decoded: the co-signature is what lets the order in,
 * and a transaction can carry any instruction. This refuses anything but a single
 * `open_request_via_partner` call, paid for by the stated user, for the stated side, amount and
 * fee.
 *
 * @returns The transaction, base64, with the partner's signature added. The user signs it too
 *          (before or after) and sends it.
 */
export function authorizeSolanaOrder(transaction: string, partner: Keypair, expected: SolanaOrderToAuthorize): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  const got = decodePartnerOrder(tx, expected.program);
  const mismatch = (what: string, a: unknown, b: unknown) => new Error(`${what} is ${a}, expected ${b}.`);
  if (got.feePayer !== new PublicKey(expected.user).toBase58()) throw mismatch("The fee payer (user)", got.feePayer, expected.user);
  if (got.side !== expected.side) throw mismatch("The side", got.side, expected.side);
  if (got.amountIn !== BigInt(expected.amountIn)) throw mismatch("amountIn", got.amountIn, expected.amountIn);
  if (got.feeBps !== expected.feeBps) throw mismatch("The fee", got.feeBps, expected.feeBps);
  if (expected.minAmountOut !== undefined && got.minAmountOut < BigInt(expected.minAmountOut)) {
    throw mismatch("minAmountOut", got.minAmountOut, `at least ${expected.minAmountOut}`);
  }
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map((k) => k.toBase58());
  if (!signers.includes(partner.publicKey.toBase58())) throw new Error("This transaction does not ask for the partner's signature.");
  tx.sign([partner]);
  return Buffer.from(tx.serialize()).toString("base64");
}
