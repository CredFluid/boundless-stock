/**
 * SCENARIO 11 — a partner integration, end to end, through the SDK and the partner API.
 *
 * The same `infra/api` functions the HTTP routes call, driven the way a partner would: quote,
 * authorise with the SDK, build, have the user sign and send, track, and receive webhooks.
 *
 *   EVM mirror
 *     a. the descriptor shows the mirror, its EIP-712 domain, and that partners are required
 *     b. a quote without a partner is refused (partner_required)
 *     c. quote → authorizeEvmOrder → buildOrder → the user sends → the order fills, delivering
 *        EXACTLY the quoted amount
 *     d. an authorisation for a different amount is refused before the user pays gas
 *   Solana mirror (when the deployment has one)
 *     e. quote → buildOrder → authorizeSolanaOrder → the user signs → fills with EXACTLY the
 *        quoted amount
 *     f. the SDK refuses to co-sign a transaction that is not the approved order
 *   Both
 *     g. each fill reaches the partner's webhook once, signed, and verifies with the SDK
 *     h. the user's order list includes them
 *
 * Exactness is the point of (c) and (e): the quote asks the market itself (an eth_call of the
 * real pool swap, or Orca's quote of the live Whirlpool) and follows the order's path through
 * fees and the bridge's precision, so with nothing else trading in between it must match to
 * the unit.
 */
import { createServer, type Server } from "node:http";
import { parseEther, parseUnits, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  authorizeEvmOrder,
  authorizeSolanaOrder,
  orderIdFromLogs,
  verifyWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  type EvmMirror,
  type SolanaMirror,
  type WebhookEvent,
} from "@crossstock/sdk";

import type { Harness, ScenarioResult } from "./harness.js";
import { ApiError, buildOrder, contextFromConfig, describe, getOrder, listOrders, quote, resetApiContexts } from "../api/index.js";
import { webhookPass } from "../webhooks.js";
import { PARTNER_ABI } from "../lib/partners.js";
import { log } from "../lib/logger.js";

const NAME = "11. Partner SDK and API (exact quotes, authorise, build, track, webhooks)";
const PARTNER_ID = 901;
const FEE_BPS = 25;
const SECRET_ENV = "CROSSSTOCK_SCENARIO11_WEBHOOK_SECRET";

