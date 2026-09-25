import type { NextRequest } from "next/server";
import { apiContext, describe } from "@infra/api/index";
import { handle, requireLive } from "@/lib/partner-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return handle(req, async () => {
    requireLive(name);
    return describe(apiContext(name));
  });
}
