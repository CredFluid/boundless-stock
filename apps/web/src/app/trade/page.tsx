import { availabilityOf } from "@/lib/live";
import { SiteHeader } from "@/components/site-header";
import { listDeployments } from "@/lib/deployments";
import { TradeWidget, type TradeMarket } from "./widget";

export const dynamic = "force-dynamic";
export const metadata = { title: "Partner trading preview" };

export default function Trade() {
  const markets: TradeMarket[] = listDeployments()
    .filter((d) => d.pool?.initialPrice && d.home.vm === "svm" && availabilityOf(d.name).state === "live")
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
          <div className="text-xs font-medium uppercase tracking-wide text-accent">Partner trading preview</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Buy and sell from any chain</h1>
          <p className="mt-1 text-sm text-muted">
            The flow a distribution partner offers its verified users through the partner SDK. The order fills on the asset&apos;s
            market on Solana and settles back on the chain it came from.
          </p>
          <div className="mt-6">
            <TradeWidget markets={markets} />
          </div>
        </div>
      </main>
    </>
  );
}