export async function scenario11(h: Harness): Promise<ScenarioResult> {
  log.banner("Scenario 11 — a partner integration through the SDK and API");
  const findings: string[] = [];
  const metrics: Record<string, string | number> = {};
  resetApiContexts();
  const ctx = contextFromConfig(h.config);

  // The partner's webhook endpoint: verifies every delivery with the SDK, as a partner would.
  const secret = `whsec_${Date.now()}`;
  process.env[SECRET_ENV] = secret;
  const received: WebhookEvent[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        received.push(verifyWebhook(body, req.headers[WEBHOOK_SIGNATURE_HEADER] as string, secret));
        res.writeHead(200).end();
      } catch (e) {
        findings.push(`a webhook failed verification: ${(e as Error).message}`);
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  // Partner keys, per VM, registered on every mirror for the duration.
  const partnerKey = generatePrivateKey();
  const partnerEvm = privateKeyToAccount(partnerKey).address;
  const partnerSol = Keypair.generate();
  const treasury = privateKeyToAccount(generatePrivateKey()).address;
  const hooks = {
    ...h.config,
    partners: {
      partners: [{ id: PARTNER_ID, name: "Scenario 11", maxFeeBps: 100, webhook: { url: `http://127.0.0.1:${port}/hooks`, secretEnv: SECRET_ENV } }],
    },
  };
  // Mark every order already in the history as seen, so only this scenario's orders are announced.
  await webhookPass(hooks);

  const mirror = h.mirrorKeys[0];
  const owner = h.chain(mirror);
  const request = h.addr(mirror, "SwapRequest");
  const priorEvm = await owner.read<boolean>(request, PARTNER_ABI, "partnerRequired");
  await owner.write(request, PARTNER_ABI, "setPartner", [PARTNER_ID, partnerEvm, treasury, 100, true]);
  await owner.write(request, PARTNER_ABI, "setPartnerRequired", [true]);
  const sol = h.solana[0];
  const priorSol = sol ? await sol.partnerSettings() : undefined;
  if (sol) {
    await sol.setPartner(sol.chain.payer, PARTNER_ID, { signer: partnerSol.publicKey, feeRecipient: Keypair.generate().publicKey, maxFeeBps: 100, active: true });
    await sol.setPartnerRequired(sol.chain.payer, true);
  }

  try {
    // ---------------------------------------------------------------- EVM
    const user = h.user(mirror);
    const where = h.name(mirror);
    const d = await describe(ctx);
    const m = d.mirrors.find((x) => x.key === mirror) as EvmMirror | undefined;
    log.step(`a. descriptor for ${d.name}: ${d.mirrors.length} mirror(s)`);
    if (!m || m.vm !== "evm") findings.push(`descriptor lacks EVM mirror ${mirror}`);
    else {
      if (!m.partnerRequired) findings.push(`descriptor says ${where} does not require partners`);
      if (m.eip712.verifyingContract.toLowerCase() !== request.toLowerCase()) findings.push("descriptor's EIP-712 domain names the wrong contract");
      log.ok(`${where}: SwapRequest ${m.swapRequest}, partners required`);
    }

    log.step("b. a quote without a partner is refused");
    const spend = parseUnits("12000", h.quoteDecimals);
    try {
      await quote(ctx, { deployment: d.name, chain: mirror, side: "buy", amountIn: spend.toString() });
      findings.push("a quote without a partner went through on a gated mirror");
    } catch (e) {
      if (e instanceof ApiError && e.code === "partner_required") log.ok("refused: partner_required");
      else findings.push(`unexpected error for a partnerless quote: ${(e as Error).message}`);
    }

    log.step("c. quote → authorise (SDK) → build → user sends → fills at exactly the quote");
    await h.ensureUserFunded(mirror, spend * 2n, "QuoteAsset");
    const q = await quote(ctx, { deployment: d.name, chain: mirror, side: "buy", amountIn: spend.toString(), partnerId: PARTNER_ID, partnerFeeBps: FEE_BPS });
    log.kv("quoted", `${h.fmtToken(BigInt(q.expectedAmountOut))} (min ${h.fmtToken(BigInt(q.minAmountOut))}), impact ${q.priceImpactBps} bps`);
    log.kv("fees", `partner ${h.fmtQuote(BigInt(q.fees.partner))}, platform ${h.fmtQuote(BigInt(q.fees.platform))}`);
    const authorization = await authorizeEvmOrder(partnerKey, m!, {
      user: user.account.address, side: "buy", amountIn: q.amountIn, minAmountOut: q.minAmountOut, partnerId: PARTNER_ID, feeBps: FEE_BPS,
    });
    const built = await buildOrder(ctx, {
      deployment: d.name, chain: mirror, side: "buy", user: user.account.address, amountIn: q.amountIn,
      minAmountOut: q.minAmountOut, partnerId: PARTNER_ID, partnerFeeBps: FEE_BPS, authorization,
    });
    if (built.vm !== "evm") throw new Error("expected an EVM build");
    let orderId = "";
    for (const t of built.transactions) {
      const hash = await user.walletClient.sendTransaction({
        account: user.account, chain: user.walletClient.chain, to: t.to as Address, data: t.data as Hex, value: BigInt(t.value),
      });
      const receipt = await user.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") findings.push(`"${t.description}" reverted`);
      if (t.to.toLowerCase() === request.toLowerCase()) orderId = orderIdFromLogs(receipt.logs, request);
    }
    log.kv("transactions", built.transactions.map((t) => t.description).join(" → "));
    await h.waitFor(`order ${orderId} to settle`, async () => (await getOrder(ctx, mirror, orderId)).status !== "pending");
    const filled = await getOrder(ctx, mirror, orderId);
    log.kv("status", `${filled.status} — ${filled.next}`);
    if (filled.status !== "filled") findings.push(`EVM partner order settled ${filled.status}`);
    if (filled.amountOut !== q.expectedAmountOut) {
      findings.push(`EVM fill ${filled.amountOut} ≠ quote ${q.expectedAmountOut} (off by ${BigInt(filled.amountOut) - BigInt(q.expectedAmountOut)})`);
    } else log.ok(`delivered exactly the quote: ${h.fmtToken(BigInt(filled.amountOut))}`);
    if (filled.fees?.state !== "paid" || filled.fees.partner !== q.fees.partner) findings.push(`EVM fees ${JSON.stringify(filled.fees)} do not match the quote`);
    metrics["EVM quote vs fill"] = filled.amountOut === q.expectedAmountOut ? "exact" : "MISMATCH";

    log.step("d. an authorisation for a different amount is refused before the user pays gas");
    try {
      const other = await authorizeEvmOrder(partnerKey, m!, {
        user: user.account.address, side: "buy", amountIn: (spend + 1n).toString(), minAmountOut: q.minAmountOut, partnerId: PARTNER_ID, feeBps: FEE_BPS,
      });
      await buildOrder(ctx, {
        deployment: d.name, chain: mirror, side: "buy", user: user.account.address, amountIn: q.amountIn,
        minAmountOut: q.minAmountOut, partnerId: PARTNER_ID, partnerFeeBps: FEE_BPS, authorization: other,
      });
      findings.push("buildOrder accepted an authorisation for a different amount");
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_authorization") log.ok("refused: invalid_authorization");
      else findings.push(`unexpected error for a mismatched authorisation: ${(e as Error).message}`);
    }

    // ---------------------------------------------------------------- Solana
    if (sol) {
      const sm = d.mirrors.find((x) => x.vm === "svm") as SolanaMirror;
      const swhere = sm.name;
      log.step(`e. ${swhere}: quote → build → authorise (SDK) → user signs → fills at exactly the quote`);
      const suser = await sol.newUser();
      const qdec = sm.quote.decimals;
      const sspend = parseUnits("12000", qdec);
      await h.bridgeFromHomeTo(sol.eid, `0x${Buffer.from(suser.publicKey.toBytes()).toString("hex")}`, "QuoteAsset", parseUnits("12000", h.quoteDecimals));
      await h.waitFor("USDC to reach the Solana user", async () => (await sol.balance(suser.publicKey, "quote")) >= sspend);
      const sq = await quote(ctx, { deployment: d.name, chain: sm.key, side: "buy", amountIn: sspend.toString(), partnerId: PARTNER_ID, partnerFeeBps: FEE_BPS });
      const sb = await buildOrder(ctx, {
        deployment: d.name, chain: sm.key, side: "buy", user: suser.publicKey.toBase58(), amountIn: sq.amountIn,
        minAmountOut: sq.minAmountOut, partnerId: PARTNER_ID, partnerFeeBps: FEE_BPS,
      });
      if (sb.vm !== "svm") throw new Error("expected a Solana build");
      const expect = { program: sm.program, user: suser.publicKey.toBase58(), side: "buy" as const, amountIn: sq.amountIn, minAmountOut: sq.minAmountOut, feeBps: FEE_BPS };

      log.step("f. the SDK refuses to co-sign anything but the approved order");
      try {
        authorizeSolanaOrder(sb.transaction, partnerSol, { ...expect, amountIn: (sspend - 1n).toString() });
        findings.push("authorizeSolanaOrder co-signed an order for a different amount");
      } catch {
        log.ok("refused a mismatched order");
      }

      const cosigned = authorizeSolanaOrder(sb.transaction, partnerSol, expect);
      const tx = VersionedTransaction.deserialize(Buffer.from(cosigned, "base64"));
      tx.sign([suser]);
      await sol.submit(tx);
      await h.waitFor(`Solana order ${sb.requestId} to settle`, async () => (await getOrder(ctx, sm.key, sb.requestId)).status !== "pending");
      const sf = await getOrder(ctx, sm.key, sb.requestId);
      log.kv("status", `${sf.status} — ${sf.next}`);
      if (sf.status !== "filled") findings.push(`Solana partner order settled ${sf.status}`);
      if (sf.amountOut !== sq.expectedAmountOut) {
        findings.push(`Solana fill ${sf.amountOut} ≠ quote ${sq.expectedAmountOut} (off by ${BigInt(sf.amountOut) - BigInt(sq.expectedAmountOut)})`);
      } else log.ok(`delivered exactly the quote: ${sf.amountOut} base units`);
      metrics["Solana quote vs fill"] = sf.amountOut === sq.expectedAmountOut ? "exact" : "MISMATCH";
    }

    // ---------------------------------------------------------------- webhooks and lists
    log.step("g. webhooks: each fill delivered once, signed");
    await webhookPass(hooks);
    await webhookPass(hooks); // a second pass must not re-deliver
    const fills = received.filter((e) => e.type === "order.filled");
    const expected = sol ? 2 : 1;
    if (fills.length !== expected) findings.push(`${fills.length} order.filled webhook(s), expected ${expected}`);
    if (new Set(received.map((e) => e.id)).size !== received.length) findings.push("a webhook event was delivered twice");
    for (const e of fills) log.ok(`${e.type} ${e.order.chain}#${e.order.id} (${e.id})`);
    metrics["webhooks delivered"] = received.length;

    log.step("h. the user's orders");
    const listed = await listOrders(ctx, { user: user.account.address });
    if (!listed.orders.some((o) => o.chain === mirror && o.id === orderId)) findings.push("the EVM order is missing from the user's order list");
    else log.ok(`${listed.orders.length} order(s) for ${user.account.address}`);
  } finally {
    server.close();
    await owner.write(request, PARTNER_ABI, "setPartnerRequired", [priorEvm]);
    await owner.write(request, PARTNER_ABI, "setPartner", [PARTNER_ID, partnerEvm, treasury, 100, false]);
    if (sol && priorSol) {
      await sol.setPartnerRequired(sol.chain.payer, priorSol.partnerRequired);
      await sol.setPartner(sol.chain.payer, PARTNER_ID, { signer: partnerSol.publicKey, feeRecipient: Keypair.generate().publicKey, maxFeeBps: 100, active: false });
    }
    log.dim("partner settings restored");
  }

  const passed = findings.length === 0;
  return {
    name: NAME,
    passed,
    detail: passed ? `fills matched their quotes exactly; ${received.length} signed webhook(s) delivered once` : findings.join("; "),
    metrics,
    findings,
  };
}
