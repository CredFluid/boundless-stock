/** Whole-unit decimal strings from the API, formatted for reading. Display only; never for maths. */
export function amount(v: string | undefined, maxDigits = 4): string {
  if (v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (n !== 0 && Math.abs(n) < 10 ** -maxDigits) return `<${(10 ** -maxDigits).toFixed(maxDigits)}`;
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDigits });
}

export function price(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 6 : 4 });
}

/** "12s", "4m", "3h", "2d". */
export function age(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
