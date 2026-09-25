import type { NextRequest } from "next/server";
import { listDeployments } from "@/lib/deployments";
import { handle } from "@/lib/partner-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: NextRequest) {
  return handle(req, async () => ({
    deployments: listDeployments().map((d) => ({ name: d.name, asset: d.token.symbol, environment: d.environment })),
  }));
}
