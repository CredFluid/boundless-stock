import { decodeEventLog, parseAbi, type Account, type Address, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmAuthorization, EvmMirror, Side } from "./types.js";

export const PARTNER_ORDER_TYPES = {
  PartnerOrder: [
    { name: "user", type: "address" },
    { name: "direction", type: "uint8" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "partnerId", type: "uint32" },
    { name: "feeBps", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface EvmOrderToAuthorize {
  user: string;
  side: Side;
  amountIn: string;
  minAmountOut: string;
  partnerId: number;
  feeBps: number;
  /** Single use per partner. Default: random. */
  nonce?: string;
  /** Unix seconds. Default: ten minutes from now. */
  deadline?: string;
}

/**
 * The partner's approval of one order on an EVM mirror: an EIP-712 signature over exactly
 * this user, direction, amount, floor and fee. Run it on the partner's backend, after the
 * partner's own checks (KYC, limits) pass; pass the result to `buildOrder` as `authorization`.
 *
 * @param signer The partner's registered signer: a private key or a viem account (e.g. a KMS
 *               or hardware-backed one).
 */
export async function authorizeEvmOrder(
  signer: Hex | Account,
  mirror: Pick<EvmMirror, "eip712">,
  order: EvmOrderToAuthorize
): Promise<EvmAuthorization> {
  const account = typeof signer === "string" ? privateKeyToAccount(signer) : signer;
  if (!account.signTypedData) throw new Error("The signer account cannot sign typed data.");
  const nonce = order.nonce ?? randomNonce();
  const deadline = order.deadline ?? String(Math.floor(Date.now() / 1000) + 600);
  const signature = await account.signTypedData({
    domain: {
      name: mirror.eip712.name,
      version: mirror.eip712.version,
      chainId: mirror.eip712.chainId,
      verifyingContract: mirror.eip712.verifyingContract as Address,
    },
    types: PARTNER_ORDER_TYPES,
    primaryType: "PartnerOrder",
    message: {
      user: order.user as Address,
      direction: order.side === "buy" ? 0 : 1,
      amountIn: BigInt(order.amountIn),
      minAmountOut: BigInt(order.minAmountOut),
      partnerId: order.partnerId,
      feeBps: order.feeBps,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
    },
  });
  return { nonce, deadline, signature };
}

/** A random 128-bit nonce, as a decimal string. */
export function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return BigInt("0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("")).toString();
}

const SWAP_REQUESTED = parseAbi([
  "event SwapRequested(uint64 indexed requestId, address indexed user, uint8 direction, address tokenIn, uint256 amountIn, uint256 minAmountOut)",
]);

/** The order id an EVM order transaction created, read from its receipt's logs. */
export function orderIdFromLogs(logs: readonly Pick<Log, "address" | "topics" | "data">[], swapRequest: string): string {
  for (const log of logs) {
    if (log.address.toLowerCase() !== swapRequest.toLowerCase()) continue;
    try {
      const e = decodeEventLog({ abi: SWAP_REQUESTED, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return e.args.requestId.toString();
    } catch {
      /* another event */
    }
  }
  throw new Error("No SwapRequested event in these logs.");
}
