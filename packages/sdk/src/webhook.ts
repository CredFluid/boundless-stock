import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./types.js";

/** The header carrying a delivery's signature: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-crossstock-signature";

/** Signs a webhook body. The HMAC covers `${t}.${body}`, so a signature cannot be moved to another body or time. */
export function signWebhook(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verifies a webhook delivery and returns its event. Throws if the signature does not match
 * this exact body, or the delivery is older than `toleranceSec` (a replay).
 *
 * @param rawBody The request body exactly as received — before any JSON parsing.
 */
export function verifyWebhook(rawBody: string, signatureHeader: string | null | undefined, secret: string, toleranceSec = 300): WebhookEvent {
  if (!signatureHeader) throw new Error(`Missing ${WEBHOOK_SIGNATURE_HEADER} header.`);
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) throw new Error("Malformed signature header.");
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSec) throw new Error("Webhook timestamp outside the tolerance.");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("Webhook signature does not match.");
  return JSON.parse(rawBody) as WebhookEvent;
}
