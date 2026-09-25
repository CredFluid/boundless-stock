import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { backingPct, listDeployments, type DeploymentView } from "@/lib/deployments";
import { availabilityOf } from "@/lib/live";
import { Badge, ButtonLink, Card, PageHeader, Stat, VmBadge } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Assets" };

function AssetRow({ d }: { d: DeploymentView }) {
  const pct = backingPct(d);
  return (
    <li>
      <Link
        href={`/app/deployments/${d.name}`}
        className="grid gap-3 px-5 py-4 hover:bg-surface-2 md:grid-cols-[1.5fr_1fr_0.9fr_1.5fr_0.9fr_24px] md:items-center md:gap-4"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{d.token.symbol}</span>
            <span className="truncate text-sm text-muted">{d.token.name}</span>
            {d.mode === "adapt" && <Badge tone="warn">Existing token</Badge>}
          </div>
        </div>
        <div className="text-sm tabular-nums">
          {Number(d.token.initialSupply).toLocaleString()} <span className="text-muted">issued</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {d.home.name}
          <VmBadge vm={d.home.vm} />
        </div>
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-sm text-muted">
          {d.mirrors.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1">
              <span className={m.vm === "svm" ? "text-svm" : "text-evm"} aria-hidden>●</span>
              {m.name}
            </span>
          ))}
        </div>
        <div className="text-sm">
          {pct === undefined ? (
            <Badge>No reserve source</Badge>
          ) : pct >= 100 ? (
            <Badge tone="ok">{pct.toFixed(0)}% backed</Badge>
          ) : (
            <Badge tone="bad">{pct.toFixed(1)}% backed</Badge>
          )}
        </div>
        <ChevronRight size={16} className="hidden text-muted md:block" aria-hidden />
      </Link>
    </li>
  );
}

export default function Assets() {
  const all = listDeployments();
  // The assets this console runs: live, with Solana as home. Earlier test deployments are kept
  // out of the way below.
  const live = all.filter((d) => d.home.vm === "svm" && availabilityOf(d.name).state === "live");
  const archived = all.filter((d) => !live.includes(d));
  const chains = new Set(live.flatMap((d) => d.mirrors.map((c) => `${c.vm}:${c.eid}`)));
  const links = live.reduce((a, d) => a + d.peers.total, 0);
  const verified = live.reduce((a, d) => a + d.peers.verified, 0);
  const partners = new Set(live.flatMap((d) => d.partners.map((p) => p.name)));
  const backed = live.filter((d) => (backingPct(d) ?? 0) >= 100).length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Issuer console"
        title="Assets"
        description="Every tokenized asset you issue: where it is distributed, whether it is fully backed, and whether every connection is verified."
        actions={<ButtonLink href="/app/launch"><Plus size={16} aria-hidden /> Launch an asset</ButtonLink>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Assets live" value={live.length} hint="issued on Solana" />
        <Stat label="Fully backed" value={`${backed} of ${live.length}`} hint="issued supply against the shares held" />
        <Stat label="Distribution chains" value={chains.size} hint={`${partners.size} distribution partner${partners.size === 1 ? "" : "s"}`} />
        <Stat
          label="Connections verified"
          value={links === 0 ? "—" : `${verified}/${links}`}
          hint="every cross-chain link read back from chain"
        />
      </div>

      <Card>
        <div className="hidden grid-cols-[1.5fr_1fr_0.9fr_1.5fr_0.9fr_24px] gap-4 border-b border-line px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted md:grid">
          <div>Asset</div>
          <div>Supply</div>
          <div>Home</div>
          <div>Distributed to</div>
          <div>Backing</div>
          <div />
        </div>
        <ul className="divide-y divide-line">
          {live.map((d) => (
            <AssetRow key={d.name} d={d} />
          ))}
          {live.length === 0 && (
            <li className="px-5 py-10 text-center text-sm text-muted">
              No live assets yet. Run <code className="font-mono">boundless-stock deploy</code>, or launch one from the wizard.
            </li>
          )}
        </ul>
      </Card>

      {archived.length > 0 && (
        <details className="group text-sm">
          <summary className="cursor-pointer list-none text-muted hover:text-fg">
            Earlier test deployments ({archived.length}) <span className="group-open:hidden">▸</span><span className="hidden group-open:inline">▾</span>
          </summary>
          <Card className="mt-3">
            <ul className="divide-y divide-line">
              {archived.map((d) => (
                <li key={d.name} className="flex items-center justify-between gap-3 px-5 py-2.5">
                  <span className="font-mono text-xs text-muted">{d.name}</span>
                  <span className="text-xs text-muted">home: {d.home.name} · {d.mirrors.length} chains · not running</span>
                </li>
              ))}
            </ul>
          </Card>
        </details>
      )}
    </div>
  );
}
