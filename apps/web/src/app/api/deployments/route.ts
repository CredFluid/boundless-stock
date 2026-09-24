import { listDeployments } from "@/lib/deployments";

export const dynamic = "force-dynamic";

/** Every recorded deployment, as the dashboard lists them. */
export function GET() {
  return Response.json(listDeployments());
}
