import { SiteHeader } from "@/components/site-header";
import { listDeployments } from "@/lib/deployments";
import { TradeWidget, type TradeMarket } from "./widget";

export const dynamic = "force-dynamic";
export const metadata = { title: "Trade" };

export default function Trade() {
  const markets: TradeMarket[] = listDeployments()
    .filter((d) => d.pool?.initialPrice)
    .map((d) => ({
      id: d.name,
      symbol: d.token.symbol,
      name: d.token.name,
      quote: d.quoteAsset.symbol,
      price: Number(d.pool!.initialPrice),
      feeTier: d.pool!.feeTier,
      home: { name: d.home.name, vm: d.home.vm },
      chains: [d.home, ...d.mirrors].map((c) => ({ key: c.key, name: c.name, vm: c.vm, home: c.role === "home" })),
    }));

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-12">
        <div className="mx-auto max-w-lg">
          <h1 className="text-2xl font-semibold tracking-tight">Trade</h1>
          <p className="mt-1 text-sm text-muted">
            Buy or sell from the chain you are on. The order is priced by the asset&apos;s home market and settles back to you here.
          </p>
          <div className="mt-6">
            <TradeWidget markets={markets} />
          </div>
        </div>
      </main>
    </>
  );
}
