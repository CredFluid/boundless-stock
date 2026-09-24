/**
 * SCENARIO 7 — the core proof, from a Solana mirror.
 *
 * Scenarios 2, 3 and 6 again, but the user stands on Solana: a different VM, different
 * account model, different decimals (9 for the stock where the home chain uses 18), and
 * LayerZero's Solana OFT and endpoint in place of the EVM ones. Nothing about the home chain
 * changes — the same SwapRelay and the same Uniswap pool serve every mirror.
 *
 *   a. BUY  — USDC in on Solana, tAAPL out on Solana, priced by the home pool
 *   b. REFUND — an unsatisfiable floor; the USDC comes back across the bridge in full
 *   c. SELL — tAAPL in on Solana, USDC out on Solana
 *   e. STRANDED — the return leg cannot be sent; the home chain's notice reaches the Solana
 *      request, and a permissionless retry later delivers the result anyway
 *   f. CANCELLED — the order is never delivered; it is killed on the home chain and the input
 *      is minted back on Solana, exactly once
 *   g. SUPPLY — the omnichain supply of both assets is conserved ACROSS VMs, after rescaling
 *      Solana's 9-decimal amounts to the home chain's 18
 *
 * Skipped (and reported as such) when the deployment has no Solana chain.
 */
import { formatUnits, parseEther, parseUnits, type Hex } from "viem";
import { PublicKey } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";

import type { Harness, ScenarioResult } from "./harness.js";
import { Options } from "../lib/options.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { SolanaDirection, SolanaStatus, type SolanaSwapClient } from "../solana/client.js";
import { log } from "../lib/logger.js";
import { localMessageLibFee } from "../lib/svm-executor.js";

const NAME = "7. Solana mirror (buy, refund, sell, strand, cancel, cross-VM supply)";

