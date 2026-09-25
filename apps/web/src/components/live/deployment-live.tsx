"use client";
import { CheckCircle2, CircleAlert } from "lucide-react";
import type { JsonSupply, LiveSnapshot } from "@/lib/live";
import { Address, Badge, Card, CardHeader, Stat, VmBadge, cx } from "@/components/ui";
import { amount, price } from "./format";
import { usePoll } from "./poll";
import { LiveIndicator, Unavailable } from "./status";

/** What the pipeline recorded, shown when there is no live reading. */
export interface Recorded {
  base: string;
  quote: string;
  venue: string;
  initialPrice?: string;
  feeTierPct?: number;
  seeded?: { base: string; quote: string };
  pool?: string;
  genesis: string;
  reserves?: { shares: string; tokensPerShare: number; source: string; asOf?: string };
}

export function DeploymentLive({ name, recorded }: { name: string; recorded: Recorded }) {
  const { data, at, error } = usePoll<LiveSnapshot>(`/api/deployments/${name}/live`);
  const live = data?.availability.state === "live" && !error ? data : undefined;
  const indicator = <LiveIndicator at={at} availability={data?.availability} error={error} />;
  const m = live?.market;
  const drift = m && recorded.initialPrice ? (m.price / Number(recorded.initialPrice) - 1) * 100 : undefined;
  const conserved = live?.supply && live.supply.base.conserved && live.supply.quote.conserved;
  const issuedNow = live?.supply ? Number(live.supply.base.total) + Number(live.supply.base.inFlight) : Number(recorded.genesis.replace(/,/g, ""));
  const backedTokens = recorded.reserves ? Number(recorded.reserves.shares) * recorded.reserves.tokensPerShare : undefined;
  const coverage = backedTokens !== undefined && issuedNow > 0 ? (backedTokens / issuedNow) * 100 : undefined;

  return (
    <section className="space-y-4" aria-label="Live state">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Live, read from every chain</h2>
        {indicator}
      </div>
      <Unavailable availability={data?.availability} error={error} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={`${recorded.base} price`}
          value={live ? `${price(m?.price)}` : recorded.initialPrice ?? "—"}
          hint={
            live ? (
              <span>
                {recorded.quote} on the {recorded.venue}
                {drift !== undefined && (
                  <span className={cx("ml-1", drift >= 0 ? "text-ok" : "text-bad")}>
                    {drift >= 0 ? "+" : ""}
                    {drift.toFixed(2)}% vs. launch
                  </span>
                )}
              </span>
            ) : (
              `${recorded.quote}, launch price`
            )
          }
        />
        <Stat
          label="Total supply"
          value={<span className="text-lg">{live?.supply ? amount(conserved ? live.supply.base.expected : live.supply.base.total, 2) : recorded.genesis} {recorded.base}</span>}
          hint={
            live?.supply ? (
              conserved ? (
                <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 size={14} aria-hidden /> reconciled on every chain</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-bad"><CircleAlert size={14} aria-hidden /> does not add up</span>
              )
            ) : (
              "issued, as recorded"
            )
          }
        />
        <Stat
          label="Market depth"
          value={<span className="text-lg">{amount(live ? m?.reserves.quote : recorded.seeded?.quote, 0)} {recorded.quote}</span>}
          hint={`and ${amount(live ? m?.reserves.base : recorded.seeded?.base, 2)} ${recorded.base}${live ? "" : " seeded"}`}
        />
        <Stat
          label="Proof of reserves"
          value={
            coverage === undefined ? (
              "—"
            ) : (
              <span className={cx("text-lg", coverage >= 100 ? "text-ok" : "text-bad")}>{coverage >= 100 ? "Fully backed" : `${coverage.toFixed(1)}% backed`}</span>
            )
          }
          hint={recorded.reserves ? `${recorded.reserves.source}${recorded.reserves.asOf ? `, ${recorded.reserves.asOf}` : ""}` : "no reserve source configured"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px] [&>*]:min-w-0">
        <div className="space-y-4">
          <SupplyCard supply={live?.supply} />
          <ReservesCard reserves={recorded.reserves} issued={live?.supply ? issuedNow : undefined} symbol={recorded.base} />
        </div>
        <Card className="self-start">
          <CardHeader title="Reference market" subtitle={`The ${recorded.venue}: orders placed through Boundless Stock fill here`} />
          <dl className="grid grid-cols-2 gap-y-3 p-5 text-sm">
            <dt className="text-muted">Price now</dt>
            <dd className="text-right tabular-nums">{live ? `${price(m?.price)} ${recorded.quote}` : "—"}</dd>
            <dt className="text-muted">Launch price</dt>
            <dd className="text-right tabular-nums">{recorded.initialPrice ?? "—"} {recorded.quote}</dd>
            <dt className="text-muted">Trading fee</dt>
            <dd className="text-right tabular-nums">{recorded.feeTierPct !== undefined ? `${recorded.feeTierPct}%` : "—"}</dd>
            <dt className="text-muted">{recorded.base} in pool</dt>
            <dd className="text-right tabular-nums">{amount(live ? m?.reserves.base : recorded.seeded?.base, 2)}</dd>
            <dt className="text-muted">{recorded.quote} in pool</dt>
            <dd className="text-right tabular-nums">{amount(live ? m?.reserves.quote : recorded.seeded?.quote, 2)}</dd>
            {recorded.pool && (
              <>
                <dt className="text-muted">Market account</dt>
                <dd className="text-right"><Address value={recorded.pool} /></dd>
              </>
            )}
          </dl>
        </Card>
      </div>
    </section>
  );
}

