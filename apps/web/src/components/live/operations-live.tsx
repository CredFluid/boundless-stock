"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Anchor, Ban, Clock, RotateCcw, TriangleAlert } from "lucide-react";
import type { OperationsItem, OperationsView } from "@/lib/live";
import { Badge, Card, CardHeader, Stat, VmBadge } from "@/components/ui";
import { age, amount, shortAddress } from "./format";
import { usePoll } from "./poll";
import { Outcome, StatusBadge } from "./requests";
import { LiveIndicator } from "./status";

function Queue({
  title,
  subtitle,
  icon,
  items,
  empty,
  last,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  items: OperationsItem[] | undefined;
  empty: string;
  last: { label: string; cell: (r: OperationsItem) => ReactNode };
}) {
  return (
    <Card>
      <CardHeader title={`${title}${items ? ` · ${items.length}` : ""}`} subtitle={subtitle} action={icon} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-5 py-2 font-medium">Request</th>
              <th className="px-5 py-2 font-medium">Deployment</th>
              <th className="px-5 py-2 font-medium">Order</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 text-right font-medium">{last.label}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {!items || items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-muted">{items ? empty : "Loading…"}</td>
              </tr>
            ) : (
              items.map((r) => (
                <tr key={`${r.deployment}:${r.key}`}>
                  <td className="px-5 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      {r.chainName} <span className="font-mono text-xs text-muted">#{r.id}</span> <VmBadge vm={r.vm} />
                    </span>
                    <span className="font-mono text-xs text-muted" title={r.user}>{shortAddress(r.user)}</span>
                  </td>
                  <td className="px-5 py-2">
                    <Link href={`/app/deployments/${r.deployment}`} className="font-mono text-xs hover:text-accent">{r.deployment}</Link>
                  </td>
                  <td className="px-5 py-2 whitespace-nowrap">
                    <span className="mr-1 capitalize">{r.direction}</span>
                    {amount(r.amountIn)} {r.tokenIn}
                  </td>
                  <td className="px-5 py-2"><StatusBadge r={r} /></td>
                  <td className="px-5 py-2 text-right whitespace-nowrap tabular-nums">{last.cell(r)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function OperationsLive() {
  const { data, at, error } = usePoll<OperationsView>("/api/operations");
  const live = data?.deployments.filter((d) => d.availability.state === "live") ?? [];
  const offline = data?.deployments.filter((d) => d.availability.state !== "live") ?? [];
  const ageCell = { label: "Age", cell: (r: OperationsItem) => `${age(r.ageSeconds)}` };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          Watching {live.length} live asset{live.length === 1 ? "" : "s"} across every distribution chain.
        </p>
        <LiveIndicator at={at} availability={data ? { state: "live" } : undefined} error={error} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Pending" value={data?.pending.length ?? "—"} hint="orders on their way to the market" />
        <Stat
          label="Needs attention"
          value={<span className={data?.attention.length ? "text-bad" : undefined}>{data?.attention.length ?? "—"}</span>}
          hint="pending for over 10 minutes"
        />
        <Stat
          label="Stranded"
          value={<span className={data?.stranded.length ? "text-bad" : undefined}>{data?.stranded.length ?? "—"}</span>}
          hint={`${data?.recovered.length ?? 0} recovered by retry`}
        />
        <Stat label="Cancelled" value={data?.cancelled.length ?? "—"} hint="input restored on the mirror" />
      </div>

      <Queue
        title="Needs attention"
        subtitle="Pending for over 10 minutes. Usually a transfer that never reached Solana: cancel it there, and the origin chain restores the user's funds."
        icon={<TriangleAlert size={18} className="text-warn" aria-hidden />}
        items={data?.attention}
        empty="Nothing has been pending for long."
        last={ageCell}
      />
      <Queue
        title="Pending requests"
        subtitle="Orders placed on a distribution chain that have not settled yet. Normally about a second."
        icon={<Clock size={18} className="text-muted" aria-hidden />}
        items={data?.pending}
        empty="No orders in flight."
        last={ageCell}
      />
      <Queue
        title="Stranded returns"
        subtitle="Results held on Solana because the return could not be delivered. The funds are safe there, and the return can be retried."
        icon={<Anchor size={18} className="text-muted" aria-hidden />}
        items={data?.stranded}
        empty="Nothing is held at home."
        last={{ label: "Held", cell: (r) => <Outcome r={r} /> }}
      />
        <Queue
          title="Recovered"
          subtitle="Stranded, then returned by a retry."
          icon={<RotateCcw size={18} className="text-muted" aria-hidden />}
          items={data?.recovered}
          empty="None."
          last={ageCell}
        />
        <Queue
          title="Cancelled"
          subtitle="Stuck transfers cancelled on Solana, with the user's funds restored on the origin chain."
          icon={<Ban size={18} className="text-muted" aria-hidden />}
          items={data?.cancelled}
          empty="None."
          last={ageCell}
        />

      {false && offline.length > 0 && (
        <Card>
          <CardHeader title="Not watched" subtitle="Deployments whose chains this server cannot read. Their queues are not included above." />
          <ul className="divide-y divide-line text-sm">
            {offline.map((d) => (
              <li key={d.name} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <Link href={`/app/deployments/${d.name}`} className="font-mono text-xs hover:text-accent">{d.name}</Link>
                <span className="flex items-center gap-2 text-muted">
                  <Badge>{d.availability.state}</Badge>
                  <span className="text-xs">{"reason" in d.availability ? d.availability.reason : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
