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
}

export function DeploymentLive({ name, recorded }: { name: string; recorded: Recorded }) {
  const { data, at, error } = usePoll<LiveSnapshot>(`/api/deployments/${name}/live`);
  const live = data?.availability.state === "live" && !error ? data : undefined;
  const indicator = <LiveIndicator at={at} availability={data?.availability} error={error} />;
  const m = live?.market;
  const drift = m && recorded.initialPrice ? (m.price / Number(recorded.initialPrice) - 1) * 100 : undefined;
  const conserved = live?.supply && live.supply.base.conserved && live.supply.quote.conserved;

  return (
    <section className="space-y-4" aria-label="Live state">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Live state</h2>
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
                {recorded.quote} on {recorded.venue}
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
          label="Omnichain supply"
          value={<span className="text-lg">{live?.supply ? amount(conserved ? live.supply.base.expected : live.supply.base.total, 2) : recorded.genesis} {recorded.base}</span>}
          hint={
            live?.supply ? (
              conserved ? (
                <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 size={14} aria-hidden /> conserved on every chain</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-bad"><CircleAlert size={14} aria-hidden /> does not add up</span>
              )
            ) : (
              "genesis, as recorded"
            )
          }
        />
        <Stat
          label="Pool depth"
          value={<span className="text-lg">{amount(live ? m?.reserves.quote : recorded.seeded?.quote, 0)} {recorded.quote}</span>}
          hint={`and ${amount(live ? m?.reserves.base : recorded.seeded?.base, 2)} ${recorded.base}${live ? "" : " seeded"}`}
        />
        <Stat
          label="Relay gas"
          value={<span className="text-lg">{live?.relay ? `${amount(live.relay.native, 4)} ${live.relay.nativeSymbol}` : "—"}</span>}
          hint="pays for every return leg"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px] [&>*]:min-w-0">
        <SupplyCard supply={live?.supply} />
        <Card>
          <CardHeader title="Home market" subtitle={recorded.venue} />
          <dl className="grid grid-cols-2 gap-y-3 p-5 text-sm">
            <dt className="text-muted">Price now</dt>
            <dd className="text-right tabular-nums">{live ? `${price(m?.price)} ${recorded.quote}` : "—"}</dd>
            <dt className="text-muted">Launch price</dt>
            <dd className="text-right tabular-nums">{recorded.initialPrice ?? "—"} {recorded.quote}</dd>
            <dt className="text-muted">Fee tier</dt>
            <dd className="text-right tabular-nums">{recorded.feeTierPct !== undefined ? `${recorded.feeTierPct}%` : "—"}</dd>
            <dt className="text-muted">{recorded.base} in pool</dt>
            <dd className="text-right tabular-nums">{amount(live ? m?.reserves.base : recorded.seeded?.base, 2)}</dd>
            <dt className="text-muted">{recorded.quote} in pool</dt>
            <dd className="text-right tabular-nums">{amount(live ? m?.reserves.quote : recorded.seeded?.quote, 2)}</dd>
            <dt className="text-muted">Active liquidity</dt>
            <dd className="truncate text-right font-mono text-xs tabular-nums" title={m?.liquidity}>{m?.liquidity ?? "—"}</dd>
            {live?.relay && (
              <>
                <dt className="text-muted">Relay holds</dt>
                <dd className="text-right tabular-nums">
                  {amount(live.relay.holds.base, 4)} {recorded.base}
                  <br />
                  {amount(live.relay.holds.quote, 4)} {recorded.quote}
                </dd>
              </>
            )}
            {recorded.pool && (
              <>
                <dt className="text-muted">Pool</dt>
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
  return (
    <Card>
      <CardHeader
        title="Supply across chains"
        subtitle="Read from every chain now, in-flight transfers included. Supply plus in-flight must equal what exists at home."
      />
      {!supply ? (
        <p className="px-5 py-8 text-center text-sm text-muted">Shown while the deployment's chains are reachable.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2 font-medium">Chain</th>
                <th className="px-5 py-2 text-right font-medium">{supply.base.symbol}</th>
                <th className="px-5 py-2 text-right font-medium">{supply.quote.symbol}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {supply.base.rows.map((r) => {
                const q = supply.quote.rows.find((x) => x.key === r.key);
                return (
                  <tr key={r.key}>
                    <td className="px-5 py-2">
                      <span className="flex flex-wrap items-center gap-2">
                        {r.name}
                        <VmBadge vm={r.vm as "evm" | "svm"} />
                        {r.role === "home" && <Badge tone="accent">home</Badge>}
                      </span>
                      {r.pool !== undefined && (
                        <span className="text-xs text-muted">of which in the pool: {amount(r.pool, 2)} / {amount(q?.pool, 2)}</span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-right tabular-nums">{amount(r.supply)}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{amount(q?.supply)}</td>
                  </tr>
                );
              })}
              <tr className="text-muted">
                <td className="px-5 py-2">In flight</td>
                <td className="px-5 py-2 text-right tabular-nums">{amount(supply.base.inFlight)}</td>
                <td className="px-5 py-2 text-right tabular-nums">{amount(supply.quote.inFlight)}</td>
              </tr>
              <tr className="font-medium">
                <td className="px-5 py-2">
                  Supply + in flight{" "}
                  <span className="font-normal text-muted">= {supply.base.adapted ? "underlying" : "genesis"}</span>
                </td>
                {[supply.base, supply.quote].map((a) => (
                  <td key={a.symbol} className="px-5 py-2 text-right tabular-nums">
                    <span className={cx("inline-flex items-center gap-1", a.conserved ? "text-ok" : "text-bad")}>
                      {a.conserved ? <CheckCircle2 size={14} aria-hidden /> : <CircleAlert size={14} aria-hidden />}
                      {amount(a.conserved ? a.expected : a.total, 2)}
                    </span>
                    {!a.conserved && <div className="text-xs text-bad">expected {amount(a.expected, 2)}</div>}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
