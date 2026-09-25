"use client";
import { useState } from "react";
import type { RequestsView } from "@/lib/live";
import type { HistoryRecord } from "@infra/history";
import { Badge, Card, CardHeader, VmBadge, cx } from "@/components/ui";
import { age, amount, shortAddress } from "./format";
import { useNow, usePoll } from "./poll";
import { LiveIndicator, Unavailable } from "./status";

const FAILURE = ["", "slippage", "pool error", "unauthorised source"];

/** A request's outcome as a badge, with what happens next where the user has to wait. */
export function StatusBadge({ r }: { r: HistoryRecord }) {
  switch (r.status) {
    case "filled":
      return <Badge tone="ok">filled</Badge>;
    case "pending":
      return <Badge tone="accent">pending</Badge>;
    case "refunded":
      return <Badge tone="warn">refunded{r.failureReason ? ` · ${FAILURE[r.failureReason] ?? r.failureReason}` : ""}</Badge>;
    case "stranded":
      return r.strandedHeld === "0" ? <Badge tone="neutral">stranded · recovered</Badge> : <Badge tone="bad">stranded</Badge>;
    case "cancelled":
      return <Badge tone="neutral">cancelled · restored</Badge>;
  }
}

/** What came back: the fill, the refund, or what is still held. */
export function Outcome({ r }: { r: HistoryRecord }) {
  if (r.status === "filled") return <>{amount(r.amountOut)} {r.tokenOut}</>;
  if (r.status === "refunded") return <>{amount(r.amountIn)} {r.tokenIn} back</>;
  if (r.status === "cancelled") return <>{amount(r.amountIn)} {r.tokenIn} restored</>;
  if (r.status === "stranded")
    return r.strandedHeld && r.strandedHeld !== "0" ? <>{amount(r.strandedHeld)} held at home</> : <>returned by retry</>;
  return <span className="text-muted">≥ {amount(r.minAmountOut)} {r.tokenOut}</span>;
}

const FILTERS = ["all", "pending", "filled", "refunded", "stranded", "cancelled"] as const;

export function RequestHistory({ name, partners = {} }: { name: string; partners?: Record<number, string> }) {
  const { data, at, error } = usePoll<RequestsView>(`/api/deployments/${name}/requests?limit=200`);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const now = useNow(5_000) / 1000;
  const records = data?.history.records ?? [];
  const counts = Object.fromEntries(FILTERS.map((f) => [f, f === "all" ? records.length : records.filter((r) => r.status === f).length]));
  const shown = filter === "all" ? records : records.filter((r) => r.status === filter);

  return (
    <Card>
      <CardHeader
        title="Trade activity"
        subtitle="Every order placed on a distribution chain and where it ended up, read from chain. Pending orders are re-read until they settle."
        action={<LiveIndicator at={at} availability={data?.availability} error={error} />}
      />
      {(error || data?.availability.state !== "live") && (
        <div className="px-5 pt-4">
          <Unavailable
            availability={data?.availability}
            error={error}
            fallback={records.length > 0 ? "Showing the history as last synced." : "No history was synced while it was running."}
          />
        </div>
      )}
      <div className="flex gap-1 overflow-x-auto px-5 pt-4" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cx(
              "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap capitalize transition-colors",
              filter === f ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
            )}
          >
            {f} <span className="tabular-nums opacity-70">{counts[f]}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-5 py-2 font-medium">Order</th>
              <th className="px-5 py-2 font-medium">Routed by</th>
              <th className="px-5 py-2 font-medium">Amount</th>
              <th className="px-5 py-2 font-medium">Outcome</th>
              <th className="px-5 py-2 font-medium">Status</th>
              <th className="px-5 py-2 text-right font-medium">Placed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-muted">
                  {data ? (filter === "all" ? "No requests yet." : `No ${filter} requests.`) : "Loading…"}
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr key={r.key}>
                  <td className="px-5 py-2 whitespace-nowrap">
                    <span className="flex items-center gap-2">
                      {r.chainName} <span className="font-mono text-xs text-muted">#{r.id}</span> <VmBadge vm={r.vm} />
                    </span>
                  </td>
                  <td className="px-5 py-2 text-xs whitespace-nowrap text-muted" title={r.user}>
                    {r.partnerId ? <span className="font-medium text-fg">{partners[r.partnerId] ?? `Partner #${r.partnerId}`}</span> : "Direct"}
                    <div className="font-mono">{shortAddress(r.user)}</div>
                  </td>
                  <td className="px-5 py-2 whitespace-nowrap">
                    <span className={cx("mr-1 font-medium capitalize", r.direction === "buy" ? "text-ok" : "text-bad")}>{r.direction}</span>
                    {amount(r.amountIn)} {r.tokenIn}
                  </td>
                  <td className="px-5 py-2 whitespace-nowrap tabular-nums"><Outcome r={r} /></td>
                  <td className="px-5 py-2"><StatusBadge r={r} /></td>
                  <td className="px-5 py-2 text-right whitespace-nowrap text-muted" title={new Date(r.createdAt * 1000).toLocaleString()}>
                    {age(now - r.createdAt)} ago
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
