/**
 * SCENARIO 9 — Solana to Solana.
 *
 * A deployment can hold several Solana chains. This proves messages and tokens move directly
 * between two of them — no EVM chain in the path — and that a user on a Solana mirror trades
 * through it:
 *
 *   Solana home + a Solana mirror
 *     a. FUND  — USDC bridged from the Solana home to a user on the Solana mirror (SVM → SVM)
 *     b. BUY   — the user buys from that mirror; the order crosses SVM → SVM, is filled by the
 *                Orca Whirlpool through `swap_relay`, and the stock crosses back SVM → SVM
 *     c. SELL  — and sells some of it back
 *
 *   EVM home + two Solana mirrors
 *     a. FUND  — USDC bridged from the EVM home to a user on Solana mirror A, who sends it on to
 *                a user on Solana mirror B (SVM → SVM)
 *     b, c.    — as above, from mirror B, against the EVM home's pool
 *
 *   d. SUPPLY — conserved across every chain of every VM
 *
 * Skipped when the deployment has no such pair.
 */
import { readFileSync } from "node:fs";
import { PublicKey, type Keypair } from "@solana/web3.js";
import { formatUnits, parseEther, parseUnits, type Hex } from "viem";

import type { Harness, ScenarioResult } from "./harness.js";
import { Options } from "../lib/options.js";
import { maxReturnFee, svmExecutor } from "../lib/svm-executor.js";
import { SolanaChain } from "../solana/chain.js";
import { sendOftFromSolana, SolanaDirection, SolanaStatus, type SolanaSwapClient } from "../solana/client.js";
import { solanaManifestPath } from "../solana/setup.js";
import type { SolanaHomeDeployment } from "../solana/home.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { whirlpoolSpot } from "./08-solana-home.js";
import { log } from "../lib/logger.js";

const NAME = "9. Solana to Solana (SVM ↔ SVM transfers; trading from a Solana mirror)";

