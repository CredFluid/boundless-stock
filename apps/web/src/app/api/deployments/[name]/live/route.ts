import { getDeployment } from "@/lib/deployments";
import { getLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Live state from chain: supply across every chain with in-flight amounts, home market, relay. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!getDeployment(name)) return Response.json({ error: "No deployment by that name." }, { status: 404 });
  return Response.json(await getLive(name));
}
