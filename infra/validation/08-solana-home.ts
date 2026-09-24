/**
 * SCENARIO 8 — Solana as the HOME chain.
 *
 * The core proof with the market on Solana: users on EVM chains, which have no pool, buy and
 * sell against an Orca Whirlpool on Solana through `swap_relay`. The mirrors' contracts are
 * exactly the ones an EVM home uses — a SwapRequest does not know or care what VM its home
 * chain runs; it addresses the relay by eid.
 *
 *   a. BUY    — USDC in on an EVM mirror, tAAPL out on that mirror, priced by the Whirlpool
 *   b. REFUND — an unsatisfiable floor; the relay quotes BEFORE swapping (Solana cannot catch a
 *               failed swap) and returns the USDC in full
 *   c. SELL   — tAAPL in on the mirror, USDC out on the mirror
 *   d. SUPPLY — the whole supply was minted on Solana; after all of the above it is exactly
 *               accounted for across VMs, Solana's 9-decimal mint rescaled to the mirrors' 18
 *
 * The local message library charges a real fee per send, so (a) also proves the relay's return
 * leg paid it: the library's balance rises by exactly one fee over the trade.
 *
 * Only runs when the home chain is Solana.
 */
import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { createNoopSigner, publicKey } from "@metaplex-foundation/umi";
import { toWeb3JsInstruction } from "@metaplex-foundation/umi-web3js-adapters";
import { oft } from "@layerzerolabs/oft-v2-solana-sdk";
import { MessageLibPDA } from "@layerzerolabs/lz-solana-sdk-v2/umi";
import { formatUnits, parseUnits, type Address } from "viem";

import type { Harness, ScenarioResult } from "./harness.js";
import { Direction, Status } from "./harness.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { Options } from "../lib/options.js";
import { SolanaChain } from "../solana/chain.js";
import { lzLocal, SIMPLE_MESSAGELIB_PROGRAM_ID } from "../solana/lz-local.js";
import { localMessageLibFee } from "../lib/svm-executor.js";
import { ataOf } from "../solana/client.js";
import { solanaManifestPath } from "../solana/setup.js";
import type { SolanaHomeDeployment } from "../solana/home.js";
import { log } from "../lib/logger.js";

const NAME = "8. Solana home (buy, refund, sell from EVM mirrors; cross-VM supply)";

