import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { ApiError } from "@infra/api/index";
import { availabilityOf } from "./live";

/**
 * The partner API's front door: API keys, rate limits, and turning errors into the documented
 * `{ error: { code, message } }` shape. The endpoints themselves live in `infra/api` — the same
 * code the validation suite drives.
 *
 * Keys come from `CROSSSTOCK_API_KEYS`, as `name:key` pairs separated by commas; the name
 * identifies the partner in logs and limits. With no keys configured the API is open in
 * development and closed in production, so a forgotten variable fails safe.
 */

const RATE_PER_MINUTE = Number(process.env.CROSSSTOCK_API_RATE_PER_MINUTE ?? 60);

const digest = (s: string) => createHash("sha256").update(s).digest();

function configuredKeys(): { name: string; hash: Buffer }[] {
  return (process.env.CROSSSTOCK_API_KEYS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf(":");
      return { name: p.slice(0, i), hash: digest(p.slice(i + 1)) };
    });
}

/** The caller's identity, or an ApiError. Comparing hashes keeps it constant-time. */
function authenticate(req: NextRequest): string {
  const keys = configuredKeys();
  if (keys.length === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(503, "api_keys_not_configured", "The API has no keys configured, so it is closed.");
    }
    return "development";
  }
  const given = req.headers.get("x-api-key");
  if (!given) throw new ApiError(401, "missing_api_key", "Send your API key in the x-api-key header.");
  const h = digest(given);
  const match = keys.find((k) => timingSafeEqual(k.hash, h));
  if (!match) throw new ApiError(401, "invalid_api_key", "That API key is not recognised.");
  return match.name;
}

const windows = new Map<string, { start: number; count: number }>();

function rateLimit(caller: string): number {
  const now = Date.now();
  const w = windows.get(caller);
  if (!w || now - w.start >= 60_000) {
    windows.set(caller, { start: now, count: 1 });
    return RATE_PER_MINUTE - 1;
  }
  if (w.count >= RATE_PER_MINUTE) throw new ApiError(429, "rate_limited", `At most ${RATE_PER_MINUTE} requests a minute.`);
  w.count++;
  return RATE_PER_MINUTE - w.count;
}

/** A deployment must be the one its chains are running, or its figures would be someone else's. */
export function requireLive(name: string): void {
  const a = availabilityOf(name);
  if (a.state !== "live") throw new ApiError(a.state === "no-config" ? 404 : 503, a.state.replace("-", "_"), a.reason);
}

export async function handle<T>(req: NextRequest, fn: (caller: string) => Promise<T>): Promise<NextResponse> {
  try {
    const caller = authenticate(req);
    const remaining = rateLimit(caller);
    const body = await fn(caller);
    return NextResponse.json(body, { headers: { "x-ratelimit-remaining": String(remaining), "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    }
    console.error("partner api:", e);
    return NextResponse.json(
      { error: { code: "internal", message: e instanceof Error ? e.message.split("\n")[0] : "Unexpected error." } },
      { status: 500 }
    );
  }
}

export async function jsonBody<T>(req: NextRequest): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be JSON.");
  }
}
