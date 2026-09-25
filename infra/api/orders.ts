/**
 * Orders: building them for the user (and partner) to sign, and following them to the end.
 *
 * The API never holds a user's key or a partner's key. It hands back EVM calldata or an
 * unsigned Solana transaction; the partner authorises (an EIP-712 signature on EVM, which goes
 * INTO the calldata, or a co-signature on Solana), the user signs and sends.
 */
import { getAddress, isAddress, parseAbi, parseUnits, recoverAddress, type Address, type Hex, encodeFunctionData } from "viem";
import { PublicKey } from "@solana/web3.js";
import type { BuildOrderRequest, BuiltOrder, Order, OrderStatus, Side } from "@crossstock/sdk";

import { forgeArtifact } from "../lib/artifacts.js";
import { PARTNER_ABI } from "../lib/partners.js";
import { SolanaDirection, SolanaFeeState, SolanaStatus } from "../solana/client.js";
import { strandedHeld, syncHistory, type HistoryRecord } from "../history.js";
import { ApiError, isMirror, parseAmount, parseBps, type ApiContext } from "./context.js";
import { mirrorTerms } from "./quote.js";
import { solanaOrderOptions } from "./options.js";

const ERC20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const STATUS: Record<number, OrderStatus> = { 1: "pending", 2: "filled", 3: "refunded", 4: "stranded", 5: "cancelled" };
const FEE_STATE = ["none", "escrowed", "paid", "returned"] as const;
const FAILURE = ["", "slippage", "pool error", "unauthorised source"];

// ---------------------------------------------------------------------------- build

export async function buildOrder(ctx: ApiContext, req: BuildOrderRequest): Promise<BuiltOrder> {
  if (req.side !== "buy" && req.side !== "sell") throw new ApiError(400, "invalid_side", `side must be "buy" or "sell".`);
  const { vm } = isMirror(ctx, req.chain);
  const amountIn = parseAmount(req.amountIn, "amountIn");
  const minAmountOut = parseAmount(req.minAmountOut, "minAmountOut");
  const viaPartner = req.partnerId !== undefined;
  const feeBps = viaPartner ? parseBps(req.partnerFeeBps, "partnerFeeBps", 300, 0) : 0;
  const terms = await mirrorTerms(ctx, req.chain, vm, req.partnerId);
  if (terms.partnerRequired && !viaPartner) {
    throw new ApiError(400, "partner_required", `${terms.name} accepts orders only through a partner; pass partnerId.`);
  }
  if (viaPartner && terms.partnerMaxFeeBps !== undefined && feeBps > terms.partnerMaxFeeBps) {
    throw new ApiError(400, "fee_too_high", `Partner ${req.partnerId} may charge at most ${terms.partnerMaxFeeBps} bps.`);
  }
  return vm === "evm" ? buildEvm(ctx, req, amountIn, minAmountOut, feeBps) : buildSolana(ctx, req, amountIn, minAmountOut, feeBps);
}

async function buildEvm(
  ctx: ApiContext,
  req: BuildOrderRequest,
  amountIn: bigint,
  minAmountOut: bigint,
  feeBps: number
): Promise<BuiltOrder> {
  if (!isAddress(req.user)) throw new ApiError(400, "invalid_user", "user must be an EVM address on this chain.");
  const user = getAddress(req.user);
  const c = ctx.manifest.chains[req.chain];
  const chain = ctx.evm.get(req.chain)!;
  const request = c.contracts.SwapRequest as Address;
  const abi = forgeArtifact("SwapRequest").abi;
  const direction = req.side === "buy" ? 0 : 1;
  const tokenIn = (req.side === "buy" ? c.contracts.QuoteAsset : c.contracts.TokenizedStock) as Address;

  let data: Hex;
  if (req.partnerId !== undefined) {
    const auth = req.authorization;
    if (!auth) throw new ApiError(400, "authorization_required", "A partner order needs the partner's authorization (see authorizeEvmOrder).");
    if (!/^[0-9]+$/.test(auth.nonce) || !/^[0-9]+$/.test(auth.deadline) || !/^0x[0-9a-fA-F]+$/.test(auth.signature)) {
      throw new ApiError(400, "invalid_authorization", "authorization needs a numeric nonce and deadline and a hex signature.");
    }
    const nonce = BigInt(auth.nonce);
    const deadline = BigInt(auth.deadline);
    if (deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new ApiError(400, "authorization_expired", "The authorization's deadline has passed.");
    if (await chain.read<boolean>(request, abi, "nonceUsed", [req.partnerId, nonce])) {
      throw new ApiError(400, "nonce_used", `Nonce ${nonce} was already used by partner ${req.partnerId}.`);
    }
    // Check it now rather than let the user pay gas for a revert. A contract signer (ERC-1271)
    // can only be checked on chain, so it is left to the contract.
    const [signer] = await chain.read<readonly [Address]>(request, PARTNER_ABI, "partners", [req.partnerId]);
    const code = await chain.publicClient.getCode({ address: signer });
    if (!code || code === "0x") {
      const digest = await chain.read<Hex>(request, PARTNER_ABI, "hashPartnerOrder", [
        user, direction, amountIn, minAmountOut, req.partnerId, feeBps, nonce, deadline,
      ]);
      const recovered = await recoverAddress({ hash: digest, signature: auth.signature as Hex }).catch(() => undefined);
      if (recovered?.toLowerCase() !== signer.toLowerCase()) {
        throw new ApiError(400, "invalid_authorization", `The authorization is not partner ${req.partnerId}'s signature over this exact order.`);
      }
    }
    data = encodeFunctionData({
      abi,
      functionName: req.side === "buy" ? "buyVia" : "sellVia",
      args: [amountIn, minAmountOut, { partnerId: req.partnerId, feeBps, nonce, deadline, signature: auth.signature as Hex }],
    });
  } else {
    data = encodeFunctionData({ abi, functionName: req.side, args: [amountIn, minAmountOut] });
  }

  // Exactly the quoted fee: LayerZero's sender reverts on any other amount.
  const value =
    req.messagingFee !== undefined
      ? BigInt(req.messagingFee)
      : (await chain.read<{ nativeFee: bigint }>(request, abi, "quoteTrade", [direction, amountIn, minAmountOut])).nativeFee;

  const transactions = [];
  const allowance = await chain.read<bigint>(tokenIn, ERC20, "allowance", [user, request]);
  if (allowance < amountIn) {
    transactions.push({
      description: `Approve ${c.name}'s SwapRequest to take the ${req.side === "buy" ? ctx.cfg.quoteAsset.symbol : ctx.cfg.token.symbol}`,
      to: tokenIn,
      data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [request, amountIn] }),
      value: "0",
    });
  }
  transactions.push({
    description: `${req.side === "buy" ? "Buy" : "Sell"} ${ctx.cfg.token.symbol} on ${c.name}`,
    to: request,
    data,
    value: value.toString(),
  });
  return { vm: "evm", chainId: c.chainId!, transactions };
}