function SupplyCard({ supply }: { supply?: { base: JsonSupply; quote: JsonSupply } }) {
  const b = supply?.base;
  const total = b ? Number(b.total) : 0;
  return (
    <Card>
      <CardHeader
        title="Where the supply sits"
        subtitle="Read from every chain now, transfers in transit included. Together they must equal what was issued."
      />
      {!b ? (
        <p className="px-5 py-8 text-center text-sm text-muted">Shown while the asset&apos;s chains are reachable.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2 font-medium">Chain</th>
                <th className="px-5 py-2 text-right font-medium">{b.symbol}</th>
                <th className="px-5 py-2 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[...b.rows].sort((x, y) => (x.role === "home" ? -1 : y.role === "home" ? 1 : 0)).map((r) => {
                const share = total > 0 ? (Number(r.supply) / total) * 100 : 0;
                return (
                  <tr key={r.key}>
                    <td className="px-5 py-2">
                      <span className="flex flex-wrap items-center gap-2">
                        {r.name}
                        <VmBadge vm={r.vm as "evm" | "svm"} />
                        {r.role === "home" && <Badge tone="accent">home</Badge>}
                      </span>
                      {r.pool !== undefined && <span className="text-xs text-muted">of which in the market: {amount(r.pool, 2)}</span>}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">{amount(r.supply)}</td>
                    <td className="px-5 py-2 text-right text-muted tabular-nums">
                      {Number(r.supply) > 0 && share < 0.01 ? "<0.01%" : `${share.toFixed(2)}%`}
                      <div className="ml-auto mt-1 h-1 w-24 rounded-full bg-surface-2">
                        <div className="h-1 rounded-full bg-accent" style={{ width: `${Math.max(Number(r.supply) > 0 ? 2 : 0, share)}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr className="text-muted">
                <td className="px-5 py-2">In transit between chains</td>
                <td className="px-5 py-2 text-right tabular-nums">{amount(b.inFlight)}</td>
                <td />
              </tr>
              <tr className="font-medium">
                <td className="px-5 py-2">Total {b.adapted ? "(equals the underlying token)" : "(equals what was issued)"}</td>
                <td className="px-5 py-2 text-right tabular-nums">
                  <span className={cx("inline-flex items-center gap-1", b.conserved ? "text-ok" : "text-bad")}>
                    {b.conserved ? <CheckCircle2 size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
                    {amount(b.conserved ? b.expected : b.total, 2)}
                  </span>
                  {!b.conserved && <div className="text-xs text-bad">expected {amount(b.expected, 2)}</div>}
                </td>
                <td className="px-5 py-2 text-right text-xs">{b.conserved ? <Badge tone="ok">Reconciled</Badge> : <Badge tone="bad">Mismatch</Badge>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ReservesCard({ reserves, issued, symbol }: { reserves?: Recorded["reserves"]; issued?: number; symbol: string }) {
  if (!reserves) {
    return (
      <Card>
        <CardHeader title="Proof of reserves" subtitle="Add a reserve source (shares held, and who reports them) to the asset's config." />
      </Card>
    );
  }
  const backed = Number(reserves.shares) * reserves.tokensPerShare;
  const ok = issued === undefined || backed >= issued;
  return (
    <Card>
      <CardHeader
        title="Proof of reserves"
        subtitle="Supply on every chain, in transit included, against the shares held for the asset."
        action={issued === undefined ? undefined : <Badge tone={ok ? "ok" : "bad"}>{ok ? "Fully backed" : "Under-backed"}</Badge>}
      />
      <dl className="grid grid-cols-2 gap-y-3 p-5 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Shares held</dt>
          <dd className="mt-1 font-semibold tabular-nums">{Number(reserves.shares).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Tokens they back</dt>
          <dd className="mt-1 font-semibold tabular-nums">{backed.toLocaleString()} {symbol}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Issued, all chains</dt>
          <dd className="mt-1 font-semibold tabular-nums">{issued === undefined ? "—" : `${issued.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${symbol}`}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Coverage</dt>
          <dd className={cx("mt-1 font-semibold tabular-nums", ok ? "text-ok" : "text-bad")}>{issued ? `${((backed / issued) * 100).toFixed(2)}%` : "—"}</dd>
        </div>
      </dl>
      <p className="border-t border-line px-5 py-3 text-xs text-muted">
        Source: {reserves.source}
        {reserves.asOf ? `, reported ${reserves.asOf}` : ""}. {reserves.tokensPerShare} {symbol} per share.
      </p>
    </Card>
  );
}
