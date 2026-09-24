import Link from "next/link";
import { ChevronRight, Plus } from "lucide-react";
import { listDeployments } from "@/lib/deployments";
import { Badge, ButtonLink, Card, PageHeader, Stat, VmBadge } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deployments" };

export default function Deployments() {
  const all = listDeployments();
  const chains = new Set(all.flatMap((d) => [d.home, ...d.mirrors].map((c) => `${c.vm}:${c.eid}`)));
  const links = all.reduce((a, d) => a + d.peers.total, 0);
  const verified = all.reduce((a, d) => a + d.peers.verified, 0);
  const solanaHomes = all.filter((d) => d.home.vm === "svm").length;

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Issuer console"
        title="Deployments"
        description="Every deployment the pipeline has recorded: which chain is home, where the asset is mirrored, and whether every link was verified."
        actions={<ButtonLink href="/app/launch"><Plus size={16} aria-hidden /> Launch an asset</ButtonLink>}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Deployments" value={all.length} hint={`${solanaHomes} with a Solana home`} />
        <Stat label="Chains reached" value={chains.size} hint="distinct endpoints across all deployments" />
        <Stat label="Peer links" value={links} hint="LayerZero links written and read back" />
        <Stat
          label="Verified"
          value={links === 0 ? "—" : `${((verified / links) * 100).toFixed(1)}%`}
          hint={`${verified} of ${links} links match on chain`}
        />
      </div>

      <Card>
        <div className="hidden grid-cols-[1.6fr_1fr_1.4fr_0.8fr_24px] gap-4 border-b border-line px-5 py-3 text-xs font-medium uppercase tracking-wide text-muted md:grid">
          <div>Asset / deployment</div>
          <div>Home chain</div>
          <div>Mirrors</div>
          <div>Links</div>
          <div />
        </div>
        <ul className="divide-y divide-line">
          {all.map((d) => (
            <li key={d.name}>
              <Link
                href={`/app/deployments/${d.name}`}
                className="grid gap-3 px-5 py-4 hover:bg-surface-2 md:grid-cols-[1.6fr_1fr_1.4fr_0.8fr_24px] md:items-center md:gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.token.symbol}</span>
                    <span className="text-sm text-muted">/ {d.quoteAsset.symbol}</span>
                    {d.mode === "adapt" && <Badge tone="warn">Adapted</Badge>}
                    <Badge>{d.environment}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted">{d.name}</div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {d.home.name}
                  <VmBadge vm={d.home.vm} />
                </div>
                <div className="flex flex-wrap gap-1.5 text-sm text-muted">
                  {d.mirrors.map((m) => (
                    <span key={m.key} className="inline-flex items-center gap-1">
                      <span className={m.vm === "svm" ? "text-svm" : "text-evm"} aria-hidden>●</span>
                      {m.name}
                    </span>
                  ))}
                </div>
                <div className="text-sm">
                  {d.peers.verified === d.peers.total ? (
                    <Badge tone="ok">{d.peers.verified}/{d.peers.total} verified</Badge>
                  ) : (
                    <Badge tone="bad">{d.peers.verified}/{d.peers.total} verified</Badge>
                  )}
                </div>
                <ChevronRight size={16} className="hidden text-muted md:block" aria-hidden />
              </Link>
            </li>
          ))}
          {all.length === 0 && (
            <li className="px-5 py-10 text-center text-sm text-muted">
              No deployments recorded yet. Run <code className="font-mono">npm run deploy</code>, or launch one from the wizard.
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}
