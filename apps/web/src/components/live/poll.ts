"use client";
import { useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data?: T;
  /** The last request failed (the server is down, or returned an error). */
  error?: string;
  /** When `data` was last received, in ms since the epoch. */
  at?: number;
}

/**
 * Fetch `url` now and every `everyMs` after, pausing while the tab is hidden. The server caches
 * each read for a few seconds, so many viewers polling one deployment cost one set of RPC reads.
 */
export function usePoll<T>(url: string, everyMs = 5_000): Polled<T> {
  const [state, setState] = useState<Polled<T>>({});
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (inFlight.current || document.visibilityState === "hidden") return;
      inFlight.current = true;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as T;
        if (alive) setState({ data, at: Date.now() });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        inFlight.current = false;
      }
    };
    void tick();
    const id = setInterval(tick, everyMs);
    const onVisible = () => document.visibilityState === "visible" && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, everyMs]);

  return state;
}

/** Re-render every second, for "updated 3s ago" labels. */
export function useNow(everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
