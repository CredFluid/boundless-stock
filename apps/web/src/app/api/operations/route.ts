import { listDeployments } from "@/lib/deployments";
import { getOperations } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Every live deployment's pending, stranded and cancelled requests, for the operations page. */
export async function GET() {
  return Response.json(await getOperations(listDeployments().map((d) => d.name)));
}
