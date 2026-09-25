import type { NextRequest } from "next/server";
import { apiContext, getOrder } from "@infra/api/index";
import { handle, requireLive } from "@/lib/partner-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ deployment: string; chain: string; id: string }> }) {
  const { deployment, chain, id } = await params;
  return handle(req, async () => {
    requireLive(deployment);
    return getOrder(apiContext(deployment), chain, id);
  });
}
