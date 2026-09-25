import type { NextRequest } from "next/server";
import type { BuildOrderRequest } from "@boundless-stock/sdk";
import { ApiError, apiContext, buildOrder, listOrders } from "@infra/api/index";
import { handle, jsonBody, requireLive } from "@/lib/partner-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Build an order: EVM calldata, or an unsigned Solana transaction, for the user to sign. */
export function POST(req: NextRequest) {
  return handle(req, async () => {
    const body = await jsonBody<BuildOrderRequest>(req);
    requireLive(body.deployment);
    return buildOrder(apiContext(body.deployment), body);
  });
}

/** A user's orders: ?deployment=&user=[&chain=][&status=][&limit=] */
export function GET(req: NextRequest) {
  return handle(req, async () => {
    const q = req.nextUrl.searchParams;
    const deployment = q.get("deployment");
    const user = q.get("user");
    if (!deployment || !user) throw new ApiError(400, "missing_parameter", "deployment and user are required.");
    requireLive(deployment);
    const limit = Math.min(Math.max(Number(q.get("limit") ?? 100) || 100, 1), 1000);
    return listOrders(apiContext(deployment), {
      user,
      chain: q.get("chain") ?? undefined,
      status: q.get("status") ?? undefined,
      limit,
    });
  });
}
