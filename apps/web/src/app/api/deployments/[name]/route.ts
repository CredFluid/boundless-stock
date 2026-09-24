import { getDeployment } from "@/lib/deployments";

export const dynamic = "force-dynamic";

/** One deployment's record: chains, contracts, peers, pipeline. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const d = getDeployment((await params).name);
  return d ? Response.json(d) : Response.json({ error: "No deployment by that name." }, { status: 404 });
}