async function buildSolana(
  ctx: ApiContext,
  req: BuildOrderRequest,
  amountIn: bigint,
  minAmountOut: bigint,
  feeBps: number
): Promise<BuiltOrder> {
  let user: PublicKey;
  try {
    user = new PublicKey(req.user);
  } catch {
    throw new ApiError(400, "invalid_user", "user must be a Solana public key.");
  }
  const sol = ctx.solana.get(req.chain)!;
  const direction = req.side === "buy" ? SolanaDirection.Buy : SolanaDirection.Sell;
  const options = solanaOrderOptions(ctx.cfg);
  if (req.partnerId !== undefined) {
    const partner = (await sol.getPartner(req.partnerId))!;
    const built = await sol.buildPartnerOrder(user, partner.signer, req.partnerId, feeBps, direction, amountIn, minAmountOut, options);
    return {
      vm: "svm",
      requestId: built.requestId.toString(),
      transaction: Buffer.from(built.tx.serialize()).toString("base64"),
      lookupTable: built.lookupTable.toBase58(),
      signers: { user: user.toBase58(), partner: partner.signer.toBase58() },
    };
  }
  const built = await sol.buildOpenOrder(user, direction, amountIn, minAmountOut, options);
  return {
    vm: "svm",
    requestId: built.requestId.toString(),
    transaction: Buffer.from(built.tx.serialize()).toString("base64"),
    lookupTable: built.lookupTable.toBase58(),
    signers: { user: user.toBase58() },
  };
}

// ---------------------------------------------------------------------------- track

