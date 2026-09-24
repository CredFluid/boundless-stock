import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, CircleAlert } from "lucide-react";
import { getDeployment, type ChainView } from "@/lib/deployments";
import { Address, Badge, Card, CardHeader, PageHeader, Stat, VmBadge } from "@/components/ui";
import { DeploymentLive } from "@/components/live/deployment-live";
import { RequestHistory } from "@/components/live/requests";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  return { title: (await params).name };
}

function ChainNode({ chain }: { chain: ChainView }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{chain.name}</span>
        <VmBadge vm={chain.vm} />
      </div>
      <div className="mt-0.5 font-mono text-xs text-muted">eid {chain.eid}</div>
    </div>
  );
}

export default async function DeploymentPage({ params }: { params: Promise<{ name: string }> }) {
  const d = getDeployment((await params).name);
  if (!d) notFound();
  const chains = [d.home, ...d.mirrors];
  const byKind = Object.groupBy(d.peers.records, (p) => p.kind);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Link href="/app" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} aria-hidden /> Deployments
      </Link>

      <PageHeader
        eyebrow={d.name}
        title={`${d.token.name} (${d.token.symbol})`}
        description={
          <>
            Priced against {d.quoteAsset.symbol} on {d.home.name} by {d.venue}; mirrored to {d.mirrors.length} chain
            {d.mirrors.length === 1 ? "" : "s"}. {d.mode === "adapt" ? "An existing token, adapted rather than replaced." : "Launched as a new omnichain asset."}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Badge>{d.environment}</Badge>
            {d.mode === "adapt" ? <Badge tone="warn">Adapted</Badge> : <Badge tone="accent">Launched</Badge>}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Home chain" value={<span className="text-lg">{d.home.name}</span>} hint={<VmBadge vm={d.home.vm} />} />
        <Stat label="Mirrors" value={d.mirrors.length} hint={`${d.mirrors.filter((m) => m.vm === "svm").length} on Solana`} />
        <Stat label="Genesis supply" value={<span className="text-lg">{Number(d.token.initialSupply).toLocaleString()} {d.token.symbol}</span>} hint={`${d.token.decimals} decimals at home`} />
        <Stat
          label="Peer links"
          value={`${d.peers.verified}/${d.peers.total}`}
          hint={d.peers.verified === d.peers.total ? "all read back and match" : "some links do not match"}
        />
      </div>

      <DeploymentLive
        name={d.name}
        recorded={{
          base: d.token.symbol,
          quote: d.quoteAsset.symbol,
          venue: d.venue,
          initialPrice: d.pool?.initialPrice,
          feeTierPct: d.pool ? d.pool.feeTier / 10_000 : undefined,
          seeded: d.pool?.reserves,
          pool: d.pool?.address,
          genesis: Number(d.token.initialSupply).toLocaleString(),
        }}
      />

      <RequestHistory name={d.name} />

      {/* ---------------------------------------------------------------- topology */}
      <Card>
        <CardHeader title="Topology" subtitle="One home market; every mirror reaches it over LayerZero, and each other directly." />
        <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,260px)_1fr] md:items-center">
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-accent">Home · {d.venue}</div>
            <div className="rounded-xl border-2 border-accent p-1">
              <ChainNode chain={d.home} />
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Mirrors · no market needed</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {d.mirrors.map((m) => (
                <ChainNode key={m.key} chain={m} />
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- chains */}
      <Card>
        <CardHeader title="Chains and contracts" subtitle="Everything the pipeline deployed or initialised, per chain." />
        <div className="divide-y divide-line">
          {chains.map((c) => (
            <details key={c.key} className="group px-5 py-3" open={c.role === "home"}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {c.name}
                  <VmBadge vm={c.vm} />
                  {c.role === "home" && <Badge tone="accent">home</Badge>}
                </span>
                <span className="text-xs text-muted">{c.contracts.length} entries</span>
              </summary>
              <dl className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-[180px_1fr]">
                {c.contracts.map((k) => (
                  <div key={k.label} className="contents">
                    <dt className="text-sm text-muted">{k.label}</dt>
                    <dd className="min-w-0 truncate">
                      <Address value={k.address} className="text-fg" />
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </div>
      </Card>

      {/* ---------------------------------------------------------------- peers */}
      <Card>
        <CardHeader
          title="Peer links"
          subtitle="Each LayerZero link was written, then read back from chain. A link from a Solana chain is written by the Solana setup and not listed here."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2 font-medium">Link</th>
                <th className="px-5 py-2 font-medium">From</th>
                <th className="px-5 py-2 font-medium">To</th>
                <th className="px-5 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {Object.entries(byKind).flatMap(([, records]) =>
                (records ?? []).map((p, i) => (
                  <tr key={`${p.label}-${p.fromChain}-${p.toChain}-${i}`}>
                    <td className="px-5 py-2">{p.label}</td>
                    <td className="px-5 py-2 text-muted">{chains.find((c) => c.key === p.fromChain)?.name ?? p.fromChain}</td>
                    <td className="px-5 py-2 text-muted">{chains.find((c) => c.key === p.toChain)?.name ?? p.toChain}</td>
                    <td className="px-5 py-2">
                      {p.verified ? (
                        <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 size={14} aria-hidden /> verified</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-bad"><CircleAlert size={14} aria-hidden /> mismatch</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- pipeline */}
      <Card>
        <CardHeader title="Pipeline" subtitle="The modules that produced this deployment, in order." />
        <ol className="space-y-3 p-5">
          {d.steps.map((s, i) => (
            <li key={`${s.module}-${i}`} className="flex gap-3 text-sm">
              {s.status === "ok" ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden />
              ) : (
                <CircleAlert size={16} className="mt-0.5 shrink-0 text-bad" aria-hidden />
              )}
              <div className="min-w-0">
                <span className="font-mono text-xs">{s.module}</span>
                {s.detail && <span className="text-muted"> — {s.detail}</span>}
                <div className="text-xs text-muted">{new Date(s.at).toLocaleString()}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
