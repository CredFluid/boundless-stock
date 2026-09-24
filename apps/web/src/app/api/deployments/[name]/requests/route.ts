import { getDeployment } from "@/lib/deployments";
import { getRequests } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES = new Set(["pending", "filled", "refunded", "stranded", "cancelled"]);

/**
 * Trade history across the deployment's mirror chains, newest first.
 * Query: `status` (one of pending, filled, refunded, stranded, cancelled), `limit` (default 100).
 */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!getDeployment(name)) return Response.json({ error: "No deployment by that name." }, { status: 404 });
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status && !STATUSES.has(status)) {
    return Response.json({ error: `status must be one of ${[...STATUSES].join(", ")}` }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 1000);
  const view = await getRequests(name);
  const records = view.history.records.filter((r) => !status || r.status === status);
  return Response.json({ ...view, history: { ...view.history, records: records.slice(0, limit), total: records.length } });
}
