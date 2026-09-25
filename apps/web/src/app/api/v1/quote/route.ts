import type { NextRequest } from "next/server";
import type { QuoteRequest } from "@crossstock/sdk";
import { apiContext, quote } from "@infra/api/index";
import { handle, jsonBody, requireLive } from "@/lib/partner-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(req: NextRequest) {
  return handle(req, async () => {
    const body = await jsonBody<QuoteRequest>(req);
    requireLive(body.deployment);
    return quote(apiContext(body.deployment), body);
  });
}
