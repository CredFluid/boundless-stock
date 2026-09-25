import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashTypedData, recoverAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  CrossStockApi,
  CrossStockApiError,
  PARTNER_ORDER_TYPES,
  authorizeEvmOrder,
  authorizeSolanaOrder,
  decodePartnerOrder,
  signWebhook,
  verifyWebhook,
} from "./index.js";

// ---------------------------------------------------------------------------- EVM

const mirror = {
  eip712: { name: "CrossStock SwapRequest", version: "1", chainId: 421614, verifyingContract: "0x0b306bf915c4d645ff596e518faf3f9669b97016" },
};

test("an EVM authorisation is the partner's EIP-712 signature over exactly the order", async () => {
  const key = generatePrivateKey();
  const user = privateKeyToAccount(generatePrivateKey()).address;
  const order = { user, side: "buy" as const, amountIn: "15000000000", minAmountOut: "99000000000000000000", partnerId: 7, feeBps: 50 };
  const auth = await authorizeEvmOrder(key, mirror, order);

  const digest = hashTypedData({
    domain: { ...mirror.eip712, verifyingContract: mirror.eip712.verifyingContract as Hex },
    types: PARTNER_ORDER_TYPES,
    primaryType: "PartnerOrder",
    message: {
      user,
      direction: 0,
      amountIn: 15_000_000_000n,
      minAmountOut: 99_000_000_000_000_000_000n,
      partnerId: 7,
      feeBps: 50,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
    },
  });
  assert.equal(await recoverAddress({ hash: digest, signature: auth.signature as Hex }), privateKeyToAccount(key).address);
  assert.ok(BigInt(auth.deadline) > BigInt(Math.floor(Date.now() / 1000)), "defaults to a future deadline");

  const again = await authorizeEvmOrder(key, mirror, order);
  assert.notEqual(again.nonce, auth.nonce, "each authorisation gets its own nonce");
});

// ---------------------------------------------------------------------------- Solana

const program = Keypair.generate().publicKey;
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

function orderData(direction: number, amountIn: bigint, minOut: bigint, feeBps: number, name = "open_request_via_partner"): Buffer {
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const options = Buffer.from([0, 3, 1, 2]);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(options.length);
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(feeBps);
  return Buffer.concat([disc(name), Buffer.from([direction]), u64(amountIn), u64(minOut), len, options, u64(5000n), u64(0n), fee]);
}

function partnerTx(user: PublicKey, partner: PublicKey, data: Buffer, extra: TransactionInstruction[] = []): string {
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: partner, isSigner: true, isWritable: false },
    ],
    data,
  });
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ix, ...extra],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

const expected = (user: PublicKey) => ({
  program: program.toBase58(),
  user: user.toBase58(),
  side: "buy" as const,
  amountIn: "15000000000",
  minAmountOut: "90000000000",
  feeBps: 50,
});

test("the partner co-signs a transaction that is exactly the approved order", () => {
  const [user, partner] = [Keypair.generate(), Keypair.generate()];
  const tx = partnerTx(user.publicKey, partner.publicKey, orderData(0, 15_000_000_000n, 95_000_000_000n, 50));
  const signed = VersionedTransaction.deserialize(Buffer.from(authorizeSolanaOrder(tx, partner, expected(user.publicKey)), "base64"));
  const at = signed.message.staticAccountKeys.findIndex((k) => k.equals(partner.publicKey));
  assert.ok(signed.signatures[at].some((b) => b !== 0), "partner's signature is present");
  assert.ok(signed.signatures[0].every((b) => b === 0), "the user's slot is left for the user");
  const got = decodePartnerOrder(signed, program.toBase58());
  assert.deepEqual([got.side, got.amountIn, got.feeBps], ["buy", 15_000_000_000n, 50]);
});

