/**
 * The CrossStock partner API's wire types. The API server and the SDK both compile against
 * these, so a field cannot change on one side only.
 *
 * Every token amount is a decimal string of integer base units, in the token's decimals ON THE
 * CHAIN NAMED — an asset can have different decimals on different chains (a Solana mint is
 * usually 9 where the EVM token is 18).
 */

export type Vm = "evm" | "svm";
export type Side = "buy" | "sell";

export interface TokenRef {
  symbol: string;
  /** EVM address or Solana mint. */
  address: string;
  decimals: number;
}

interface MirrorBase {
  key: string;
  name: string;
  eid: number;
  base: TokenRef;
  quote: TokenRef;
  /** Orders here must come through a partner. */
  partnerRequired: boolean;
  /** Platform fee on partner orders, in basis points of the input. */
  platformFeeBps: number;
}

export interface EvmMirror extends MirrorBase {
  vm: "evm";
  chainId: number;
  swapRequest: string;
  /** The EIP-712 domain a partner signs order authorisations under. */
  eip712: { name: string; version: string; chainId: number; verifyingContract: string };
}

export interface SolanaMirror extends MirrorBase {
  vm: "svm";
  /** The `swap_request` program. */
  program: string;
  store: string;
}

export type MirrorDescriptor = EvmMirror | SolanaMirror;

/** Everything a partner needs to know about a deployment to trade on it. */
export interface DeploymentDescriptor {
  name: string;
  environment: "local" | "live";
  asset: { name: string; symbol: string };
  quoteAsset: { name: string; symbol: string };
  /** Where the market is. Informational: orders are only ever placed on mirrors. */
  home: { key: string; name: string; vm: Vm; eid: number; venue: "Uniswap V3" | "Orca Whirlpool" };
  mirrors: MirrorDescriptor[];
}

export interface QuoteRequest {
  deployment: string;
  /** Mirror chain key, from the descriptor. */
  chain: string;
  side: Side;
  /** What the user pays, in the input token's base units on `chain`. */
  amountIn: string;
  /** Set for an order placed through a partner; fees apply to partner orders. */
  partnerId?: number;
  partnerFeeBps?: number;
  /** Tolerance below the expected output for `minAmountOut`. Default 50 (0.5%). */
  slippageBps?: number;
}

export interface Quote {
  deployment: string;
  chain: string;
  side: Side;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: string;
  fees: { partner: string; platform: string };
  /** What crosses to the home market: `amountIn` less fees, rounded to the bridge's precision. */
  traded: string;
  /** Returned to the user at submission: the part below the bridge's precision. */
  dust: string;
  /** What the home market would deliver for `traded` right now, as it arrives on `chain`. */
  expectedAmountOut: string;
  /** `expectedAmountOut` less `slippageBps`: pass this as the order's floor. */
  minAmountOut: string;
  slippageBps: number;
  /** Quote asset per unit of the stock: spot, and what this order executes at. */
  spotPrice: string;
  executionPrice: string;
  priceImpactBps: number;
  /** Paid by the user with the order, in `chain`'s native token. */
  messagingFee: { amount: string; symbol: string; decimals: number };
  venue: "Uniswap V3" | "Orca Whirlpool";
  quotedAt: string;
}

/** A partner's EIP-712 authorisation of one EVM order (see `authorizeEvmOrder`). */
export interface EvmAuthorization {
  nonce: string;
  deadline: string;
  signature: string;
}

export interface BuildOrderRequest {
  deployment: string;
  chain: string;
  side: Side;
  /** The account that submits and receives: EVM address or Solana public key. */
  user: string;
  amountIn: string;
  minAmountOut: string;
  partnerId?: number;
  partnerFeeBps?: number;
  /** EVM partner orders: the partner's signature over exactly this order. */
  authorization?: EvmAuthorization;
  /** Native value to attach, from the quote's `messagingFee`. Default: quoted afresh. */
  messagingFee?: string;
}

export interface EvmTransactionRequest {
  description: string;
  to: string;
  data: string;
  value: string;
}

export type BuiltOrder =
  | {
      vm: "evm";
      chainId: number;
      /** In order: an approval if the allowance is short, then the order itself. */
      transactions: EvmTransactionRequest[];
    }
  | {
      vm: "svm";
      /** The id this order will have: its request account is derived from it. */
      requestId: string;
      /** A v0 transaction, base64, unsigned. The partner co-signs (`authorizeSolanaOrder`), the user signs. */
      transaction: string;
      lookupTable: string;
      signers: { user: string; partner?: string };
    };

export type OrderStatus = "pending" | "filled" | "refunded" | "stranded" | "cancelled";

export interface Order {
  deployment: string;
  chain: string;
  id: string;
  user: string;
  side: Side;
  /** Token addresses (EVM) or mints (Solana) on `chain`. */
  tokenIn: string;
  tokenOut: string;
  /** Traded amount (after fees), in the input token's base units. */
  amountIn: string;
  minAmountOut: string;
  /** Delivered on a fill; zero otherwise. */
  amountOut: string;
  status: OrderStatus;
  failureReason: number;
  createdAt: number;
  settledAt: number;
  fees?: { partnerId: number; partner: string; platform: string; state: "escrowed" | "paid" | "returned" | "none" };
  /** For a stranded order: what the home chain still holds for it, in WHOLE units (a decimal), or "0" once recovered. */
  strandedHeld?: string;
  /** What happens next, in words a user can be shown. */
  next: string;
}

export type WebhookEventType = "order.filled" | "order.refunded" | "order.stranded" | "order.cancelled" | "order.recovered";

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  order: Order;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Proof of reserves for an asset, from `GET /api/v1/reserves/:deployment`. Amounts in whole units. */
export interface Reserves {
  deployment: string;
  asset: { symbol: string; name: string };
  /** Supply on every chain plus in transit, measured from chain state. */
  issued: string;
  inTransit: string;
  chains: { key: string; name: string; vm: "evm" | "svm"; role: "home" | "mirror"; supply: string }[];
  /** Supply on every chain plus in transit equals what was issued at launch. */
  reconciled: boolean;
  /** Absent when the asset has no reserve source configured. */
  reserves?: {
    shares: string;
    tokensPerShare: number;
    source: string;
    asOf?: string;
    backed: string;
    /** backed / issued in basis points: 10000 = 100%. */
    coverageBps: number;
    fullyBacked: boolean;
  };
  at: string;
}