export async function scenario7(h: Harness): Promise<ScenarioResult> {
  const sol = h.solana[0];
  if (!sol) {
    log.banner(`Scenario 7 — skipped: no Solana chain in ${h.manifest.name}`);
    return { name: NAME, passed: true, detail: "skipped — no Solana chain configured", metrics: {}, findings: [] };
  }

  const where = sol.chain.config.name;
  log.banner(`Scenario 7 — trading from ${where}, a Solana chain with no market`);
  const findings: string[] = [];
  const metrics: Record<string, string | number> = {};

  const baseDec = (await sol.mintSupply("base")).decimals;
  const quoteDec = (await sol.mintSupply("quote")).decimals;
  const fmtBase = (n: bigint) => `${formatUnits(n, baseDec)} ${h.tokenSymbol}`;
  const fmtQuote = (n: bigint) => `${formatUnits(n, quoteDec)} ${h.quoteSymbol}`;
  log.kv("local decimals", `${h.tokenSymbol} ${baseDec} (home ${h.tokenDecimals}), ${h.quoteSymbol} ${quoteDec}`);

  // The premise: the only CrossStock state on Solana is token mints and a request program.
  // Its escrow holds nothing between trades — it is a conduit, not a market.
  for (const side of ["base", "quote"] as const) {
    const held = await sol.balance(sol.store, side);
    if (held !== 0n) findings.push(`${where} request store holds ${held} ${side} before the test`);
  }

  // Options for the leg to the home chain. The compose value is what funds the relay's return
  // leg, exactly as on an EVM mirror (see SwapRequest.setGasParams).
  const relay = h.config.relay;
  const options = Options.new()
    .addExecutorLzReceive(BigInt(relay.homeLzReceiveGas))
    .addExecutorLzCompose(0, BigInt(relay.homeComposeGas), parseEther(relay.homeComposeValue))
    .build();

  const user = await sol.newUser();
  const userId = `0x${Buffer.from(user.publicKey.toBytes()).toString("hex")}` as const;
  log.kv("user", `${user.publicKey.toBase58()} (fresh key, not the deployer)`);

  const settle = async (id: bigint): Promise<{ status: SolanaStatus; amountOut: bigint; ms: number }> => {
    const t0 = Date.now();
    const { ok } = await h.waitFor(`request ${id} to settle`, async () => {
      const r = await sol.getRequest(id);
      return r !== null && r.status !== SolanaStatus.Pending;
    });
    const r = await sol.getRequest(id);
    if (!ok || !r) return { status: SolanaStatus.Pending, amountOut: 0n, ms: Date.now() - t0 };
    return { status: r.status, amountOut: r.amountOut, ms: Date.now() - t0 };
  };

  const fund = async (side: "base" | "quote", amountHome: bigint, expectLocal: bigint): Promise<void> => {
    const before = await sol.balance(user.publicKey, side);
    await h.bridgeFromHomeTo(sol.eid, userId, side === "base" ? "TokenizedStock" : "QuoteAsset", amountHome);
    await h.waitFor(`${side} to reach the Solana user`, async () => (await sol.balance(user.publicKey, side)) >= before + expectLocal);
  };

  // ---------------------------------------------------------------- a. BUY
  log.step("a. BUY from Solana");
  const spend = parseUnits("15000", quoteDec);
  await fund("quote", parseUnits("15000", h.quoteDecimals), spend);
  log.ok(`user holds ${fmtQuote(await sol.balance(user.publicKey, "quote"))} on ${where}`);

  const spot = await h.spotPrice();
  const expectedOut = 15000 / spot;
  const floor = parseUnits((expectedOut * 0.95).toFixed(baseDec), baseDec);
  const buy = await openAndSettle(sol, user, SolanaDirection.Buy, spend, floor, options, settle);
  const gotStock = await sol.balance(user.publicKey, "base");
  log.kv("status", SolanaStatus[buy.status]);
  log.kv("received", `${fmtBase(gotStock)} on ${where}`);
  log.kv("round trip", `${buy.ms} ms`);
  if (buy.status !== SolanaStatus.Filled) findings.push(`buy settled ${SolanaStatus[buy.status]}, expected Filled`);
  if (gotStock !== buy.amountOut) findings.push(`user holds ${gotStock}, request records ${buy.amountOut}`);
  if (gotStock < floor) findings.push(`received ${gotStock}, below the floor ${floor}`);
  // The local library charges a real fee; the send only went through because it was quoted.
  log.kv("messaging fee", `${buy.fee} lamports, quoted and paid by the user`);
  if (buy.fee !== localMessageLibFee(sol.chain.config)) {
    findings.push(`open_request paid ${buy.fee} lamports in messaging fees, expected ${localMessageLibFee(sol.chain.config)}`);
  }
  if ((await sol.balance(user.publicKey, "quote")) !== 0n) findings.push("USDC left in the user's wallet after a full buy");
  const price = Number(formatUnits(spend, quoteDec)) / Number(formatUnits(gotStock, baseDec));
  metrics["buy: received"] = fmtBase(gotStock);
  metrics["buy: price"] = `${price.toFixed(6)} ${h.quoteSymbol}/${h.tokenSymbol} (spot ${spot.toFixed(6)})`;
  metrics["buy: round trip"] = `${buy.ms} ms`;

  // ---------------------------------------------------------------- b. REFUND
  log.step("b. unsatisfiable floor — expect a full refund");
  const refundSpend = parseUnits("5000", quoteDec);
  await fund("quote", parseUnits("5000", h.quoteDecimals), refundSpend);
  const stockBeforeRefund = await sol.balance(user.publicKey, "base");
  const refund = await openAndSettle(
    sol, user, SolanaDirection.Buy, refundSpend, parseUnits("1000000", baseDec), options, settle
  );
  const quoteBack = await sol.balance(user.publicKey, "quote");
  log.kv("status", SolanaStatus[refund.status]);
  log.kv("returned", fmtQuote(quoteBack));
  if (refund.status !== SolanaStatus.Refunded) findings.push(`bad-slippage buy settled ${SolanaStatus[refund.status]}, expected Refunded`);
  if (quoteBack !== refundSpend) findings.push(`refund returned ${quoteBack}, expected ${refundSpend}`);
  if ((await sol.balance(user.publicKey, "base")) !== stockBeforeRefund) findings.push("stock changed on a refunded buy");
  metrics["refund: returned"] = fmtQuote(quoteBack);

  // ---------------------------------------------------------------- c. SELL
  log.step("c. SELL from Solana");
  const sellAmount = parseUnits("20", baseDec);
  await fund("base", parseUnits("20", h.tokenDecimals), sellAmount);
  const quoteBeforeSell = await sol.balance(user.publicKey, "quote");
  const spotSell = await h.spotPrice();
  const sellFloor = parseUnits((20 * spotSell * 0.95).toFixed(quoteDec), quoteDec);
  const sell = await openAndSettle(sol, user, SolanaDirection.Sell, sellAmount, sellFloor, options, settle);
  const proceeds = (await sol.balance(user.publicKey, "quote")) - quoteBeforeSell;
  log.kv("status", SolanaStatus[sell.status]);
  log.kv("proceeds", `${fmtQuote(proceeds)} on ${where}`);
  if (sell.status !== SolanaStatus.Filled) findings.push(`sell settled ${SolanaStatus[sell.status]}, expected Filled`);
  if (proceeds !== sell.amountOut) findings.push(`proceeds ${proceeds} differ from the request's ${sell.amountOut}`);
  if (proceeds < sellFloor) findings.push(`proceeds ${proceeds} below the floor ${sellFloor}`);
  metrics["sell: proceeds"] = fmtQuote(proceeds);

  // ---------------------------------------------------------------- e. STRANDED
  log.step("e. STRANDED — the return leg cannot be sent");
  const relayAbi = forgeArtifact("SwapRelay").abi;
  const relayAddr = h.addr(h.home.key, "SwapRelay");
  const homeStockOft = h.oftAddr(h.home.key, "TokenizedStock");
  const oftAbi = forgeArtifact("TokenizedStock").abi;
  const solBaseStore = `0x${Buffer.from(new PublicKey(sol.deployment.assets.base.oftStore).toBytes()).toString("hex")}` as Hex;

  // Unpeer the home stock OFT from Solana: quoting the return fails, so the relay strands it
  // and sends the plain STRANDED notice instead — the path under test.
  const strandSpend = parseUnits("3000", quoteDec);
  await fund("quote", parseUnits("3000", h.quoteDecimals), strandSpend);
  await h.home.write(homeStockOft, oftAbi, "setPeer", [sol.eid, `0x${"00".repeat(32)}`]);
  const stranded = await openAndSettle(sol, user, SolanaDirection.Buy, strandSpend, 1n, options, settle);
  await h.home.write(homeStockOft, oftAbi, "setPeer", [sol.eid, solBaseStore]);
  const strandedId = (await sol.nextRequestId()) - 1n;
  const held = await h.home.read<bigint>(relayAddr, relayAbi, "stranded", [sol.eid, strandedId]);
  log.kv("status", SolanaStatus[stranded.status]);
  log.kv("held on home chain", `${formatUnits(held, h.tokenDecimals)} ${h.tokenSymbol}`);
  if (stranded.status !== SolanaStatus.Stranded) findings.push(`strand settled ${SolanaStatus[stranded.status]}, expected Stranded`);
  if (held === 0n) findings.push("nothing recorded as stranded on the home chain");

  // Peer restored: anyone may retry, and the result reaches the user as a late settlement.
  const stockBeforeRetry = await sol.balance(user.publicKey, "base");
  await h.home.write(relayAddr, relayAbi, "retryReturn", [sol.eid, strandedId]);
  const { ok: retried } = await h.waitFor("the retried return to reach Solana", async () =>
    (await sol.balance(user.publicKey, "base")) > stockBeforeRetry);
  const recovered = (await sol.balance(user.publicKey, "base")) - stockBeforeRetry;
  log.kv("recovered by retry", fmtBase(recovered));
  if (!retried || recovered === 0n) findings.push("retryReturn did not deliver the stranded result to Solana");
  metrics["stranded: recovered by retry"] = fmtBase(recovered);

  // ---------------------------------------------------------------- f. CANCELLED
  log.step("f. CANCELLED — the order never arrives");
  const cancelSpend = parseUnits("2000", quoteDec);
  await fund("quote", parseUnits("2000", h.quoteDecimals), cancelSpend);
  const { requestId: cancelId } = await sol.openRequest(user, SolanaDirection.Buy, cancelSpend, 1n, options);
  const quoteAfterSubmit = await sol.balance(user.publicKey, "quote");
  // Stand in for a message that is never delivered: the relayer moves past it.
  await h.relayer!.syncToHead();
  const pending = (await sol.getRequest(cancelId))!;
  log.kv("stalled", `request ${cancelId}, LayerZero nonce ${pending.lzNonce}`);

  // Kill it on the home chain, then deliver only the notice.
  const solQuoteStore = `0x${Buffer.from(new PublicKey(sol.deployment.assets.quote.oftStore).toBytes()).toString("hex")}` as Hex;
  await h.home.write(relayAddr, relayAbi, "cancelStuckInbound", [
    sol.eid,
    solQuoteStore,
    h.oftAddr(h.home.key, "QuoteAsset"),
    pending.lzNonce,
    `0x${"00".repeat(32)}`,
  ]);
  const cancelled = await settle(cancelId);
  const restored = (await sol.balance(user.publicKey, "quote")) - quoteAfterSubmit;
  log.kv("status", SolanaStatus[cancelled.status]);
  log.kv("restored", fmtQuote(restored));
  if (cancelled.status !== SolanaStatus.Cancelled) findings.push(`cancellation settled ${SolanaStatus[cancelled.status]}, expected Cancelled`);
  if (restored !== cancelSpend) findings.push(`cancellation restored ${restored}, expected ${cancelSpend}`);
  metrics["cancelled: restored"] = fmtQuote(restored);

  // ---------------------------------------------------------------- g. SUPPLY across VMs
  log.step("g. omnichain supply, across VMs");
  for (const [side, contract, homeDec, initial] of [
    ["base", "TokenizedStock", h.tokenDecimals, h.config.token.initialSupply],
    ["quote", "QuoteAsset", h.quoteDecimals, h.config.quoteAsset.initialSupply],
  ] as const) {
    const evm = (await h.totalSupplyAcrossChains(contract)).total;
    // Every Solana chain of the deployment, each rescaled to home decimals.
    let onSolana = 0n;
    for (const c of h.solana) {
      const s = await c.mintSupply(side);
      onSolana += s.amount * 10n ** BigInt(homeDec - s.decimals);
    }
    const genesis = parseUnits(initial, homeDec);
    const total = evm + onSolana;
    log.kv(`${contract}`, `EVM ${formatUnits(evm, homeDec)} + Solana ${formatUnits(onSolana, homeDec)} = ${formatUnits(total, homeDec)}`);
    if (total !== genesis) findings.push(`${contract}: ${total} across VMs, minted ${genesis}`);
  }

  const passed = findings.length === 0;
  if (passed) log.ok(`a user on ${where} bought, was refunded, and sold — all priced by the home pool`);
  else for (const f of findings) log.fail(f);

  return {
    name: NAME,
    passed,
    detail: passed
      ? `${fmtQuote(spend)} spent on ${where} (no market) → ${fmtBase(gotStock)} delivered there, in ${buy.ms}ms`
      : findings.join("; "),
    metrics,
    findings,
  };
}

async function openAndSettle(
  sol: SolanaSwapClient,
  user: Keypair,
  direction: SolanaDirection,
  amountIn: bigint,
  minOut: bigint,
  options: `0x${string}`,
  settle: (id: bigint) => Promise<{ status: SolanaStatus; amountOut: bigint; ms: number }>
): Promise<{ status: SolanaStatus; amountOut: bigint; ms: number; fee: bigint }> {
  const t0 = Date.now();
  const { requestId, nativeFee } = await sol.openRequest(user, direction, amountIn, minOut, options);
  const r = await settle(requestId);
  return { ...r, ms: Date.now() - t0, fee: nativeFee };
}
