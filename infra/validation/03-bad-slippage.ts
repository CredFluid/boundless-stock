import { parseUnits, formatUnits } from "viem";
import { Harness, OFT_ABI, Status, forgeArtifact, type ScenarioResult } from "./harness.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 3 — failure case: bad slippage.
 *
 * Submits a request whose `minAmountOut` the pool cannot possibly satisfy, and confirms the
 * user does not lose their input.
 *
 * This is the scenario that decides whether the design is safe to extend. A cross-chain swap
 * is exposed to home-chain price movement for the full message latency, so orders *will* miss
 * their slippage floor in production. If that path loses funds, nothing else about the system
 * matters.
 */
export async function scenario3(h: Harness, mirrorKey?: string): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];

  log.banner(`Scenario 3 — bad slippage from ${h.name(mirror)} (expect a safe refund)`);

  const userAddr = h.userAddress;
  const userOnMirror = h.user(mirror);
  const requestAddr = h.addr(mirror, "SwapRequest");
  const mirrorToken = h.addr(mirror, "TokenizedStock");
  const requestAbi = forgeArtifact("SwapRequest").abi;

  const amountIn = parseUnits("50", h.tokenDecimals);
  const spot = await h.spotPrice();

  // Demand twice the spot price: unsatisfiable at any trade size, so the pool must reject it.
  const impossibleOut = parseUnits(
    (Number(formatUnits(amountIn, h.tokenDecimals)) * spot * 2).toFixed(h.quoteDecimals),
    h.quoteDecimals
  );

  const before = {
    userMirrorToken: await h.tokenBalance(mirror, userAddr),
    userHomeQuote: await h.quoteBalance(userAddr),
    poolBase: await h.tokenBalance(h.home.key, h.manifest.pool!.address as `0x${string}`),
  };

  log.group("setup");
  log.kv("user tAAPL on mirror", h.fmtToken(before.userMirrorToken));
  log.kv("pool spot", `${spot.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("selling", h.fmtToken(amountIn));
  log.kv("demanding at least", `${h.fmtQuote(impossibleOut)} (2x spot — unsatisfiable)`);
  log.groupEnd();

  if (before.userMirrorToken < amountIn) {
    return {
      name: "3. Failure case: bad slippage",
      passed: false,
      detail: `user holds only ${h.fmtToken(before.userMirrorToken)} on ${h.name(mirror)}; run scenario 2 first`,
      metrics: {},
      findings: ["insufficient user balance for the test"],
    };
  }

  await userOnMirror.write(mirrorToken, OFT_ABI, "approve", [requestAddr, amountIn]);
  const fee = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteSwap",
    [amountIn, impossibleOut, userAddr]
  );
  const requestId = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");

  const t0 = Date.now();
  await userOnMirror.write(requestAddr, requestAbi, "requestSwap", [amountIn, impossibleOut, userAddr], fee.nativeFee);

  const afterSubmit = await h.tokenBalance(mirror, userAddr);
  log.kv("user debited on submit", h.fmtToken(before.userMirrorToken - afterSubmit));

  const { ok } = await h.waitFor(
    "refund to reach the mirror chain",
    async () => Number((await h.getRequest(mirror, requestId)).status) !== Status.PENDING
  );
  const latencyMs = Date.now() - t0;

  const settled = await h.getRequest(mirror, requestId);
  const after = {
    userMirrorToken: await h.tokenBalance(mirror, userAddr),
    userHomeQuote: await h.quoteBalance(userAddr),
    poolBase: await h.tokenBalance(h.home.key, h.manifest.pool!.address as `0x${string}`),
  };

  const netTokenChange = after.userMirrorToken - before.userMirrorToken;
  const quoteChange = after.userHomeQuote - before.userHomeQuote;

  log.group("outcome");
  log.kv("status", Status[Number(settled.status)] ?? String(settled.status));
  log.kv("failure reason", String(settled.failureReason));
  log.kv("user tAAPL restored to", h.fmtToken(after.userMirrorToken));
  log.kv("net token change", h.fmtToken(netTokenChange));
  log.kv("USDC received", h.fmtQuote(quoteChange));
  log.kv("pool base reserve change", h.fmtToken(after.poolBase - before.poolBase));
  log.kv("refund latency", `${latencyMs} ms`);
  log.groupEnd();

  if (Number(settled.status) !== Status.REFUNDED) {
    findings.push(`request settled as ${Status[Number(settled.status)]}, expected REFUNDED`);
  }
  if (netTokenChange !== 0n) {
    findings.push(`user is down ${-netTokenChange} tokens after a failed swap — input was NOT fully returned`);
  }
  if (quoteChange !== 0n) findings.push(`user received ${quoteChange} quote asset from a swap that should have failed`);
  if (after.poolBase !== before.poolBase) {
    findings.push(`pool base reserve moved on a swap that should not have executed`);
  }

  const passed = ok && findings.length === 0;
  if (passed) {
    log.ok("swap rejected by the pool; input returned to the user on the mirror chain, in full");
  } else {
    for (const f of findings) log.fail(f);
  }

  return {
    name: "3. Failure case: bad slippage",
    passed,
    detail: passed
      ? `unsatisfiable minAmountOut rejected; ${h.fmtToken(amountIn)} returned in full in ${latencyMs}ms`
      : findings.join("; ") || "timed out",
    metrics: {
      amountIn: h.fmtToken(amountIn),
      demandedOut: h.fmtQuote(impossibleOut),
      status: Status[Number(settled.status)] ?? String(settled.status),
      netTokenChange: h.fmtToken(netTokenChange),
      refundLatencyMs: latencyMs,
    },
    findings,
  };
}