export async function getOrder(ctx: ApiContext, chain: string, idText: string): Promise<Order> {
  const { vm } = isMirror(ctx, chain);
  if (!/^[0-9]+$/.test(idText)) throw new ApiError(400, "invalid_id", "id must be a request id.");
  const id = BigInt(idText);
  const where = vm === "evm" ? ctx.manifest.chains[chain].name : ctx.solana.get(chain)!.chain.config.name;

  let order: Omit<Order, "next">;
  if (vm === "evm") {
    const c = ctx.manifest.chains[chain];
    const client = ctx.evm.get(chain)!;
    const request = c.contracts.SwapRequest as Address;
    const next = await client.read<bigint>(request, forgeArtifact("SwapRequest").abi, "nextRequestId");
    if (id === 0n || id >= next) throw new ApiError(404, "unknown_order", `No order ${id} on ${where}.`);
    const r = await client.read<{
      user: Address; direction: number; tokenIn: Address; tokenOut: Address; amountIn: bigint; minAmountOut: bigint;
      amountOut: bigint; createdAt: bigint; settledAt: bigint; status: number; failureReason: number;
    }>(request, forgeArtifact("SwapRequest").abi, "getRequest", [id]);
    const f = await client.read<{ partnerId: number; state: number; partnerFee: bigint; platformFee: bigint }>(
      request, PARTNER_ABI, "getFees", [id]
    );
    order = {
      deployment: ctx.cfg.name, chain, id: id.toString(), user: r.user,
      side: r.direction === 0 ? "buy" : "sell", tokenIn: r.tokenIn, tokenOut: r.tokenOut,
      amountIn: r.amountIn.toString(), minAmountOut: r.minAmountOut.toString(), amountOut: r.amountOut.toString(),
      status: STATUS[r.status] ?? "pending", failureReason: r.failureReason,
      createdAt: Number(r.createdAt), settledAt: Number(r.settledAt),
      fees: f.state === 0 ? undefined : {
        partnerId: f.partnerId, partner: f.partnerFee.toString(), platform: f.platformFee.toString(), state: FEE_STATE[f.state],
      },
    };
  } else {
    const sol = ctx.solana.get(chain)!;
    const r = await sol.getRequest(id);
    if (!r) throw new ApiError(404, "unknown_order", `No order ${id} on ${where}.`);
    const e = await sol.getFeeEscrow(id);
    const buy = r.direction === SolanaDirection.Buy;
    order = {
      deployment: ctx.cfg.name, chain, id: id.toString(), user: r.user.toBase58(), side: buy ? "buy" : "sell",
      tokenIn: (buy ? sol.quoteMint : sol.baseMint).toBase58(), tokenOut: (buy ? sol.baseMint : sol.quoteMint).toBase58(),
      amountIn: r.amountIn.toString(), minAmountOut: r.minAmountOut.toString(), amountOut: r.amountOut.toString(),
      status: STATUS[r.status as SolanaStatus] ?? "pending", failureReason: r.failureReason,
      createdAt: Number(r.createdAt), settledAt: Number(r.settledAt),
      fees: !e || e.state === SolanaFeeState.None ? undefined : {
        partnerId: e.partnerId, partner: e.partnerFee.toString(), platform: e.platformFee.toString(), state: FEE_STATE[e.state],
      },
    };
  }
  if (order.status === "stranded") order.strandedHeld = await strandedHeld(ctx.cfg, ctx.manifest, ctx.evm, { chainKey: chain, id: order.id });
  return { ...order, next: nextStep(order, where, vm) };
}

function nextStep(o: Omit<Order, "next">, where: string, vm: "evm" | "svm"): string {
  const unsettledFees = vm === "svm" && o.fees?.state === "escrowed" && o.status !== "pending";
  const fees = unsettledFees ? " Its fees are released by settle_fees, which anyone can run." : "";
  switch (o.status) {
    case "pending":
      return "On its way to the home market; it settles by itself, usually within seconds to minutes.";
    case "filled":
      return `Filled and delivered to the user's wallet on ${where}.${fees}`;
    case "refunded":
      return `The market could not fill it (${FAILURE[o.failureReason] || "failed"}); the input came back in full on ${where}${o.fees ? ", fees included" : ""}.${fees}`;
    case "stranded":
      return o.strandedHeld && o.strandedHeld !== "0"
        ? `The result is safe on the home chain but could not be sent back yet. Anyone can retry the return; it goes to the user.${fees}`
        : `Recovered: the result was returned to the user.${fees}`;
    case "cancelled":
      return `The order never reached the home chain; it was cancelled there and the input restored on ${where}.${fees}`;
  }
}

// ---------------------------------------------------------------------------- history

/** A user's orders across every mirror of the deployment, newest first. */
export async function listOrders(
  ctx: ApiContext,
  opts: { user: string; chain?: string; status?: string; limit?: number }
): Promise<{ orders: Omit<Order, "next" | "fees">[]; unreachable: string[] }> {
  const history = await syncHistory(ctx.cfg, ctx.manifest, ctx.evm);
  const same = (a: string, b: string) => (a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);
  const terms = new Map<string, Awaited<ReturnType<typeof mirrorTerms>>>();
  const out: Omit<Order, "next" | "fees">[] = [];
  for (const r of history.records) {
    if (!same(r.user, opts.user)) continue;
    if (opts.chain && r.chainKey !== opts.chain) continue;
    if (opts.status && r.status !== opts.status) continue;
    if (!terms.has(r.chainKey)) terms.set(r.chainKey, await mirrorTerms(ctx, r.chainKey, r.vm));
    out.push(toOrder(ctx, r, terms.get(r.chainKey)!));
    if (out.length >= (opts.limit ?? 100)) break;
  }
  return { orders: out, unreachable: history.unreachable };
}

function toOrder(
  ctx: ApiContext,
  r: HistoryRecord,
  t: Awaited<ReturnType<typeof mirrorTerms>>
): Omit<Order, "next" | "fees"> {
  const buy = r.direction === "buy";
  const [tIn, tOut] = buy ? [t.tokens.quote, t.tokens.base] : [t.tokens.base, t.tokens.quote];
  const [inDec, outDec] = [tIn.decimals, tOut.decimals];
  return {
    deployment: ctx.cfg.name, chain: r.chainKey, id: r.id, user: r.user, side: r.direction as Side,
    tokenIn: tIn.address, tokenOut: tOut.address,
    amountIn: parseUnits(r.amountIn, inDec).toString(), minAmountOut: parseUnits(r.minAmountOut, outDec).toString(),
    amountOut: parseUnits(r.amountOut, outDec).toString(), status: r.status, failureReason: r.failureReason,
    createdAt: r.createdAt, settledAt: r.settledAt, strandedHeld: r.strandedHeld,
  };
}
