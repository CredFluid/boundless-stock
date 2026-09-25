/**
 * Proof of reserves for an asset, for anyone integrating it: the supply measured on every chain,
 * transfers in transit included, against the shares held for it.
 *
 *     backed = shares held × tokens per share        fully backed when backed ≥ issued
 *
 * "Issued" is measured from chain state (the same reading as `boundless-stock market` and the
 * issuer console), so a lending protocol, custodian or wallet can check backing without trusting
 * the issuer's own figure for supply.
 */
import { formatUnits, parseUnits } from "viem";
import { measureSupply } from "../lib/omnisupply.js";
import type { ApiContext } from "./context.js";

export interface ReservesReport {
  deployment: string;
  asset: { symbol: string; name: string };
  /** Whole units, as decimal strings. */
  issued: string;
  inTransit: string;
  chains: { key: string; name: string; vm: "evm" | "svm"; role: "home" | "mirror"; supply: string }[];
  /** Supply on every chain plus in transit equals what was issued at launch. */
  reconciled: boolean;
  /** Absent when the asset has no reserve source configured. */
  reserves?: {
    shares: string;
    tokensPerShare: number;
    source: string;
    asOf?: string;
    /** Tokens the shares back, whole units. */
    backed: string;
    /** backed / issued, in basis points (10000 = 100%). */
    coverageBps: number;
    fullyBacked: boolean;
  };
  /** When this was read, ISO 8601. */
  at: string;
}

export async function reserves(ctx: ApiContext): Promise<ReservesReport> {
  const s = (await measureSupply(ctx.cfg, ctx.manifest, ctx.evm)).base;
  const issuedRaw = s.total + s.inFlight;
  const whole = (v: bigint) => formatUnits(v, s.decimals);
  const r = ctx.cfg.token.reserves;
  let report: ReservesReport["reserves"];
  if (r) {
    const perShare = r.tokensPerShare ?? 1;
    const backedRaw = (parseUnits(r.shares, s.decimals) * BigInt(Math.round(perShare * 1e6))) / 1_000_000n;
    const coverageBps = issuedRaw === 0n ? 0 : Number((backedRaw * 10_000n) / issuedRaw);
    report = {
      shares: r.shares,
      tokensPerShare: perShare,
      source: r.source,
      asOf: r.asOf,
      backed: whole(backedRaw),
      coverageBps,
      fullyBacked: backedRaw >= issuedRaw,
    };
  }
  return {
    deployment: ctx.cfg.name,
    asset: { symbol: ctx.cfg.token.symbol, name: ctx.cfg.token.name },
    issued: whole(issuedRaw),
    inTransit: whole(s.inFlight),
    chains: s.rows.map((row) => ({ key: row.key, name: row.name, vm: row.vm, role: row.role, supply: whole(row.supply) })),
    reconciled: issuedRaw === s.expected,
    reserves: report,
    at: new Date().toISOString(),
  };
}
