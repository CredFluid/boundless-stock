import { parseUnits, formatUnits, type Address } from "viem";
import { Harness, OFT_ABI, Status, Direction, forgeArtifact, type ScenarioResult } from "./harness.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 4 — failure case: stalled message.
 *
 * Characterises what happens to a user's committed input when the destination call never
 * completes. Unlike scenarios 1-3 this is an investigation, not a pass/fail of intended
 * behaviour: the question is whether a timeout/refund mechanism is needed before this design
 * is production-safe.
 *
 * Three distinct stalls are exercised, because they have very different consequences:
 *
 *   A. The packet is never delivered (no DVN attestation / no executor).
 *   B. The packet IS delivered and the tokens land on the home chain, but the composed call
 *      reverts because the sender under-provisioned its gas.
 *   C. Recovery from B.
 */
export async function scenario4(h: Harness, mirrorKey?: string): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];
  const metrics: Record<string, string | number> = {};

  log.banner(`Scenario 4 — stalled message from ${h.name(mirror)} (investigation)`);

  if (!h.relayer) {
    return {
      name: "4. Failure case: stalled message",
      passed: false,
      detail: "requires the local environment — a live run cannot withhold LayerZero delivery",
      metrics: {},
      findings: ["skipped: not runnable against live LayerZero infrastructure"],
    };
  }

  const relayer = h.relayer; // narrowed above; the inner function loses the guard
  const userAddr = h.userAddress;
  const userOnMirror = h.user(mirror);
  const requestAddr = h.addr(mirror, "SwapRequest");
  const mirrorQuote = h.addr(mirror, "QuoteAsset");
  const requestAbi = forgeArtifact("SwapRequest").abi;
  const relayAddr = h.addr(h.home.key, "SwapRelay");

  const spend = parseUnits("3000", h.quoteDecimals);
  const mirrorChain = h.chain(mirror);

  // Capture the gas configuration up front and restore it in a finally block. Phase B
  // deliberately misconfigures the contract, and a scenario that can leave a deployment
  // misconfigured if it is interrupted is a scenario that will waste someone's afternoon.
  const original = {
    lzReceiveGas: await mirrorChain.read<bigint>(requestAddr, requestAbi, "homeLzReceiveGas"),
    composeGas: await mirrorChain.read<bigint>(requestAddr, requestAbi, "homeComposeGas"),
    composeValue: await mirrorChain.read<bigint>(requestAddr, requestAbi, "homeComposeValue"),
  };

  try {
    return await run();
  } finally {
    await mirrorChain.write(requestAddr, requestAbi, "setGasParams", [
      original.lzReceiveGas,
      original.composeGas,
      original.composeValue,
    ]);
    log.dim(`compose gas restored to ${original.composeGas}`);
  }

  async function run(): Promise<ScenarioResult> {
  await h.ensureUserFunded(mirror, parseUnits("12000", h.quoteDecimals), "QuoteAsset");
  await h.settle();

  // ================================================================= PHASE A

  log.group("Phase A — packet sent but never delivered");

  const supplyBeforeA = await h.totalSupplyAcrossChains("QuoteAsset");
  const userBeforeA = await h.quoteBalance(mirror, userAddr);

  await userOnMirror.write(mirrorQuote, OFT_ABI, "approve", [requestAddr, spend]);
  const spot = await h.spotPrice();
  const minOut = parseUnits(
    ((Number(formatUnits(spend, h.quoteDecimals)) / spot) * 0.95).toFixed(h.tokenDecimals),
    h.tokenDecimals
  );
  const feeA = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteTrade",
    [Direction.BUY, spend, minOut]
  );
  const idA = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");
  await userOnMirror.write(requestAddr, requestAbi, "buy", [spend, minOut], feeA.nativeFee);

  // Deliberately do NOT relay. This is the "message in flight, nobody delivering it" state.
  const supplyDuringA = await h.totalSupplyAcrossChains("QuoteAsset");
  const userDuringA = await h.quoteBalance(mirror, userAddr);
  const reqDuringA = await h.getRequest(mirror, idA);
  const inFlight = supplyBeforeA.total - supplyDuringA.total;

  log.kv("user debited", h.fmtQuote(userBeforeA - userDuringA));
  log.kv("request status", Status[Number(reqDuringA.status)] ?? String(reqDuringA.status));
  log.kv("aggregate supply before", h.fmtQuote(supplyBeforeA.total));
  log.kv("aggregate supply in flight", h.fmtQuote(supplyDuringA.total));
  log.kv("money in flight (nowhere)", h.fmtQuote(inFlight));
  log.warn("input is burned on the mirror and not yet minted on the home chain:");
  log.warn("for the duration of the stall it exists on NO chain, and nothing times out.");

  metrics.phaseA_inFlight = h.fmtQuote(inFlight);
  metrics.phaseA_status = Status[Number(reqDuringA.status)] ?? String(reqDuringA.status);

  if (Number(reqDuringA.status) !== Status.PENDING) {
    findings.push(`undelivered request is ${Status[Number(reqDuringA.status)]}, expected PENDING`);
  }
  if (inFlight !== spend) {
    findings.push(`expected ${spend} in flight, measured ${inFlight}`);
  }

  // Now deliver it and confirm the stall was only ever a delay, not a loss.
  await h.settle();
  const recoveredA = await h.waitFor(
    "delayed delivery to settle",
    async () => Number((await h.getRequest(mirror, idA)).status) !== Status.PENDING,
    30_000
  );
  const reqAfterA = await h.getRequest(mirror, idA);
  const supplyAfterA = await h.totalSupplyAcrossChains("QuoteAsset");

  log.ok(`once delivered, the request settled as ${Status[Number(reqAfterA.status)]}`);
  log.kv("aggregate supply restored", h.fmtQuote(supplyAfterA.total));
  metrics.phaseA_resolvedAs = Status[Number(reqAfterA.status)] ?? String(reqAfterA.status);

  if (supplyAfterA.total !== supplyBeforeA.total) {
    findings.push(`supply not restored after delayed delivery: ${supplyBeforeA.total} → ${supplyAfterA.total}`);
  }
  log.groupEnd();

  // ================================================================= PHASE B

  log.group("Phase B — delivered, but the composed call reverts (under-provisioned gas)");

  // Starve the compose. The OFT delivery still succeeds, so the tokens DO land on the home
  // chain — they just land somewhere the user cannot reach.
  await mirrorChain.write(requestAddr, requestAbi, "setGasParams", [
    original.lzReceiveGas,
    30_000n,
    original.composeValue,
  ]);
  log.kv("compose gas set to", "30,000 (far below what the swap needs)");

  const relayBeforeB = await h.quoteBalance(h.home.key, relayAddr);
  const userBeforeB = await h.quoteBalance(mirror, userAddr);

  await userOnMirror.write(mirrorQuote, OFT_ABI, "approve", [requestAddr, spend]);
  const feeB = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteTrade",
    [Direction.BUY, spend, minOut]
  );
  const idB = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");
  await userOnMirror.write(requestAddr, requestAbi, "buy", [spend, minOut], feeB.nativeFee);

  await h.settle();

  const relayAfterB = await h.quoteBalance(h.home.key, relayAddr);
  const userAfterB = await h.quoteBalance(mirror, userAddr);
  const reqB = await h.getRequest(mirror, idB);
  const strandedInRelay = relayAfterB - relayBeforeB;

  log.kv("user debited", h.fmtQuote(userBeforeB - userAfterB));
  log.kv("money now held by SwapRelay", h.fmtQuote(strandedInRelay));
  log.kv("request status on mirror", Status[Number(reqB.status)] ?? String(reqB.status));
  log.kv("stuck composes", String(relayer.stuckComposes));
  log.fail("FINDING: the input is sitting in SwapRelay on the home chain, the request is still");
  log.fail("PENDING on the mirror chain, and NOTHING refunds it automatically. No timeout exists.");

  metrics.phaseB_strandedInRelay = h.fmtQuote(strandedInRelay);
  metrics.phaseB_status = Status[Number(reqB.status)] ?? String(reqB.status);
  metrics.phaseB_stuckComposes = relayer.stuckComposes;

  if (strandedInRelay !== spend) {
    findings.push(`expected ${spend} stranded in SwapRelay, measured ${strandedInRelay}`);
  }
  if (Number(reqB.status) !== Status.PENDING) {
    findings.push(`stalled request is ${Status[Number(reqB.status)]}, expected to be stuck PENDING`);
  }
  log.groupEnd();

  // ================================================================= PHASE C

  log.group("Phase C — recovery by retrying the compose with adequate gas");

  const retry = await relayer.retryFailedComposes(3_000_000n);
  log.kv("composes retried", `${retry.retried} (${retry.succeeded} succeeded)`);

  const recoveredC = await h.waitFor(
    "settlement after retry",
    async () => Number((await h.getRequest(mirror, idB)).status) !== Status.PENDING,
    30_000
  );
  const reqC = await h.getRequest(mirror, idB);
  const relayAfterC = await h.quoteBalance(h.home.key, relayAddr);

  log.kv("request status now", Status[Number(reqC.status)] ?? String(reqC.status));
  log.kv("amountOut", h.fmtToken(reqC.amountOut));
  log.kv("SwapRelay quote balance", h.fmtQuote(relayAfterC));
  log.kv("recovery latency", `${recoveredC.elapsedMs} ms`);

  metrics.phaseC_resolvedAs = Status[Number(reqC.status)] ?? String(reqC.status);
  metrics.phaseC_recoveryMs = recoveredC.elapsedMs;

  if (Number(reqC.status) === Status.PENDING) {
    findings.push("request still PENDING after a compose retry — stall is not recoverable this way");
  }
  if (relayAfterC !== relayBeforeB) {
    findings.push(`SwapRelay still holds ${relayAfterC - relayBeforeB} quote units after recovery`);
  }

  log.groupEnd();

  // ================================================================= verdict

  const passed = findings.length === 0 && recoveredA.ok && recoveredC.ok;

  log.group("verdict");
  log.info("Funds are never destroyed: a stall is always recoverable, in both forms.");
  log.info("But recovery is NEVER automatic. LayerZero V2 has no message expiry, so:");
  log.info("  - an undelivered packet stays deliverable indefinitely;");
  log.info("  - a reverting compose stays retryable indefinitely;");
  log.info("  - and in both cases the user's input sits unusable until SOMEONE acts.");
  log.warn("A timeout/refund mechanism IS needed before this is production-safe. See NOTES.md.");
  log.groupEnd();

  return {
    name: "4. Failure case: stalled message (investigation)",
    passed,
    detail: passed
      ? "stalls characterised: funds always recoverable, recovery never automatic — timeout/refund needed"
      : findings.join("; "),
    metrics,
    findings,
  };
  }
}
