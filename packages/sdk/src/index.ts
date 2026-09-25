/**
 * CrossStock partner SDK.
 *
 *   const api = new BoundlessStockApi({ baseUrl, apiKey });
 *   const q = await api.quote({ deployment, chain, side: "buy", amountIn, partnerId, partnerFeeBps });
 *   // EVM: the partner signs, the user sends the returned transactions
 *   const authorization = await authorizeEvmOrder(partnerKey, mirror, { user, side, amountIn, minAmountOut: q.minAmountOut, partnerId, feeBps });
 *   const built = await api.buildOrder({ ..., authorization });
 *   // Solana: the API returns a transaction; the partner checks and co-signs it, the user signs and sends
 *   const tx = authorizeSolanaOrder(built.transaction, partnerKeypair, { program, user, side, amountIn, feeBps });
 *
 * See PARTNERS.md for the whole flow.
 */
export * from "./types.js";
export { BoundlessStockApi, BoundlessStockApiError, type ApiClientOptions } from "./client.js";
export { authorizeEvmOrder, randomNonce, orderIdFromLogs, PARTNER_ORDER_TYPES, type EvmOrderToAuthorize } from "./evm.js";
export { authorizeSolanaOrder, decodePartnerOrder, type SolanaOrderToAuthorize, type DecodedPartnerOrder } from "./solana.js";
export { signWebhook, verifyWebhook, WEBHOOK_SIGNATURE_HEADER } from "./webhook.js";
