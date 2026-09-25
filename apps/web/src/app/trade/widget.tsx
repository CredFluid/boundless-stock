"use client";

import { useMemo, useState } from "react";
import { ArrowDown, Info } from "lucide-react";
import { Card, VmBadge, cx } from "@/components/ui";

export interface TradeMarket {
  id: string;
  symbol: string;
  name: string;
  quote: string;
  price: number;
  feeTier: number;
  home: { name: string; vm: "evm" | "svm" };
  chains: { key: string; name: string; vm: "evm" | "svm"; home: boolean }[];
}

const selectCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent";

export function TradeWidget({ markets }: { markets: TradeMarket[] }) {
  const [marketId, setMarketId] = useState(markets[0]?.id ?? "");
  const market = markets.find((m) => m.id === marketId);
  const [chainKey, setChainKey] = useState(market?.chains.find((c) => !c.home)?.key ?? "");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("1000");
  const [slippage, setSlippage] = useState(1);

  const chain = market?.chains.find((c) => c.key === chainKey);
  // Indicative only: the deployment's starting price less the pool fee. The real quote comes
  // from the home pool at execution; the user's floor protects them either way.
  const quote = useMemo(() => {
    const a = Number(amount);
    if (!market || !Number.isFinite(a) || a <= 0) return undefined;
    const fee = market.feeTier / 1_000_000;
    const out = side === "buy" ? (a / market.price) * (1 - fee) : a * market.price * (1 - fee);
    return { out, floor: out * (1 - slippage / 100) };
  }, [market, amount, side, slippage]);

  if (!market) return <Card className="p-6 text-sm text-muted">No market has been deployed yet.</Card>;
  const [inSym, outSym] = side === "buy" ? [market.quote, market.symbol] : [market.symbol, market.quote];

  return (
    <Card className="p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-muted">Asset</span>
          <select className={cx(selectCls, "mt-1")} value={marketId}
            onChange={(e) => {
              const m = markets.find((x) => x.id === e.target.value);
              setMarketId(e.target.value);
              setChainKey(m?.chains.find((c) => !c.home)?.key ?? "");
            }}>
            {markets.map((m) => <option key={m.id} value={m.id}>{m.symbol} · {m.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-muted">Your chain</span>
          <select className={cx(selectCls, "mt-1")} value={chainKey} onChange={(e) => setChainKey(e.target.value)}>
            {market.chains.map((c) => <option key={c.key} value={c.key}>{c.name}{c.home ? " (home)" : ""}</option>)}
          </select>
        </label>
      </div>

      <div className="mt-4 inline-flex w-full rounded-lg border border-line p-0.5 text-sm">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)}
            className={cx("flex-1 rounded-md py-1.5 capitalize", side === s ? "bg-surface-2 font-medium" : "text-muted")}>
            {s}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-line p-4">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>You pay</span>
          {chain && <span className="inline-flex items-center gap-1">on {chain.name} <VmBadge vm={chain.vm} /></span>}
        </div>
        <div className="mt-1 flex items-center gap-3">
          <input inputMode="decimal" className="w-full bg-transparent text-2xl font-semibold tabular-nums outline-none"
            value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" />
          <span className="font-medium">{inSym}</span>
        </div>
      </div>
      <div className="-my-2 flex justify-center"><span className="z-10 rounded-full border border-line bg-surface p-1.5"><ArrowDown size={14} aria-hidden /></span></div>
      <div className="rounded-lg border border-line bg-surface-2 p-4">
        <div className="text-xs text-muted">You receive (indicative)</div>
        <div className="mt-1 flex items-center gap-3">
          <span className="w-full text-2xl font-semibold tabular-nums">
            {quote ? quote.out.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}
          </span>
          <span className="font-medium">{outSym}</span>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-muted">Priced by</dt>
        <dd className="text-right">{market.home.name} home market</dd>
        <dt className="text-muted">Pool fee</dt>
        <dd className="text-right">{market.feeTier / 10_000}%</dd>
        <dt className="text-muted">Max slippage</dt>
        <dd className="text-right">
          <select className="rounded border border-line bg-surface px-1 text-sm" value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
            {[0.5, 1, 2, 5].map((s) => <option key={s} value={s}>{s}%</option>)}
          </select>
        </dd>
        <dt className="text-muted">Minimum received</dt>
        <dd className="text-right tabular-nums">{quote ? `${quote.floor.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${outSym}` : "—"}</dd>
      </dl>

      <button type="button" disabled
        className="mt-5 w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-accent-contrast opacity-50">
        Connect wallet
      </button>
      <p className="mt-3 flex gap-2 text-xs text-muted">
        <Info size={14} className="mt-0.5 shrink-0" aria-hidden />
        In this preview the figure uses the market&apos;s launch price; a partner integration gets exact quotes from the market
        through the SDK. If the market can&apos;t meet the minimum, the {inSym} is returned in full.
      </p>
    </Card>
  );
}
