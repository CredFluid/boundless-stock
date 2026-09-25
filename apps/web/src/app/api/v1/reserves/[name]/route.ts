import type { NextRequest } from "next/server";
import { apiContext, reserves } from "@infra/api/index";
import { handle, requireLive } from "@/lib/partner-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proof of reserves: supply measured on every chain against the shares held for the asset. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return handle(req, async () => {
    requireLive(name);
    return reserves(apiContext(name));
  });
}
