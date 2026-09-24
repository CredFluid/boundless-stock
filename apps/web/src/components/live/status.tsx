"use client";
import { CircleAlert, PlugZap } from "lucide-react";
import type { Availability } from "@/lib/live";
import { cx } from "@/components/ui";
import { useNow } from "./poll";

/** "Live · 3s ago" with a pulsing dot, or why the figures are not live. */
export function LiveIndicator({ at, availability, error }: { at?: number; availability?: Availability; error?: string }) {
  const now = useNow();
  if (!at && !error) return <span className="text-xs text-muted">Connecting…</span>;
  const live = availability?.state === "live" && !error;
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs whitespace-nowrap", live ? "text-ok" : "text-muted")}>
      <span className="relative flex size-2">
        {live && <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:hidden" />}
        <span className={cx("relative inline-flex size-2 rounded-full", live ? "bg-ok" : "bg-line")} />
      </span>
      {live ? "Live" : "Offline"}
      {at && <span className="text-muted">· {Math.max(0, Math.round((now - at) / 1000))}s ago</span>}
    </span>
  );
}

/** Why a deployment has no live figures, and what would give it some. */
export function Unavailable({
  availability,
  error,
  fallback = "The recorded deployment is shown instead.",
}: {
  availability?: Availability;
  error?: string;
  /** What the page shows instead of live figures. */
  fallback?: string;
}) {
  const reason = error
    ? `The read API did not answer (${error}).`
    : availability && availability.state !== "live"
      ? availability.reason
      : undefined;
  if (!reason) return null;
  const Icon = availability?.state === "unreachable" || error ? CircleAlert : PlugZap;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-dashed border-line bg-surface-2 px-4 py-3 text-sm text-muted">
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-fg">No live figures. </span>
        {reason}
        {availability?.state !== "unreachable" && !error && ` ${fallback}`}
      </span>
    </div>
  );
}
