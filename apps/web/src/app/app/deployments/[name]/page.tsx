import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, CircleAlert, Handshake } from "lucide-react";
import { backingPct, getDeployment, type ChainView } from "@/lib/deployments";
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
      <div className="mt-0.5 text-xs text-muted">{chain.role === "home" ? "issued and traded here" : "mirror · no market needed"}</div>
    </div>
  );
}

export default async function DeploymentPage({ params }: { params: Promise<{ name: string }> }) {
  const d = getDeployment((await params).name);
  if (!d) notFound();
  const chains = [d.home, ...d.mirrors];
  const byKind = Object.groupBy(d.peers.records, (p) => p.kind);
  const pct = backingPct(d);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Link href="/app" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} aria-hidden /> Assets
      </Link>

      <PageHeader
        eyebrow={`${d.token.symbol} · issuer console`}
        title={`${d.token.name} (${d.token.symbol})`}
        description={
          <>
            Issued on {d.home.name} and distributed to {d.mirrors.length} chain{d.mirrors.length === 1 ? "" : "s"}.{" "}
            {d.mode === "adapt" ? "An existing token, adapted rather than replaced: the issuer keeps the mint." : "Launched as a new asset."}{" "}
            {d.reserves && `Backed by ${Number(d.reserves.shares).toLocaleString()} shares (${d.reserves.source}).`}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {d.environment === "local" && <Badge>Local demo</Badge>}
            {d.mode === "adapt" ? <Badge tone="warn">Existing token</Badge> : <Badge tone="accent">Issued</Badge>}
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Issued" value={<span className="text-lg">{Number(d.token.initialSupply).toLocaleString()} {d.token.symbol}</span>} hint={`on ${d.home.name}, its home`} />
        <Stat
          label="Backing"
          value={pct === undefined ? "—" : <span className={pct >= 100 ? "text-ok" : "text-bad"}>{pct.toFixed(0)}%</span>}
          hint={d.reserves ? `${Number(d.reserves.shares).toLocaleString()} shares held` : "no reserve source configured"}
        />
        <Stat label="Distribution chains" value={d.mirrors.length} hint={d.mirrors.map((m) => m.name).join(" · ")} />
        <Stat
          label="Distribution partners"
          value={d.partners.length}
          hint={d.partnerRequired ? "partner-approved orders only" : "partner orders carry fees; direct orders open"}
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
          reserves: d.reserves,
        }}
      />

      {/* ---------------------------------------------------------------- distribution */}
      <Card>
        <CardHeader
          title="Distribution partners"
          subtitle={
            d.partnerRequired
              ? "Only orders approved by one of these partners reach the market. Each partner runs KYC on its own users."
              : "Registered partners route orders for their verified users and earn a fee on every fill. Switch on the partner gate to accept partner orders only."
          }
          action={<Badge tone={d.partnerRequired ? "accent" : "neutral"}>{d.partnerRequired ? "Partner-gated" : "Gate off"}</Badge>}
        />
        {d.partners.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">No partners registered yet. Add them to the config&apos;s partners section.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 font-medium">Partner</th>
                  <th className="px-5 py-2 font-medium">Chains</th>
                  <th className="px-5 py-2 text-right font-medium">Fee ceiling</th>
                  <th className="px-5 py-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.partners.map((p) => (
                  <tr key={p.id}>
                    <td className="px-5 py-2.5">
                      <span className="inline-flex items-center gap-2 font-medium"><Handshake size={14} className="text-accent" aria-hidden />{p.name}</span>
                      <span className="ml-2 font-mono text-xs text-muted">#{p.id}</span>
                    </td>
                    <td className="px-5 py-2.5 text-muted">{p.chains.join(" · ") || "—"}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{(p.maxFeeBps / 100).toFixed(2)}%</td>
                    <td className="px-5 py-2.5 text-right">{p.active ? <Badge tone="ok">Active</Badge> : <Badge>Paused</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-5 py-3 text-xs text-muted">Fees are held in escrow and paid only when an order fills; a refunded or cancelled order returns them in full.</p>
      </Card>

      <RequestHistory name={d.name} partners={Object.fromEntries(d.partners.map((p) => [p.id, p.name]))} />

      {/* ---------------------------------------------------------------- topology */}
      <Card>
        <CardHeader title="Distribution network" subtitle="One market on the home chain; every distribution chain holds a mirror of the same asset and reaches the market over LayerZero." />
        <div className="grid gap-6 p-5 md:grid-cols-[minmax(0,260px)_1fr] md:items-center">
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-accent">Home · {d.venue}</div>
            <div className="rounded-xl border-2 border-accent p-1">
              <ChainNode chain={d.home} />
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Distribution chains</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {d.mirrors.map((m) => (
                <ChainNode key={m.key} chain={m} />
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* ---------------------------------------------------------------- technical */}
      <details className="group space-y-4">
        <summary className="cursor-pointer list-none text-sm text-muted hover:text-fg">
          <span className="group-open:hidden">▸</span><span className="hidden group-open:inline">▾</span> Technical details: contracts, cross-chain connections ({d.peers.verified}/{d.peers.total} verified) and the deployment log
        </summary>
      <Card>
        <CardHeader title="Contracts and programs" subtitle="Everything deployed or initialised for this asset, per chain." />
        <div className="divide-y divide-line">
          {chains.map((c) => (
            <details key={c.key} className="group px-5 py-3">
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
          title="Cross-chain connections"
          subtitle="Each connection was written, then read back from chain and checked."
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
        <CardHeader title="Deployment log" subtitle="The steps that produced this deployment, in order." />
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
      </details>
    </div>
  );
}