test("the partner refuses anything but the approved order", () => {
  const [user, partner] = [Keypair.generate(), Keypair.generate()];
  const refuse = (tx: string, why: RegExp, exp = expected(user.publicKey)) =>
    assert.throws(() => authorizeSolanaOrder(tx, partner, exp), why);

  refuse(partnerTx(user.publicKey, partner.publicKey, orderData(0, 16_000_000_000n, 95_000_000_000n, 50)), /amountIn/);
  refuse(partnerTx(user.publicKey, partner.publicKey, orderData(1, 15_000_000_000n, 95_000_000_000n, 50)), /side/);
  refuse(partnerTx(user.publicKey, partner.publicKey, orderData(0, 15_000_000_000n, 95_000_000_000n, 100)), /fee/);
  refuse(partnerTx(user.publicKey, partner.publicKey, orderData(0, 15_000_000_000n, 1n, 50)), /minAmountOut/);
  const stranger = Keypair.generate().publicKey;
  refuse(partnerTx(stranger, partner.publicKey, orderData(0, 15_000_000_000n, 95_000_000_000n, 50)), /fee payer/);
  refuse(partnerTx(user.publicKey, partner.publicKey, orderData(0, 15_000_000_000n, 95_000_000_000n, 50, "open_request")), /not open_request_via_partner/);
  // A second order smuggled into the same transaction.
  const second = new TransactionInstruction({ programId: program, keys: [], data: orderData(0, 1n, 1n, 50) });
  refuse(partnerTx(user.publicKey, partner.publicKey, orderData(0, 15_000_000_000n, 95_000_000_000n, 50), [second]), /exactly one/);
  // Not asked to sign at all.
  const other = Keypair.generate().publicKey;
  refuse(partnerTx(user.publicKey, other, orderData(0, 15_000_000_000n, 95_000_000_000n, 50)), /does not ask/);
  // Unrelated instructions alongside are allowed (the API adds compute budget and ATA creation).
  const transfer = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: stranger, lamports: 1 });
  assert.doesNotThrow(() =>
    authorizeSolanaOrder(partnerTx(user.publicKey, partner.publicKey, orderData(0, 15_000_000_000n, 95_000_000_000n, 50), [transfer]), partner, expected(user.publicKey))
  );
});

// ---------------------------------------------------------------------------- webhooks

test("a webhook verifies only with its own body, secret and a fresh timestamp", () => {
  const body = JSON.stringify({ id: "evt_1", type: "order.filled", createdAt: "now", order: { id: "3" } });
  const header = signWebhook(body, "s3cret");
  assert.equal(verifyWebhook(body, header, "s3cret").id, "evt_1");
  assert.throws(() => verifyWebhook(body.replace("3", "4"), header, "s3cret"), /does not match/);
  assert.throws(() => verifyWebhook(body, header, "other"), /does not match/);
  assert.throws(() => verifyWebhook(body, signWebhook(body, "s3cret", Math.floor(Date.now() / 1000) - 3600), "s3cret"), /tolerance/);
  assert.throws(() => verifyWebhook(body, undefined, "s3cret"), /Missing/);
});

// ---------------------------------------------------------------------------- API client

test("the API client sends the key and surfaces error codes", async () => {
  const seen: { url: string; key?: string }[] = [];
  const fake: typeof fetch = async (url, init) => {
    seen.push({ url: String(url), key: (init?.headers as Record<string, string>)["x-api-key"] });
    return String(url).endsWith("/quote")
      ? new Response(JSON.stringify({ error: { code: "partner_required", message: "needs a partner" } }), { status: 400 })
      : new Response(JSON.stringify({ name: "d" }), { status: 200 });
  };
  const api = new CrossStockApi({ baseUrl: "https://x.test/", apiKey: "k1", fetch: fake });
  assert.equal((await api.deployment("d")).name, "d");
  await assert.rejects(api.quote({ deployment: "d", chain: "c", side: "buy", amountIn: "1" }), (e: unknown) => {
    assert.ok(e instanceof CrossStockApiError);
    assert.equal(e.code, "partner_required");
    assert.equal(e.status, 400);
    return true;
  });
  assert.equal(seen[0].url, "https://x.test/api/v1/deployments/d");
  assert.equal(seen[0].key, "k1");
});
