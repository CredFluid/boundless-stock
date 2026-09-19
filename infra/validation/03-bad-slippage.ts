import { parseUnits, formatUnits, type Address } from "viem";
import { Harness, OFT_ABI, Status, Direction, forgeArtifact, type ScenarioResult } from "./harness.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 3 — failure case: bad slippage.
 *
 * Submits a buy whose `minAmountOut` the pool cannot possibly satisfy, and confirms the user
 * does not lose the money they paid with.
 *
 * This is the scenario that decides whether the design is safe to extend. A cross-chain order
 * is exposed to home-chain price movement for the full message latency, so orders *will* miss
 * their slippage floor in production. If that path loses funds, nothing else matters.
 *
 * The refund has to travel back across the bridge to reach the user, which makes it a stricter
 * test than a same-chain revert: the money leaves the user's chain, fails on another chain,
 * and has to find its way home.
 */
export async function scenario3(h: Harness, mirrorKey?: string): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];

  log.banner(`Scenario 3 — bad slippage on a buy from ${h.name(mirror)} (expect a safe refund)`);

  const userAddr = h.userAddress;
  const userOnMirror = h.user(mirror);
  const requestAddr = h.addr(mirror, "SwapRequest");
  const mirrorQuote = h.addr(mirror, "QuoteAsset");
  const requestAbi = forgeArtifact("SwapRequest").abi;

  const spend = parseUnits("5000", h.quoteDecimals);
  await h.ensureUserFunded(mirror, spend, "QuoteAsset");

  const spot = await h.spotPrice();
  // Demand twice as much stock as the money could ever buy: unsatisfiable at any trade size.
  const impossibleOut = parseUnits(
    ((Number(formatUnits(spend, h.quoteDecimals)) / spot) * 2).toFixed(h.tokenDecimals),
    h.tokenDecimals
  );

  const before = {
    userQuote: await h.quoteBalance(mirror, userAddr),
    userStock: await h.tokenBalance(mirror, userAddr),
    poolBase: await h.tokenBalance(h.home.key, h.manifest.pool!.address as Address),
  };

  log.group("setup");
  log.kv(`user ${h.quoteSymbol} on mirror`, h.fmtQuote(before.userQuote));
  log.kv("pool spot", `${spot.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("spending", h.fmtQuote(spend));
  log.kv("demanding at least", `${h.fmtToken(impossibleOut)} (2x what it could buy — unsatisfiable)`);
  log.groupEnd();

  await userOnMirror.write(mirrorQuote, OFT_ABI, "approve", [requestAddr, spend]);
  const fee = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteTrade",
    [Direction.BUY, spend, impossibleOut]
  );
  const requestId = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");

  const t0 = Date.now();
  await userOnMirror.write(requestAddr, requestAbi, "buy", [spend, impossibleOut], fee.nativeFee);

  const afterSubmit = await h.quoteBalance(mirror, userAddr);
  log.kv("user debited on submit", h.fmtQuote(before.userQuote - afterSubmit));

  const { ok } = await h.waitFor(
    "refund to reach the mirror chain",
    async () => Number((await h.getRequest(mirror, requestId)).status) !== Status.PENDING
  );
  const latencyMs = Date.now() - t0;

  const settled = await h.getRequest(mirror, requestId);
  const after = {
    userQuote: await h.quoteBalance(mirror, userAddr),
    userStock: await h.tokenBalance(mirror, userAddr),
    poolBase: await h.tokenBalance(h.home.key, h.manifest.pool!.address as Address),
  };

  const netQuoteChange = after.userQuote - before.userQuote;
  const stockChange = after.userStock - before.userStock;

  log.group("outcome");
  log.kv("status", Status[Number(settled.status)] ?? String(settled.status));
  log.kv("failure reason", String(settled.failureReason));
  log.kv(`user ${h.quoteSymbol} restored to`, h.fmtQuote(after.userQuote));
  log.kv("net quote change", h.fmtQuote(netQuoteChange));
  log.kv("stock received", h.fmtToken(stockChange));
  log.kv("pool base reserve change", h.fmtToken(after.poolBase - before.poolBase));
  log.kv("refund latency", `${latencyMs} ms`);
  log.groupEnd();

  if (Number(settled.status) !== Status.REFUNDED) {
    findings.push(`request settled as ${Status[Number(settled.status)]}, expected REFUNDED`);
  }
  if (netQuoteChange !== 0n) {
    findings.push(`user is down ${-netQuoteChange} quote units after a failed buy — NOT fully refunded`);
  }
  if (stockChange !== 0n) findings.push(`user received ${stockChange} stock from a buy that should have failed`);
  if (after.poolBase !== before.poolBase) {
    findings.push("pool base reserve moved on a swap that should not have executed");
  }

  const passed = ok && findings.length === 0;
  if (passed) {
    log.ok("buy rejected by the pool; the money came back across the bridge to the user, in full");
  } else {
    for (const f of findings) log.fail(f);
  }

  return {
    name: "3. Failure case: bad slippage",
    passed,
    detail: passed
      ? `unsatisfiable minAmountOut rejected; ${h.fmtQuote(spend)} returned in full in ${latencyMs}ms`
      : findings.join("; ") || "timed out",
    metrics: {
      spent: h.fmtQuote(spend),
      demandedOut: h.fmtToken(impossibleOut),
      status: Status[Number(settled.status)] ?? String(settled.status),
      netQuoteChange: h.fmtQuote(netQuoteChange),
      refundLatencyMs: latencyMs,
    },
    findings,
  };
}