export async function scenario9(h: Harness): Promise<ScenarioResult> {
  const homeCfg = h.config.homeChain;
  const solanaHome = (homeCfg.vm ?? "evm") === "svm";
  const enough = solanaHome ? h.solana.length >= 1 : h.solana.length >= 2;
  if (!enough) {
    const why = solanaHome ? "no Solana mirror of the Solana home" : "fewer than two Solana chains";
    return { name: NAME, passed: true, detail: `skipped — ${why}`, metrics: {}, findings: [] };
  }

  const target = solanaHome ? h.solana[0] : h.solana[1];
  const where = target.chain.config.name;
  log.banner(`Scenario 9 — ${solanaHome ? `${homeCfg.name} ↔ ${where}` : `${h.solana[0].chain.config.name} → ${where}`}`);
  const findings: string[] = [];
  const metrics: Record<string, string | number> = {};

  const baseDec = (await target.mintSupply("base")).decimals;
  const quoteDec = (await target.mintSupply("quote")).decimals;
  const fmtBase = (n: bigint) => `${formatUnits(n, baseDec)} ${h.tokenSymbol}`;
  const fmtQuote = (n: bigint) => `${formatUnits(n, quoteDec)} ${h.quoteSymbol}`;
  const toSolanaOptions = (cfg: typeof homeCfg) => {
    const ex = svmExecutor(cfg);
    return Buffer.from(Options.new().addExecutorLzReceive(ex.lzReceiveComputeUnits, ex.lzReceiveValueLamports).build().slice(2), "hex");
  };
  const user = await target.newUser();

  // ---------------------------------------------------------------- a. FUND, SVM → SVM
  const amount = 15_000;
  log.step(`a. ${amount} ${h.quoteSymbol} to a user on ${where}, Solana to Solana`);
  const quoteBefore = await target.balance(user.publicKey, "quote");
  let home: SolanaHomeDeployment | undefined;
  let homeChain: SolanaChain | undefined;
  if (solanaHome) {
    home = JSON.parse(readFileSync(solanaManifestPath(h.config, homeCfg.key), "utf8")) as SolanaHomeDeployment;
    homeChain = new SolanaChain(homeCfg);
    await sendOftFromSolana(
      homeChain,
      homeChain.payer,
      home.assets.quote,
      home.programs.oft,
      target.eid,
      user.publicKey.toBytes(),
      parseUnits(String(amount), home.assets.quote.decimals),
      toSolanaOptions(target.chain.config)
    );
  } else {
    // EVM home → Solana A, then A → B by the user themselves.
    const a = h.solana[0];
    const userA = await a.newUser();
    const aBefore = await a.balance(userA.publicKey, "quote");
    const aAmount = parseUnits(String(amount), (await a.mintSupply("quote")).decimals);
    await h.bridgeFromHomeTo(a.eid, hex32(userA.publicKey.toBytes()), "QuoteAsset", parseUnits(String(amount), h.quoteDecimals));
    await h.waitFor(`${h.quoteSymbol} to reach the user on ${a.chain.config.name}`, async () =>
      (await a.balance(userA.publicKey, "quote")) >= aBefore + aAmount);
    await sendOftFromSolana(
      a.chain,
      userA,
      a.deployment.assets.quote,
      a.deployment.programs.oft,
      target.eid,
      user.publicKey.toBytes(),
      aAmount,
      toSolanaOptions(target.chain.config)
    );
    if ((await a.balance(userA.publicKey, "quote")) !== aBefore) findings.push(`the sender on ${a.chain.config.name} kept some of the transfer`);
  }
  const expected = parseUnits(String(amount), quoteDec);
  const { ok: funded, elapsedMs } = await h.waitFor(`${h.quoteSymbol} to reach the user on ${where}`, async () =>
    (await target.balance(user.publicKey, "quote")) >= quoteBefore + expected);
  const got = (await target.balance(user.publicKey, "quote")) - quoteBefore;
  log.kv("received", `${fmtQuote(got)} on ${where}, in ${elapsedMs} ms`);
  if (!funded || got !== expected) findings.push(`the SVM → SVM transfer delivered ${got}, expected ${expected}`);
  metrics["svm → svm: delivered"] = fmtQuote(got);

  // ---------------------------------------------------------------- b. BUY
  log.step(`b. BUY from ${where}`);
  const legHome = solanaHome
    ? (() => {
        const ex = svmExecutor(homeCfg);
        return Options.new()
          .addExecutorLzReceive(ex.lzReceiveComputeUnits)
          .addExecutorLzCompose(0, ex.lzComposeComputeUnits, maxReturnFee(homeCfg))
          .build();
      })()
    : Options.new()
        .addExecutorLzReceive(BigInt(h.config.relay.homeLzReceiveGas))
        .addExecutorLzCompose(0, BigInt(h.config.relay.homeComposeGas), parseEther(h.config.relay.homeComposeValue))
        .build();
  const spot = solanaHome ? await whirlpoolSpot(homeChain!, home!) : await h.spotPrice();
  const spend = parseUnits("10000", quoteDec);
  const floor = parseUnits(((10_000 / spot) * 0.95).toFixed(baseDec), baseDec);
  const buy = await trade(h, target, user, SolanaDirection.Buy, spend, floor, legHome);
  const stock = await target.balance(user.publicKey, "base");
  log.kv("status", SolanaStatus[buy.status]);
  log.kv("received", `${fmtBase(stock)} on ${where}, round trip ${buy.ms} ms`);
  if (buy.status !== SolanaStatus.Filled) findings.push(`buy settled ${SolanaStatus[buy.status]}, expected Filled`);
  if (stock !== buy.amountOut) findings.push(`user holds ${stock}, request records ${buy.amountOut}`);
  if (stock < floor) findings.push(`received ${stock}, below the floor ${floor}`);
  metrics["buy: received"] = fmtBase(stock);
  metrics["buy: round trip"] = `${buy.ms} ms`;

  // ---------------------------------------------------------------- c. SELL
  log.step(`c. SELL half of it from ${where}`);
  const sellAmount = stock / 2n;
  const spotSell = solanaHome ? await whirlpoolSpot(homeChain!, home!) : await h.spotPrice();
  const sellFloor = parseUnits(
    (Number(formatUnits(sellAmount, baseDec)) * spotSell * 0.95).toFixed(quoteDec),
    quoteDec
  );
  const quoteBeforeSell = await target.balance(user.publicKey, "quote");
  const sell = await trade(h, target, user, SolanaDirection.Sell, sellAmount, sellFloor, legHome);
  const proceeds = (await target.balance(user.publicKey, "quote")) - quoteBeforeSell;
  log.kv("status", SolanaStatus[sell.status]);
  log.kv("proceeds", fmtQuote(proceeds));
  if (sell.status !== SolanaStatus.Filled) findings.push(`sell settled ${SolanaStatus[sell.status]}, expected Filled`);
  if (proceeds !== sell.amountOut) findings.push(`proceeds ${proceeds} differ from the request's ${sell.amountOut}`);
  if (proceeds < sellFloor) findings.push(`proceeds ${proceeds} below the floor ${sellFloor}`);
  metrics["sell: proceeds"] = fmtQuote(proceeds);

  // ---------------------------------------------------------------- d. SUPPLY
  log.step("d. omnichain supply, across every chain");
  const tokenAbi = forgeArtifact("OmniToken").abi;
  for (const [side, contract, refDec, initial] of [
    ["base", "TokenizedStock", h.tokenDecimals, h.config.token.initialSupply],
    ["quote", "QuoteAsset", h.quoteDecimals, h.config.quoteAsset.initialSupply],
  ] as const) {
    if (solanaHome && home!.assets[side].mode === "adapt") continue; // scenario 8 checks the adapter
    const genesis = parseUnits(initial, refDec);
    let evm = 0n;
    if (solanaHome) {
      for (const k of h.mirrorKeys) evm += await h.chain(k).read<bigint>(h.addr(k, contract), tokenAbi, "totalSupply");
    } else {
      evm = (await h.totalSupplyAcrossChains(contract)).total;
    }
    let svm = 0n;
    const parts: string[] = [];
    if (solanaHome) {
      const s = (await homeChain!.connection.getTokenSupply(new PublicKey(home!.assets[side].mint))).value;
      const v = BigInt(s.amount) * 10n ** BigInt(refDec - s.decimals);
      svm += v;
      parts.push(`${homeCfg.name} ${formatUnits(v, refDec)}`);
    }
    for (const c of h.solana) {
      const s = await c.mintSupply(side);
      const v = s.amount * 10n ** BigInt(refDec - s.decimals);
      svm += v;
      parts.push(`${c.chain.config.name} ${formatUnits(v, refDec)}`);
    }
    log.kv(contract, `EVM ${formatUnits(evm, refDec)} + ${parts.join(" + ")} = ${formatUnits(evm + svm, refDec)}`);
    if (evm + svm !== genesis) findings.push(`${contract}: ${evm + svm} across every chain, minted ${genesis}`);
  }

  const passed = findings.length === 0;
  if (passed) log.ok(`tokens and orders moved Solana to Solana; a user on ${where} bought and sold`);
  else for (const f of findings) log.fail(f);
  return {
    name: NAME,
    passed,
    detail: passed ? `${fmtQuote(got)} moved SVM → SVM; ${fmtQuote(spend)} → ${fmtBase(stock)} on ${where}` : findings.join("; "),
    metrics,
    findings,
  };
}

const hex32 = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;

async function trade(
  h: Harness,
  sol: SolanaSwapClient,
  user: Keypair,
  direction: SolanaDirection,
  amountIn: bigint,
  minOut: bigint,
  options: Hex
): Promise<{ status: SolanaStatus; amountOut: bigint; ms: number }> {
  const t0 = Date.now();
  const { requestId } = await sol.openRequest(user, direction, amountIn, minOut, options);
  await h.waitFor(`request ${requestId} to settle`, async () => {
    const r = await sol.getRequest(requestId);
    return r !== null && r.status !== SolanaStatus.Pending;
  });
  const r = await sol.getRequest(requestId);
  return { status: r?.status ?? SolanaStatus.Pending, amountOut: r?.amountOut ?? 0n, ms: Date.now() - t0 };
}
