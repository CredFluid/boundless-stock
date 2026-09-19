import { parseUnits, formatUnits, type Address } from "viem";
import { Harness, OFT_ABI, Status, Direction, forgeArtifact, type ScenarioResult } from "./harness.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 6 — the reverse direction: selling from a chain with no market.
 *
 * The mirror image of scenario 2. The user holds the stock on a chain with no market for it,
 * sells, and receives the quote asset **in their wallet on that same chain**.
 *
 * Why this earns its place as a separate scenario: the two directions look symmetric in the
 * source, but they exercise different code. The delivering OFT is different, which is what
 * `SwapRelay` derives the trade direction from; the swap runs the other way through the pool;
 * and the asset bridged back is the other one — with different decimals, so a different
 * dust profile. "It's symmetric" is a claim about the code, and this is the check on it.
 */
export async function scenario6(h: Harness, mirrorKey?: string): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];

  log.banner(`Scenario 6 — SELL from ${h.name(mirror)}, which has no market`);

  const userAddr = h.userAddress;
  const userOnMirror = h.user(mirror);
  const requestAddr = h.addr(mirror, "SwapRequest");
  const mirrorStock = h.addr(mirror, "TokenizedStock");
  const requestAbi = forgeArtifact("SwapRequest").abi;

  const premise = await h.assertNoLocalMarket(mirror);
  findings.push(...premise);

  const amountIn = parseUnits("20", h.tokenDecimals);
  await h.ensureUserFunded(mirror, amountIn, "TokenizedStock");

  const spotBefore = await h.spotPrice();
  const expectedOut = Number(formatUnits(amountIn, h.tokenDecimals)) * spotBefore;
  const minAmountOut = parseUnits((expectedOut * 0.95).toFixed(h.quoteDecimals), h.quoteDecimals);

  const before = {
    userStock: await h.tokenBalance(mirror, userAddr),
    userQuote: await h.quoteBalance(mirror, userAddr),
    poolBase: await h.tokenBalance(h.home.key, h.manifest.pool!.address as Address),
  };

  log.group("before the trade");
  log.kv(`user ${h.tokenSymbol} on mirror`, h.fmtToken(before.userStock));
  log.kv(`user ${h.quoteSymbol} on mirror`, h.fmtQuote(before.userQuote));
  log.kv("pool spot", `${spotBefore.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("selling", h.fmtToken(amountIn));
  log.groupEnd();

  await userOnMirror.write(mirrorStock, OFT_ABI, "approve", [requestAddr, amountIn]);
  const fee = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteTrade",
    [Direction.SELL, amountIn, minAmountOut]
  );
  const requestId = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");

  const t0 = Date.now();
  const sellReceipt = await userOnMirror.write(
    requestAddr,
    requestAbi,
    "sell",
    [amountIn, minAmountOut],
    fee.nativeFee
  );

  const { ok } = await h.waitFor(
    `${h.quoteSymbol} to arrive on the mirror chain`,
    async () => Number((await h.getRequest(mirror, requestId)).status) !== Status.PENDING
  );
  const latencyMs = Date.now() - t0;

  const settled = await h.getRequest(mirror, requestId);
  const after = {
    userStock: await h.tokenBalance(mirror, userAddr),
    userQuote: await h.quoteBalance(mirror, userAddr),
    poolBase: await h.tokenBalance(h.home.key, h.manifest.pool!.address as Address),
  };
  const spotAfter = await h.spotPrice();

  const quoteDelivered = after.userQuote - before.userQuote;
  const stockSpent = before.userStock - after.userStock;

  log.group("settlement — proceeds delivered to the user's wallet ON THE MIRROR CHAIN");
  log.kv("status", Status[Number(settled.status)] ?? String(settled.status));
  log.kv("stock sold", h.fmtToken(stockSpent));
  log.kv(`${h.quoteSymbol} delivered`, h.fmtQuote(quoteDelivered));
  log.kv("pool base reserve delta", h.fmtToken(after.poolBase - before.poolBase));
  log.kv("spot before → after", `${spotBefore.toFixed(6)} → ${spotAfter.toFixed(6)}`);
  log.kv("latency", `${latencyMs} ms`);
  log.groupEnd();

  const received = Number(formatUnits(settled.amountOut, h.quoteDecimals));
  const effectivePrice = received / Number(formatUnits(amountIn, h.tokenDecimals));
  const slippagePct = ((spotBefore - effectivePrice) / spotBefore) * 100;
  log.kv("effective price", `${effectivePrice.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("vs spot before", `-${slippagePct.toFixed(4)}%`);

  if (Number(settled.status) !== Status.FILLED) {
    findings.push(`request settled as ${Status[Number(settled.status)]}, expected FILLED`);
  }
  if (quoteDelivered !== settled.amountOut) {
    findings.push(`quote delivered (${quoteDelivered}) does not match the settlement (${settled.amountOut})`);
  }
  if (quoteDelivered === 0n) findings.push("no proceeds delivered to the mirror chain");
  if (stockSpent !== settled.amountIn) findings.push(`stock debited ${stockSpent}, settlement says ${settled.amountIn}`);
  if (after.poolBase <= before.poolBase) {
    findings.push(`pool base reserve did not rise on a sell (${after.poolBase - before.poolBase})`);
  }
  if (spotAfter >= spotBefore) findings.push(`spot price did not fall after a sell (${spotBefore} → ${spotAfter})`);

  const passed = ok && findings.length === 0;
  if (passed) {
    log.ok("reverse direction works: proceeds delivered on the mirror chain, no market needed there");
  } else {
    for (const f of findings) log.fail(f);
  }

  return {
    name: "6. Reverse direction (sell) — symmetry check",
    passed,
    detail: passed
      ? `${h.fmtToken(amountIn)} sold from ${h.name(mirror)} → ${h.fmtQuote(quoteDelivered)} ` +
        `delivered to the user's wallet there, in ${latencyMs}ms`
      : findings.join("; ") || "timed out",
    metrics: {
      mirrorChain: h.name(mirror),
      sold: h.fmtToken(amountIn),
      received: h.fmtQuote(quoteDelivered),
      effectivePrice: effectivePrice.toFixed(6),
      slippagePct: `-${slippagePct.toFixed(4)}%`,
      latencyMs,
      sellGas: sellReceipt.gasUsed.toString(),
    },
    findings,
  };
}
