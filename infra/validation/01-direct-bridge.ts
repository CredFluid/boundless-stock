import { parseUnits, type Address } from "viem";
import { Harness, OFT_ABI, type ScenarioResult } from "./harness.js";
import { Options } from "../lib/options.js";
import { toBytes32 } from "../lib/address.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 1 — direct bridge sanity check.
 *
 * Sends a small amount of TokenizedStock from the home chain to one mirror chain and confirms
 * the balance actually moves. This proves nothing about the core claim on its own; it exists
 * so that if scenario 2 fails, we already know whether the bridge itself or the swap relay is
 * at fault.
 *
 * Also checks supply conservation across the whole chain set, which is the invariant every
 * later scenario quietly depends on.
 */
export async function scenario1(h: Harness, mirrorKey?: string): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];
  const home = h.home;
  const user = home.deployer as Address;

  log.banner(`Scenario 1 — direct bridge: ${h.name(home.key)} → ${h.name(mirror)}`);

  const amount = parseUnits("1000", h.tokenDecimals);

  const before = {
    home: await h.tokenBalance(home.key, user),
    mirror: await h.tokenBalance(mirror, user),
    supply: await h.totalSupplyAcrossChains(),
  };
  log.kv("home balance before", h.fmtToken(before.home));
  log.kv("mirror balance before", h.fmtToken(before.mirror));
  log.kv("aggregate supply before", h.fmtToken(before.supply.total));

  // Informational, not a failure: re-running the suite against an existing deployment
  // legitimately leaves a prior balance. What this scenario actually asserts is the deltas.
  if (before.mirror !== 0n) {
    log.dim(`mirror already holds ${h.fmtToken(before.mirror)} from an earlier run — asserting deltas only`);
  }

  const options = Options.new().addExecutorLzReceive(200_000n).build();
  const sendParam = {
    dstEid: h.eid(mirror),
    to: toBytes32(user),
    amountLD: amount,
    minAmountLD: amount,
    extraOptions: options,
    composeMsg: "0x" as const,
    oftCmd: "0x" as const,
  };

  const oft = h.addr(home.key, "TokenizedStock");
  const fee = await home.read<{ nativeFee: bigint; lzTokenFee: bigint }>(oft, OFT_ABI, "quoteSend", [
    sendParam,
    false,
  ]);
  log.kv("LayerZero fee", `${fee.nativeFee} wei`);

  const t0 = Date.now();
  const sendReceipt = await home.write(oft, OFT_ABI, "send", [sendParam, fee, user], fee.nativeFee);
  const sendGas = sendReceipt.gasUsed;

  const { ok, elapsedMs } = await h.waitFor(
    "mirror balance to increase",
    async () => (await h.tokenBalance(mirror, user)) >= before.mirror + amount
  );
  const latencyMs = Date.now() - t0;

  const after = {
    home: await h.tokenBalance(home.key, user),
    mirror: await h.tokenBalance(mirror, user),
    supply: await h.totalSupplyAcrossChains(),
  };

  const homeDelta = before.home - after.home;
  const mirrorDelta = after.mirror - before.mirror;

  log.kv("home balance after", h.fmtToken(after.home));
  log.kv("mirror balance after", h.fmtToken(after.mirror));
  log.kv("home debited", h.fmtToken(homeDelta));
  log.kv("mirror credited", h.fmtToken(mirrorDelta));
  log.kv("latency", `${latencyMs} ms`);
  log.kv("send gas", sendGas.toString());

  if (homeDelta !== amount) findings.push(`home debited ${homeDelta}, expected ${amount}`);
  if (mirrorDelta !== amount) findings.push(`mirror credited ${mirrorDelta}, expected ${amount}`);
  if (after.supply.total !== before.supply.total) {
    findings.push(
      `aggregate supply changed: ${before.supply.total} → ${after.supply.total}. ` +
        `OFT burn/mint must conserve supply across the set.`
    );
  }

  const passed = ok && findings.length === 0;
  if (passed) log.ok("bridge moves balance correctly and conserves aggregate supply");
  else for (const f of findings) log.fail(f);

  return {
    name: "1. Direct bridge sanity check",
    passed,
    detail: passed
      ? `${h.fmtToken(amount)} moved ${h.name(home.key)} → ${h.name(mirror)} in ${latencyMs}ms`
      : findings.join("; ") || "timed out",
    metrics: {
      amount: h.fmtToken(amount),
      latencyMs,
      sendGas: sendGas.toString(),
      lzFeeWei: fee.nativeFee.toString(),
      aggregateSupply: h.fmtToken(after.supply.total),
    },
    findings,
  };
}
