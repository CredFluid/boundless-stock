import { parseUnits, formatUnits, type Address } from "viem";
import { Harness, OFT_ABI, Status, forgeArtifact, type ScenarioResult } from "./harness.js";
import { Options } from "../lib/options.js";
import { toBytes32 } from "../lib/address.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 2 — full swap-relay round trip. THIS IS THE CORE PROOF.
 *
 * A user standing on a mirror chain that has no pool, no market maker, no quote asset and no
 * local liquidity of any kind submits a trade and receives a real result. Price discovery and
 * execution happen entirely on the home chain's Uniswap V3 pool.
 *
 * Everything the scenario asserts is read back from chain state:
 *   - the mirror chain genuinely has no liquidity infrastructure before the trade,
 *   - the user's input actually leaves their wallet on the mirror chain,
 *   - the swap really executes against the pool (pool reserves and spot price both move),
 *   - the proceeds land with the user on the home chain,
 *   - the mirror chain receives an authenticated settlement carrying the exact amount out.
 */
export async function scenario2(h: Harness, mirrorKey?: string, label = "2"): Promise<ScenarioResult> {
  const mirror = mirrorKey ?? h.mirrorKeys[0];
  const findings: string[] = [];
  const home = h.home;

  log.banner(`Scenario ${label} — swap round trip from ${h.name(mirror)} (ZERO local liquidity)`);

  const userAddr = h.userAddress;
  const userOnMirror = h.user(mirror);
  const requestAddr = h.addr(mirror, "SwapRequest");
  const mirrorToken = h.addr(mirror, "TokenizedStock");

  // ---------------------------------------------------------------- premise check

  log.group("premise: the mirror chain has no liquidity");
  const premise = await h.assertNoLocalLiquidity(mirror);
  findings.push(...premise);
  const mirrorContracts = Object.keys(h.manifest.chains[mirror].contracts);
  log.kv("contracts on mirror", mirrorContracts.join(", "));
  log.kv("quote asset there", "none — USDC exists only on the home chain");
  log.kv("pool there", "none");
  if (premise.length === 0) log.ok("mirror chain confirmed free of any local liquidity");
  else for (const f of premise) log.fail(f);
  log.groupEnd();

  // ---------------------------------------------------------------- fund the user

  const userStake = parseUnits("500", h.tokenDecimals);
  const alreadyHeld = await h.tokenBalance(mirror, userAddr);

  if (alreadyHeld < userStake) {
    log.group("setup: give the user tAAPL on the mirror chain");
    const need = userStake - alreadyHeld;
    const options = Options.new().addExecutorLzReceive(200_000n).build();
    const sendParam = {
      dstEid: h.eid(mirror),
      to: toBytes32(userAddr),
      amountLD: need,
      minAmountLD: 0n,
      extraOptions: options,
      composeMsg: "0x" as const,
      oftCmd: "0x" as const,
    };
    const oft = h.addr(home.key, "TokenizedStock");
    const fee = await home.read<{ nativeFee: bigint; lzTokenFee: bigint }>(oft, OFT_ABI, "quoteSend", [
      sendParam,
      false,
    ]);
    await home.write(oft, OFT_ABI, "send", [sendParam, fee, home.deployer], fee.nativeFee);
    await h.waitFor("user funding to arrive", async () => (await h.tokenBalance(mirror, userAddr)) >= userStake);
    log.ok(`user funded with ${h.fmtToken(userStake)} on ${h.name(mirror)}`);
    log.groupEnd();
  }

  // ---------------------------------------------------------------- pre-trade state

  const amountIn = parseUnits("100", h.tokenDecimals);
  const spotBefore = await h.spotPrice();
  const expectedOut = Number(formatUnits(amountIn, h.tokenDecimals)) * spotBefore;
  // 5% floor: loose enough to fill, tight enough that a broken swap cannot pass.
  const minAmountOut = parseUnits((expectedOut * 0.95).toFixed(h.quoteDecimals), h.quoteDecimals);

  const before = {
    userMirrorToken: await h.tokenBalance(mirror, userAddr),
    userHomeQuote: await h.quoteBalance(userAddr),
    userHomeToken: await h.tokenBalance(home.key, userAddr),
    poolBase: await h.tokenBalance(home.key, h.manifest.pool!.address as Address),
    supply: (await h.totalSupplyAcrossChains()).total,
  };

  log.group("before the trade");
  log.kv("user tAAPL on mirror", h.fmtToken(before.userMirrorToken));
  log.kv("user USDC on home", h.fmtQuote(before.userHomeQuote));
  log.kv("pool spot price", `${spotBefore.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("selling", h.fmtToken(amountIn));
  log.kv("expected out @ spot", `${expectedOut.toFixed(6)} ${h.quoteSymbol}`);
  log.kv("minAmountOut (5% floor)", h.fmtQuote(minAmountOut));
  log.groupEnd();

  // ---------------------------------------------------------------- submit the trade

  const requestAbi = forgeArtifact("SwapRequest").abi;
  await userOnMirror.write(mirrorToken, OFT_ABI, "approve", [requestAddr, amountIn]);

  const fee = await userOnMirror.read<{ nativeFee: bigint; lzTokenFee: bigint }>(
    requestAddr,
    requestAbi,
    "quoteSwap",
    [amountIn, minAmountOut, userAddr]
  );
  log.kv("round-trip LZ fee", `${formatUnits(fee.nativeFee, 18)} ETH (paid once, on the mirror chain)`);

  const nextId = await userOnMirror.read<bigint>(requestAddr, requestAbi, "nextRequestId");

  const t0 = Date.now();
  const reqReceipt = await userOnMirror.write(
    requestAddr,
    requestAbi,
    "requestSwap",
    [amountIn, minAmountOut, userAddr],
    fee.nativeFee
  );
  const requestGas = reqReceipt.gasUsed;

  // ---------------------------------------------------------------- funds locked?

  const afterSubmit = {
    userMirrorToken: await h.tokenBalance(mirror, userAddr),
  };
  const locked = before.userMirrorToken - afterSubmit.userMirrorToken;
  log.group("input committed on the mirror chain");
  log.kv("user tAAPL now", h.fmtToken(afterSubmit.userMirrorToken));
  log.kv("committed", h.fmtToken(locked));
  log.groupEnd();

  if (locked !== amountIn) findings.push(`user was debited ${locked}, expected ${amountIn}`);

  const pending = await h.getRequest(mirror, nextId);
  if (Number(pending.status) !== Status.PENDING && Number(pending.status) !== Status.FILLED) {
    findings.push(`request ${nextId} status is ${pending.status}, expected PENDING or FILLED`);
  }

  // ---------------------------------------------------------------- wait for settlement

  const { ok, elapsedMs } = await h.waitFor(
    "settlement to reach the mirror chain",
    async () => Number((await h.getRequest(mirror, nextId)).status) !== Status.PENDING
  );
  const latencyMs = Date.now() - t0;

  const settled = await h.getRequest(mirror, nextId);
  const after = {
    userHomeQuote: await h.quoteBalance(userAddr),
    poolBase: await h.tokenBalance(home.key, h.manifest.pool!.address as Address),
    supply: (await h.totalSupplyAcrossChains()).total,
  };
  const spotAfter = await h.spotPrice();

  const quoteReceived = after.userHomeQuote - before.userHomeQuote;
  const poolBaseDelta = after.poolBase - before.poolBase;

  // ---------------------------------------------------------------- results

  log.group("settlement");
  log.kv("status", Status[Number(settled.status)] ?? String(settled.status));
  log.kv("amountIn (recorded)", h.fmtToken(settled.amountIn));
  log.kv("amountOut (recorded)", h.fmtQuote(settled.amountOut));
  log.kv("USDC delivered on home", h.fmtQuote(quoteReceived));
  log.kv("pool base reserve delta", h.fmtToken(poolBaseDelta));
  log.kv("spot before → after", `${spotBefore.toFixed(6)} → ${spotAfter.toFixed(6)}`);
  log.kv("round-trip latency", `${latencyMs} ms`);
  log.kv("requestSwap gas", requestGas.toString());
  log.groupEnd();

  const executed = Number(formatUnits(settled.amountOut, h.quoteDecimals));
  const effectivePrice = executed / Number(formatUnits(amountIn, h.tokenDecimals));
  const slippagePct = ((spotBefore - effectivePrice) / spotBefore) * 100;

  log.group("execution quality");
  log.kv("effective price", `${effectivePrice.toFixed(6)} ${h.quoteSymbol} per ${h.tokenSymbol}`);
  log.kv("vs spot before", `${slippagePct.toFixed(4)}% (fee + price impact)`);
  log.groupEnd();

  // ---------------------------------------------------------------- assertions

  if (Number(settled.status) !== Status.FILLED) {
    findings.push(`request settled as ${Status[Number(settled.status)]}, expected FILLED`);
  }
  if (settled.amountOut === 0n) findings.push("settlement reported zero amountOut");
  if (settled.amountOut < minAmountOut) {
    findings.push(`amountOut ${settled.amountOut} is below the minAmountOut floor ${minAmountOut}`);
  }
  if (quoteReceived !== settled.amountOut) {
    findings.push(
      `USDC delivered on home (${quoteReceived}) does not match the amount the mirror was told ` +
        `(${settled.amountOut}) — the receipt must reflect reality`
    );
  }
  if (poolBaseDelta !== settled.amountIn) {
    findings.push(
      `pool base reserve moved by ${poolBaseDelta} but the request recorded ${settled.amountIn} — ` +
        `the swap did not execute against the pool as claimed`
    );
  }
  if (spotAfter >= spotBefore) {
    findings.push(`spot price did not fall after a sell (${spotBefore} → ${spotAfter}) — no real price impact`);
  }
  if (after.supply !== before.supply) {
    findings.push(`aggregate supply changed ${before.supply} → ${after.supply}`);
  }
  const quoteOnMirror = h.manifest.chains[mirror].contracts["QuoteAsset"];
  if (quoteOnMirror) findings.push("mirror chain has a quote asset deployed — zero-liquidity premise broken");

  const passed = ok && findings.length === 0;

  if (passed) {
    log.ok("CORE PROOF: a trade submitted from a chain with zero liquidity executed on the home");
    log.ok("chain's pool and returned a real, authenticated result to the originating chain.");
  } else {
    for (const f of findings) log.fail(f);
  }

  return {
    name: `${label}. Full swap-relay round trip (CORE PROOF)`,
    passed,
    detail: passed
      ? `${h.fmtToken(amountIn)} sold from ${h.name(mirror)} (no local liquidity) → ` +
        `${h.fmtQuote(settled.amountOut)} delivered on ${h.name(home.key)} in ${latencyMs}ms`
      : findings.join("; ") || "timed out waiting for settlement",
    metrics: {
      mirrorChain: h.name(mirror),
      amountIn: h.fmtToken(amountIn),
      amountOut: h.fmtQuote(settled.amountOut),
      effectivePrice: effectivePrice.toFixed(6),
      spotBefore: spotBefore.toFixed(6),
      spotAfter: spotAfter.toFixed(6),
      slippagePct: `${slippagePct.toFixed(4)}%`,
      latencyMs,
      requestGas: requestGas.toString(),
      lzFeeEth: formatUnits(fee.nativeFee, 18),
    },
    findings,
  };
}
