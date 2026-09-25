/**
 * Quotes for mirror-chain orders, computed the way the order will actually execute.
 *
 * The path an order takes, and so the path this follows:
 *   1. fees come off the input on the mirror (partner, then platform);
 *   2. what is left crosses to the home chain at the bridge's precision (shared decimals), the
 *      remainder returned to the user as dust;
 *   3. the home market swaps it — priced here by the market itself, not by a formula: on an EVM
 *      home the Uniswap pool runs the real swap in an `eth_call` (see `PoolQuoter.sol`), on a
 *      Solana home Orca's SDK quotes the live Whirlpool;
 *   4. the output crosses back at the bridge's precision and arrives in the mirror's decimals.
 */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as anchorNs from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import { buildWhirlpoolClient, swapQuoteByInputToken, IGNORE_CACHE, WhirlpoolContext } from "@orca-so/whirlpools-sdk";
import type { Quote, QuoteRequest, Side, TokenRef } from "@boundless-stock/sdk";

import { forgeArtifact } from "../lib/artifacts.js";
import { localDecimals, SHARED_DECIMALS } from "../lib/decimals.js";
import { vmOf } from "../lib/config.js";
import { readHomeMarket, solanaHome } from "../lib/market.js";
import { PARTNER_ABI } from "../lib/partners.js";
import { SolanaChain } from "../solana/chain.js";
import { WHIRLPOOL_PROGRAM_ID } from "../solana/ids.js";
import { SolanaDirection } from "../solana/client.js";
import { ApiError, isMirror, parseAmount, parseBps, type ApiContext } from "./context.js";
import { solanaOrderOptions } from "./options.js";

const anchor = ((anchorNs as { default?: typeof anchorNs }).default ?? anchorNs) as typeof anchorNs;

/** An address nothing lives at, where the quoter's code is placed for the call. */
const QUOTER_ADDRESS: Address = "0x00000000000000000000000000000000C0FFEE01";

const POOL_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const pow10 = (n: number) => 10n ** BigInt(n);

export interface Leg {
  side: Side;
  /** Decimals of input and output, on the mirror and at home. */
  dec: { inMirror: number; outMirror: number; inHome: number; outHome: number };
}

