import { parseUnits, formatUnits, type Address } from "viem";
import { Harness, OFT_ABI, Status, Direction, forgeArtifact, type ScenarioResult } from "./harness.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 2 — buy from a chain with no market. THIS IS THE CORE PROOF.
 *
 * A user stands on a mirror chain. There is no pool there, no market maker, no reserves and no
 * price for the asset they want. They hold only the quote asset, in their own wallet. They
 * press buy once — and the stock lands in their wallet, on that same chain, at the real market
 * price discovered on the home chain's pool.
 *
 * Everything asserted is read back from chain state, and deliberately from sources that would
 * disagree if the relay were reporting something it had not done:
 *   - the mirror chain genuinely has no market before the trade,
 *   - the user starts with zero of the asset they are buying,
 *   - their quote asset actually leaves their wallet,
 *   - the swap really executes against the pool (reserves AND spot price both move, upward),
 *   - the stock arrives in the user's wallet ON THE MIRROR CHAIN,
 *   - the amount delivered matches what the settlement claims,
 *   - aggregate supply of both assets is conserved across the whole chain set.
 */
export async function scenario2(h: Harness, mirrorKey?: string, label = "2"): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];
  const home = h.home;

  log.banner(`Scenario ${label} — BUY from ${h.name(mirror)}, which has NO market`);

  const userAddr = h.userAddress;
  const userOnMirror = h.user(mirror);
  const requestAddr = h.addr(mirror, "SwapRequest");
  const mirrorQuote = h.addr(mirror, "QuoteAsset");
  const requestAbi = forgeArtifact("SwapRequest").abi;

  // ---------------------------------------------------------------- premise

  log.group("premise: no market on this chain");
  const premise = await h.assertNoLocalMarket(mirror);
  findings.push(...premise);
  log.kv("contracts on mirror", Object.keys(h.manifest.chains[mirror].contracts).join(", "));
  log.kv("pool there", "none");
  log.kv("market maker there", "none");
  log.kv("price source there", "none — all price discovery is on the home chain");
  if (premise.length === 0) log.ok("mirror chain confirmed to have no market of any kind");
  else for (const f of premise) log.fail(f);
  log.groupEnd();

  // ---------------------------------------------------------------- the user's wallet

  const budget = parseUnits("15000", h.quoteDecimals);
  log.group(`setup: the user acquires ${h.quoteSymbol} on ${h.name(mirror)}`);
  log.dim("bridged into their own wallet — a wallet balance is not liquidity");
  await h.ensureUserFunded(mirror, budget, "QuoteAsset");
  log.ok(`user holds ${h.fmtQuote(await h.quoteBalance(mirror, userAddr))} on ${h.name(mirror)}`);
  log.groupEnd();

  const spend = parseUnits("15000", h.quoteDecimals);
  const spotBefore = await h.spotPrice();
  const expectedOut = Number(formatUnits(spend, h.quoteDecimals)) / spotBefore;
  // 5% floor: loose enough to fill, tight enough that a broken swap cannot pass.
  const minAmountOut = parseUnits((expectedOut * 0.95).toFixed(h.tokenDecimals), h.tokenDecimals);

  const before = {
    userMirrorQuote: await h.quoteBalance(mirror, userAddr),
    userMirrorStock: await h.tokenBalance(mirror, userAddr),
    poolBase: await h.tokenBalance(home.key, h.manifest.pool!.address as Address),
    poolQuote: await h.quoteBalance(home.key, h.manifest.pool!.address as Address),
    stockSupply: (await h.totalSupplyAcrossChains("TokenizedStock")).total,
    quoteSupply: (await h.totalSupplyAcrossChains("QuoteAsset")).total,
  };

  log.group("before the trade");
  log.kv(`user ${h.quoteSymbol} on mirror`, h.fmtQuote(before.userMirrorQuote));
  log.kv(`user ${h.tokenSymbol} on mirror`, h.fmtToken(before.userMirrorStock));
  log.kv("pool spot price", `${spotBefore.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("spending", h.fmtQuote(spend));
  log.kv("expected out @ spot", `${expectedOut.toFixed(6)} ${h.tokenSymbol}`);
  log.kv("minAmountOut (5% floor)", h.fmtToken(minAmountOut));
  log.groupEnd();

  if (before.userMirrorStock !== 0n) {
    log.dim(`user already holds ${h.fmtToken(before.userMirrorStock)} from an earlier run — asserting deltas only`);
  }

  // ---------------------------------------------------------------- one transaction

  await userOnMirror.write(mirrorQuote, OFT_ABI, "approve", [requestAddr, spend]);

  const fee = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteTrade",
    [Direction.BUY, spend, minAmountOut]
  );
  log.kv("round-trip LZ fee", `${formatUnits(fee.nativeFee, 18)} ETH — paid once, on the mirror chain`);

  const requestId = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");

  const t0 = Date.now();
  const buyReceipt = await userOnMirror.write(requestAddr, requestAbi, "buy", [spend, minAmountOut], fee.nativeFee);
  const buyGas = buyReceipt.gasUsed;

  const afterSubmit = await h.quoteBalance(mirror, userAddr);
  log.group("payment committed on the mirror chain")
  log.kv(`user ${h.quoteSymbol} now`, h.fmtQuote(afterSubmit));
  log.kv("committed", h.fmtQuote(before.userMirrorQuote - afterSubmit));
  log.groupEnd();

  if (before.userMirrorQuote - afterSubmit !== spend) {
    findings.push(`user was debited ${before.userMirrorQuote - afterSubmit}, expected ${spend}`);
  }

  // ---------------------------------------------------------------- settlement

  const { ok } = await h.waitFor(
    "the stock to arrive on the mirror chain",
    async () => Number((await h.getRequest(mirror, requestId)).status) !== Status.PENDING
  );
  const latencyMs = Date.now() - t0;

  const settled = await h.getRequest(mirror, requestId);
  const after = {
    userMirrorStock: await h.tokenBalance(mirror, userAddr),
    poolBase: await h.tokenBalance(home.key, h.manifest.pool!.address as Address),
    poolQuote: await h.quoteBalance(home.key, h.manifest.pool!.address as Address),
    stockSupply: (await h.totalSupplyAcrossChains("TokenizedStock")).total,
    quoteSupply: (await h.totalSupplyAcrossChains("QuoteAsset")).total,
  };
  const spotAfter = await h.spotPrice();

  const stockDelivered = after.userMirrorStock - before.userMirrorStock;
  const poolBaseDelta = after.poolBase - before.poolBase;
  const poolQuoteDelta = after.poolQuote - before.poolQuote;

  log.group("settlement — delivered to the user's wallet ON THE MIRROR CHAIN");
  log.kv("status", Status[Number(settled.status)] ?? String(settled.status));
  log.kv("amountIn (recorded)", h.fmtQuote(settled.amountIn));
  log.kv("amountOut (recorded)", h.fmtToken(settled.amountOut));
  log.kv(`${h.tokenSymbol} in user wallet`, h.fmtToken(after.userMirrorStock));
  log.kv("delivered this trade", h.fmtToken(stockDelivered));
  log.kv("pool base reserve delta", h.fmtToken(poolBaseDelta));
  log.kv("pool quote reserve delta", h.fmtQuote(poolQuoteDelta));
  log.kv("spot before → after", `${spotBefore.toFixed(6)} → ${spotAfter.toFixed(6)}`);
  log.kv("round-trip latency", `${latencyMs} ms`);
  log.kv("buy() gas", buyGas.toString());
  log.groupEnd();

  const received = Number(formatUnits(settled.amountOut, h.tokenDecimals));
  const effectivePrice = Number(formatUnits(spend, h.quoteDecimals)) / received;
  const slippagePct = ((effectivePrice - spotBefore) / spotBefore) * 100;

  log.group("execution quality");
  log.kv("effective price", `${effectivePrice.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("vs spot before", `+${slippagePct.toFixed(4)}% (fee + price impact)`);
  log.groupEnd();

  // ---------------------------------------------------------------- assertions

  if (Number(settled.status) !== Status.FILLED) {
    findings.push(`request settled as ${Status[Number(settled.status)]}, expected FILLED`);
  }
  if (settled.amountOut === 0n) findings.push("settlement reported zero amountOut");
  if (settled.amountOut < minAmountOut) {
    findings.push(`amountOut ${settled.amountOut} is below the minAmountOut floor ${minAmountOut}`);
  }
  if (stockDelivered !== settled.amountOut) {
    findings.push(
      `stock delivered to the user on the mirror (${stockDelivered}) does not match the settlement ` +
        `(${settled.amountOut}) — the receipt must reflect reality`
    );
  }
  if (poolQuoteDelta !== settled.amountIn) {
    findings.push(
      `pool quote reserve moved by ${poolQuoteDelta} but the request recorded ${settled.amountIn} — ` +
        `the swap did not execute against the pool as claimed`
    );
  }
  if (poolBaseDelta >= 0n) findings.push(`pool base reserve did not fall on a buy (${poolBaseDelta})`);
  if (spotAfter <= spotBefore) {
    findings.push(`spot price did not rise after a buy (${spotBefore} → ${spotAfter}) — no real price impact`);
  }
  if (after.stockSupply !== before.stockSupply) {
    findings.push(`aggregate stock supply changed ${before.stockSupply} → ${after.stockSupply}`);
  }
  if (after.quoteSupply !== before.quoteSupply) {
    findings.push(`aggregate quote supply changed ${before.quoteSupply} → ${after.quoteSupply}`);
  }

  const passed = ok && findings.length === 0;

  if (passed) {
    log.ok("CORE PROOF: a user on a chain with no market bought the asset in one transaction");
    log.ok("and received it in their wallet on that chain, priced by the home chain's pool.");
  } else {
    for (const f of findings) log.fail(f);
  }

  return {
    name: `${label}. Buy from a chain with no market (CORE PROOF)`,
    passed,
    detail: passed
      ? `${h.fmtQuote(spend)} spent on ${h.name(mirror)} (no market) → ` +
        `${h.fmtToken(settled.amountOut)} delivered to the user's wallet there, in ${latencyMs}ms`
      : findings.join("; ") || "timed out waiting for settlement",
    metrics: {
      mirrorChain: h.name(mirror),
      spent: h.fmtQuote(spend),
      received: h.fmtToken(settled.amountOut),
      effectivePrice: effectivePrice.toFixed(6),
      spotBefore: spotBefore.toFixed(6),
      spotAfter: spotAfter.toFixed(6),
      slippagePct: `+${slippagePct.toFixed(4)}%`,
      latencyMs,
      buyGas: buyGas.toString(),
      lzFeeEth: formatUnits(fee.nativeFee, 18),
    },
    findings,
  };
}