export async function scenario8(h: Harness): Promise<ScenarioResult> {
  const homeCfg = h.config.homeChain;
  if ((homeCfg.vm ?? "evm") !== "svm") {
    return { name: NAME, passed: true, detail: "skipped — the home chain is not Solana", metrics: {}, findings: [] };
  }
  const sol = new SolanaChain(homeCfg);
  const home: SolanaHomeDeployment = JSON.parse(readFileSync(solanaManifestPath(h.config, homeCfg.key), "utf8"));
  const mirror = h.mirrorKeys[0];
  const where = h.name(mirror);
  log.banner(`Scenario 8 — trading from ${where} against a pool on ${homeCfg.name}`);

  const findings: string[] = [];
  const metrics: Record<string, string | number> = {};
  const user = h.user(mirror);
  const userAddr = h.userAddress;
  const request = h.addr(mirror, "SwapRequest");
  const requestAbi = forgeArtifact("SwapRequest").abi;
  const tokenAbi = forgeArtifact("OmniToken").abi;
  const stockOnMirror = h.addr(mirror, "TokenizedStock");
  const quoteOnMirror = h.addr(mirror, "QuoteAsset");
  const bal = (token: Address) => h.chain(mirror).read<bigint>(token, tokenAbi, "balanceOf", [userAddr]);

  // The premise: nothing on the mirror can price the asset.
  for (const f of await h.assertNoLocalMarket(mirror)) findings.push(f);

  /** Bridges from the Solana deployer's genesis balance to the user on the mirror. */
  const fund = async (asset: "base" | "quote", whole: string) => {
    const a = home.assets[asset];
    const amountLd = parseUnits(whole, a.decimals);
    const sendParams = {
      dstEid: h.eid(mirror),
      to: Buffer.from(userAddr.slice(2).padStart(64, "0"), "hex"),
      amountLd,
      minAmountLd: amountLd,
      options: Buffer.from(Options.new().addExecutorLzReceive(200_000n).build().slice(2), "hex"),
    };
    // The local message library charges a real fee, so the send must quote and pay it.
    const { nativeFee } = await oft.quote(
      lzLocal(sol).rpc,
      { payer: publicKey(sol.payer.publicKey.toBase58()), tokenMint: publicKey(a.mint), tokenEscrow: publicKey(a.escrow) },
      sendParams,
      { oft: publicKey(home.programs.oft) }
    );
    const ix = await oft.send(
      lzLocal(sol).rpc,
      {
        payer: createNoopSigner(publicKey(sol.payer.publicKey.toBase58())),
        tokenMint: publicKey(a.mint),
        tokenEscrow: publicKey(a.escrow),
        tokenSource: publicKey(ataOf(sol.payer.publicKey, new PublicKey(a.mint)).toBase58()),
      },
      { ...sendParams, nativeFee },
      { oft: publicKey(home.programs.oft) }
    );
    const token = asset === "base" ? stockOnMirror : quoteOnMirror;
    const before = await bal(token);
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), toWeb3JsInstruction(ix.instruction));
    await sol.connection.confirmTransaction(await sol.connection.sendTransaction(tx, [sol.payer]), "confirmed");
    await h.waitFor(`${asset} to reach the user on ${where}`, async () => (await bal(token)) > before);
  };

  const trade = async (direction: Direction, amountIn: bigint, minOut: bigint) => {
    const tokenIn = direction === Direction.BUY ? quoteOnMirror : stockOnMirror;
    await user.write(tokenIn, tokenAbi, "approve", [request, amountIn]);
    const fee = await user.read<{ nativeFee: bigint }>(request, requestAbi, "quoteTrade", [direction, amountIn, minOut]);
    const id = (await user.read<bigint>(request, requestAbi, "nextRequestId")) as bigint;
    const t0 = Date.now();
    await user.write(request, requestAbi, direction === Direction.BUY ? "buy" : "sell", [amountIn, minOut], fee.nativeFee);
    await h.waitFor(`request ${id} to settle`, async () => (await h.getRequest(mirror, id)).status !== Status.PENDING);
    return { r: await h.getRequest(mirror, id), ms: Date.now() - t0 };
  };

  const spot = await whirlpoolSpot(sol, home);
  log.kv("pool", `${home.pool!.whirlpool} on ${homeCfg.name}, spot ${spot.toFixed(6)} ${h.quoteSymbol}/${h.tokenSymbol}`);

  // ---------------------------------------------------------------- a. BUY
  log.step(`a. BUY from ${where}`);
  await fund("quote", "15000");
  const spend = parseUnits("15000", h.quoteDecimals);
  const floor = parseUnits(((15000 / spot) * 0.95).toFixed(h.tokenDecimals), h.tokenDecimals);
  const stockBefore = await bal(stockOnMirror);
  const messageLib = new PublicKey(
    new MessageLibPDA(publicKey(SIMPLE_MESSAGELIB_PROGRAM_ID)).messageLib()[0].toString()
  );
  const libBefore = await sol.connection.getBalance(messageLib, "confirmed");
  const buy = await trade(Direction.BUY, spend, floor);
  const returnFee = BigInt((await sol.connection.getBalance(messageLib, "confirmed")) - libBefore);
  log.kv("return leg fee", `${returnFee} lamports, paid by the executor's payer`);
  if (returnFee !== localMessageLibFee(homeCfg)) {
    findings.push(`the return leg paid ${returnFee} lamports in messaging fees, expected ${localMessageLibFee(homeCfg)}`);
  }
  metrics["buy: return leg fee"] = `${returnFee} lamports`;
  const got = (await bal(stockOnMirror)) - stockBefore;
  log.kv("status", Status[buy.r.status]);
  log.kv("received", `${formatUnits(got, h.tokenDecimals)} ${h.tokenSymbol} on ${where}`);
  log.kv("round trip", `${buy.ms} ms`);
  if (buy.r.status !== Status.FILLED) findings.push(`buy settled ${Status[buy.r.status]}, expected FILLED`);
  if (got !== buy.r.amountOut) findings.push(`received ${got}, request records ${buy.r.amountOut}`);
  if (got < floor) findings.push(`received ${got}, below the floor ${floor}`);
  const price = 15000 / Number(formatUnits(got, h.tokenDecimals));
  metrics["buy: received"] = `${formatUnits(got, h.tokenDecimals)} ${h.tokenSymbol}`;
  metrics["buy: price"] = `${price.toFixed(6)} (spot ${spot.toFixed(6)})`;
  metrics["buy: round trip"] = `${buy.ms} ms`;

  // ---------------------------------------------------------------- b. REFUND
  log.step("b. unsatisfiable floor — the relay must refund without swapping");
  await fund("quote", "5000");
  const quoteBefore = await bal(quoteOnMirror);
  const refundSpend = parseUnits("5000", h.quoteDecimals);
  const refund = await trade(Direction.BUY, refundSpend, parseUnits("1000000", h.tokenDecimals));
  const back = (await bal(quoteOnMirror)) - (quoteBefore - refundSpend);
  log.kv("status", Status[refund.r.status]);
  log.kv("returned", `${formatUnits(back, h.quoteDecimals)} ${h.quoteSymbol}`);
  if (refund.r.status !== Status.REFUNDED) findings.push(`refund settled ${Status[refund.r.status]}, expected REFUNDED`);
  if (back !== refundSpend) findings.push(`refund returned ${back}, expected ${refundSpend}`);
  metrics["refund: returned"] = `${formatUnits(back, h.quoteDecimals)} ${h.quoteSymbol}`;

  // ---------------------------------------------------------------- c. SELL
  log.step(`c. SELL from ${where}`);
  await fund("base", "20");
  const sellAmount = parseUnits("20", h.tokenDecimals);
  const spotSell = await whirlpoolSpot(sol, home);
  const sellFloor = parseUnits((20 * spotSell * 0.95).toFixed(h.quoteDecimals), h.quoteDecimals);
  const qBefore = await bal(quoteOnMirror);
  const sell = await trade(Direction.SELL, sellAmount, sellFloor);
  const proceeds = (await bal(quoteOnMirror)) - qBefore;
  log.kv("status", Status[sell.r.status]);
  log.kv("proceeds", `${formatUnits(proceeds, h.quoteDecimals)} ${h.quoteSymbol} on ${where}`);
  if (sell.r.status !== Status.FILLED) findings.push(`sell settled ${Status[sell.r.status]}, expected FILLED`);
  if (proceeds !== sell.r.amountOut) findings.push(`proceeds ${proceeds} differ from the request's ${sell.r.amountOut}`);
  if (proceeds < sellFloor) findings.push(`proceeds ${proceeds} below the floor ${sellFloor}`);
  metrics["sell: proceeds"] = `${formatUnits(proceeds, h.quoteDecimals)} ${h.quoteSymbol}`;

  // ---------------------------------------------------------------- d. SUPPLY
  log.step("d. omnichain supply, across VMs (minted on Solana)");
  for (const [asset, contract, evmDec, initial] of [
    ["base", "TokenizedStock", h.tokenDecimals, h.config.token.initialSupply],
    ["quote", "QuoteAsset", h.quoteDecimals, h.config.quoteAsset.initialSupply],
  ] as const) {
    const s = (await sol.connection.getTokenSupply(new PublicKey(home.assets[asset].mint))).value;
    const onSolana = BigInt(s.amount) * 10n ** BigInt(evmDec - s.decimals);
    let onMirrors = 0n;
    for (const k of h.mirrorKeys) onMirrors += await h.chain(k).read<bigint>(h.addr(k, contract), tokenAbi, "totalSupply");
    const genesis = parseUnits(initial, evmDec);
    log.kv(contract, `Solana ${formatUnits(onSolana, evmDec)} + mirrors ${formatUnits(onMirrors, evmDec)} = ${formatUnits(onSolana + onMirrors, evmDec)}`);
    if (onSolana + onMirrors !== genesis) findings.push(`${contract}: ${onSolana + onMirrors} across VMs, minted ${genesis}`);
  }

  const passed = findings.length === 0;
  if (passed) log.ok(`users on ${where} traded against a pool on ${homeCfg.name} — no market where they stood`);
  else for (const f of findings) log.fail(f);
  return {
    name: NAME,
    passed,
    detail: passed
      ? `15000 ${h.quoteSymbol} spent on ${where} → ${formatUnits(got, h.tokenDecimals)} ${h.tokenSymbol}, priced by an Orca Whirlpool on ${homeCfg.name}, in ${buy.ms}ms`
      : findings.join("; "),
    metrics,
    findings,
  };
}

/** Quote per base, from the Whirlpool's sqrt price (Q64.64, B per A in raw units). */
async function whirlpoolSpot(sol: SolanaChain, home: SolanaHomeDeployment): Promise<number> {
  const d = (await sol.connection.getAccountInfo(new PublicKey(home.pool!.whirlpool)))!.data;
  const sqrt = Number(d.readBigUInt64LE(65) + (d.readBigUInt64LE(73) << 64n)) / 2 ** 64;
  const baseIsA = home.pool!.mintA === home.assets.base.mint;
  const [decA, decB] = baseIsA
    ? [home.assets.base.decimals, home.assets.quote.decimals]
    : [home.assets.quote.decimals, home.assets.base.decimals];
  const bPerA = sqrt * sqrt * 10 ** (decA - decB);
  return baseIsA ? bPerA : 1 / bPerA;
}