export async function quote(ctx: ApiContext, req: QuoteRequest): Promise<Quote> {
  const { cfg } = ctx;
  if (req.side !== "buy" && req.side !== "sell") throw new ApiError(400, "invalid_side", `side must be "buy" or "sell".`);
  const { vm } = isMirror(ctx, req.chain);
  const amountIn = parseAmount(req.amountIn, "amountIn");
  const slippageBps = parseBps(req.slippageBps, "slippageBps", 5_000, 50);
  const viaPartner = req.partnerId !== undefined;
  const partnerFeeBps = viaPartner ? parseBps(req.partnerFeeBps, "partnerFeeBps", 300, 0) : 0;

  const [inSide, outSide] = req.side === "buy" ? (["quote", "base"] as const) : (["base", "quote"] as const);
  const mirror = await mirrorTerms(ctx, req.chain, vm, req.partnerId);
  if (mirror.partnerRequired && !viaPartner) {
    throw new ApiError(400, "partner_required", `${mirror.name} accepts orders only through a partner; pass partnerId.`);
  }
  if (viaPartner && mirror.partnerMaxFeeBps !== undefined && partnerFeeBps > mirror.partnerMaxFeeBps) {
    throw new ApiError(400, "fee_too_high", `Partner ${req.partnerId} may charge at most ${mirror.partnerMaxFeeBps} bps.`);
  }

  // 1. fees. EVM charges the platform fee on every order; Solana only on partner orders.
  const platformBps = vm === "evm" || viaPartner ? mirror.platformFeeBps : 0;
  const partnerFee = (amountIn * BigInt(partnerFeeBps)) / 10_000n;
  const platformFee = (amountIn * BigInt(platformBps)) / 10_000n;
  const net = amountIn - partnerFee - platformFee;

  // 2. the bridge's precision
  const homeDec = homeDecimals(ctx);
  const dec = {
    inMirror: mirror.decimals[inSide],
    outMirror: mirror.decimals[outSide],
    inHome: homeDec[inSide],
    outHome: homeDec[outSide],
  };
  const qInMirror = pow10(dec.inMirror - SHARED_DECIMALS);
  const traded = net - (net % qInMirror);
  if (traded === 0n) throw new ApiError(400, "amount_too_small", "After fees, nothing is left above the bridge's precision.");
  const homeIn = (traded / qInMirror) * pow10(dec.inHome - SHARED_DECIMALS);

  // 3. the home market
  const homeOut = await homeSwap(ctx, inSide, homeIn);

  // 4. back across
  const expectedOut = (homeOut / pow10(dec.outHome - SHARED_DECIMALS)) * pow10(dec.outMirror - SHARED_DECIMALS);
  const qOutMirror = pow10(dec.outMirror - SHARED_DECIMALS);
  const floor = (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const minAmountOut = floor - (floor % qOutMirror);

  // prices, quote per unit of the stock
  const market = await readHomeMarket(cfg, ctx.manifest, ctx.evm);
  const spot = market?.price ?? 0;
  const whole = (n: bigint, d: number) => Number(n) / 10 ** d;
  const execution =
    req.side === "buy"
      ? whole(traded, dec.inMirror) / whole(expectedOut, dec.outMirror)
      : whole(expectedOut, dec.outMirror) / whole(traded, dec.inMirror);
  const impact = spot > 0 && Number.isFinite(execution) ? (req.side === "buy" ? execution / spot - 1 : 1 - execution / spot) : 0;

  const messagingFee = await messagingFeeFor(ctx, req.chain, vm, req.side, traded, minAmountOut);

  return {
    deployment: cfg.name,
    chain: req.chain,
    side: req.side,
    tokenIn: mirror.tokens[inSide],
    tokenOut: mirror.tokens[outSide],
    amountIn: amountIn.toString(),
    fees: { partner: partnerFee.toString(), platform: platformFee.toString() },
    traded: traded.toString(),
    dust: (net - traded).toString(),
    expectedAmountOut: expectedOut.toString(),
    minAmountOut: minAmountOut.toString(),
    slippageBps,
    spotPrice: spot.toString(),
    executionPrice: Number.isFinite(execution) ? execution.toString() : "0",
    priceImpactBps: Math.round(impact * 10_000),
    messagingFee,
    venue: vmOf(cfg.homeChain) === "svm" ? "Orca Whirlpool" : "Uniswap V3",
    quotedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------- mirror

export interface MirrorTerms {
  name: string;
  partnerRequired: boolean;
  platformFeeBps: number;
  /** The partner's fee ceiling, when a partner was named and is registered and active. */
  partnerMaxFeeBps?: number;
  decimals: { base: number; quote: number };
  tokens: { base: TokenRef; quote: TokenRef };
}

export async function mirrorTerms(ctx: ApiContext, chain: string, vm: "evm" | "svm", partnerId?: number): Promise<MirrorTerms> {
  const { cfg, manifest } = ctx;
  if (vm === "evm") {
    const c = manifest.chains[chain];
    const client = ctx.evm.get(chain)!;
    const request = c.contracts.SwapRequest as Address;
    const [partnerRequired, platformFeeBps] = await Promise.all([
      client.read<boolean>(request, PARTNER_ABI, "partnerRequired"),
      client.read<number>(request, PARTNER_ABI, "platformFeeBps"),
    ]);
    let partnerMaxFeeBps: number | undefined;
    if (partnerId !== undefined) {
      const [, , max, active] = await client.read<readonly [Address, Address, number, boolean]>(request, PARTNER_ABI, "partners", [partnerId]);
      if (!active) throw new ApiError(400, "unknown_partner", `Partner ${partnerId} is not active on ${c.name}.`);
      partnerMaxFeeBps = max;
    }
    const decimals = { base: localDecimals(cfg, client.config, "base"), quote: localDecimals(cfg, client.config, "quote") };
    return {
      name: c.name,
      partnerRequired,
      platformFeeBps,
      partnerMaxFeeBps,
      decimals,
      tokens: {
        base: { symbol: cfg.token.symbol, address: c.contracts.TokenizedStock, decimals: decimals.base },
        quote: { symbol: cfg.quoteAsset.symbol, address: c.contracts.QuoteAsset, decimals: decimals.quote },
      },
    };
  }
  const sol = ctx.solana.get(chain)!;
  const settings = await sol.partnerSettings();
  let partnerMaxFeeBps: number | undefined;
  if (partnerId !== undefined) {
    const p = await sol.getPartner(partnerId);
    if (!p?.active) throw new ApiError(400, "unknown_partner", `Partner ${partnerId} is not active on ${sol.chain.config.name}.`);
    partnerMaxFeeBps = p.maxFeeBps;
  }
  const [b, q] = await Promise.all([sol.mintSupply("base"), sol.mintSupply("quote")]);
  return {
    name: sol.chain.config.name,
    partnerRequired: settings.partnerRequired,
    platformFeeBps: settings.platformFeeBps,
    partnerMaxFeeBps,
    decimals: { base: b.decimals, quote: q.decimals },
    tokens: {
      base: { symbol: cfg.token.symbol, address: sol.baseMint.toBase58(), decimals: b.decimals },
      quote: { symbol: cfg.quoteAsset.symbol, address: sol.quoteMint.toBase58(), decimals: q.decimals },
    },
  };
}

// ---------------------------------------------------------------------------- home market

function homeDecimals(ctx: ApiContext): { base: number; quote: number } {
  const { cfg } = ctx;
  if (vmOf(cfg.homeChain) === "svm") {
    const home = solanaHome(cfg)!;
    return { base: home.assets.base.decimals, quote: home.assets.quote.decimals };
  }
  return { base: localDecimals(cfg, cfg.homeChain, "base"), quote: localDecimals(cfg, cfg.homeChain, "quote") };
}

/** What the home market pays out for `amountIn` of `inSide`, in home decimals. */
export async function homeSwap(ctx: ApiContext, inSide: "base" | "quote", amountIn: bigint): Promise<bigint> {
  const { cfg, manifest } = ctx;
  if (vmOf(cfg.homeChain) === "svm") {
    const home = solanaHome(cfg);
    if (!home?.pool) throw new ApiError(503, "no_market", "The home chain has no pool.");
    const sol = new SolanaChain(cfg.homeChain);
    const provider = new anchor.AnchorProvider(sol.connection, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" });
    const wctx = WhirlpoolContext.withProvider(provider, undefined, undefined, undefined, new PublicKey(WHIRLPOOL_PROGRAM_ID));
    const pool = await buildWhirlpoolClient(wctx).getPool(new PublicKey(home.pool.whirlpool), IGNORE_CACHE);
    const inputMint = new PublicKey(inSide === "base" ? home.assets.base.mint : home.assets.quote.mint);
    const q = await swapQuoteByInputToken(
      pool,
      inputMint,
      new anchor.BN(amountIn.toString()),
      Percentage.fromFraction(0, 1000),
      wctx.program.programId,
      wctx.fetcher,
      IGNORE_CACHE
    );
    return BigInt(q.estimatedAmountOut.toString());
  }

  const chain = ctx.evm.get(cfg.homeChain.key)!;
  const pool = manifest.pool?.address as Address | undefined;
  if (!pool) throw new ApiError(503, "no_market", "The home chain has no pool.");
  const c = manifest.chains[cfg.homeChain.key].contracts;
  const tokenIn = (inSide === "base" ? c.TokenizedStock : c.QuoteAsset).toLowerCase();
  const token0 = (await chain.read<Address>(pool, POOL_ABI, "token0")).toLowerCase();
  const quoter = forgeArtifact("PoolQuoter");
  const data = encodeFunctionData({ abi: quoter.abi, functionName: "quoteExactInput", args: [pool, tokenIn === token0, amountIn] });
  const { data: out } = await chain.publicClient.call({
    to: QUOTER_ADDRESS,
    data,
    stateOverride: [{ address: QUOTER_ADDRESS, code: quoter.deployedBytecode! }],
  });
  return decodeFunctionResult({ abi: quoter.abi, functionName: "quoteExactInput", data: out as Hex }) as bigint;
}

// ---------------------------------------------------------------------------- messaging fee

async function messagingFeeFor(
  ctx: ApiContext,
  chain: string,
  vm: "evm" | "svm",
  side: Side,
  traded: bigint,
  minAmountOut: bigint
): Promise<Quote["messagingFee"]> {
  if (vm === "evm") {
    const client = ctx.evm.get(chain)!;
    const request = ctx.manifest.chains[chain].contracts.SwapRequest as Address;
    const fee = await client.read<{ nativeFee: bigint }>(request, forgeArtifact("SwapRequest").abi, "quoteTrade", [
      side === "buy" ? 0 : 1,
      traded,
      minAmountOut,
    ]);
    return { amount: fee.nativeFee.toString(), symbol: client.config.nativeSymbol ?? "ETH", decimals: 18 };
  }
  const sol = ctx.solana.get(chain)!;
  const fee = await sol.quoteMessagingFee(
    sol.chain.payer.publicKey,
    side === "buy" ? SolanaDirection.Buy : SolanaDirection.Sell,
    traded,
    solanaOrderOptions(ctx.cfg)
  );
  return { amount: fee.toString(), symbol: "SOL", decimals: 9 };
}
