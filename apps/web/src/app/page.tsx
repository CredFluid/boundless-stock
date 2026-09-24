import Link from "next/link";
import { ArrowRight, Boxes, Globe2, ShieldCheck, Wallet, Layers, Repeat } from "lucide-react";
import { SiteHeader, Logo } from "@/components/site-header";
import { Badge, ButtonLink, Card } from "@/components/ui";

const PROOF = [
  { value: "99.605634 tAAPL", label: "delivered on Arbitrum Sepolia for 15,000 USDC — a chain with no market" },
  { value: "0.3944%", label: "total cost: exactly the 0.30% pool fee plus 0.0944% price impact" },
  { value: "1 transaction", label: "signed by the user, on the chain they already stand on" },
];

const STEPS = [
  {
    icon: Wallet,
    title: "Buy where you are",
    body: "A user on any supported chain spends USDC in one transaction. There is no pool, market maker or price on that chain — and none is needed.",
  },
  {
    icon: Repeat,
    title: "Priced at the home market",
    body: "The order travels over LayerZero to the asset's home chain, where one deep pool prices it. If the floor can't be met, the input comes back in full.",
  },
  {
    icon: ArrowRight,
    title: "Settled back to the user",
    body: "The stock arrives in the user's wallet on the chain they started from. Selling is the same path in reverse.",
  },
];

const FEATURES = [
  { icon: Globe2, title: "Any chain can be home", body: "EVM or Solana. The market lives on one chain; every other chain is a mirror with no liquidity of its own." },
  { icon: Layers, title: "Launch or adapt", body: "Mint a new omnichain asset, or bring a token you already have — holders keep their balances and the address never changes." },
  { icon: ShieldCheck, title: "Supply you can prove", body: "Every unit is accounted for across every chain and VM, in-flight transfers included, from chain state alone." },
  { icon: Boxes, title: "Config-driven", body: "One file describes the asset, the home chain and the mirrors. Adding a chain is one more entry and a re-run." },
];

export default function Landing() {
  return (
    <>
      <SiteHeader />
      <main>
        {/* ---------------------------------------------------------------- hero */}
        <section className="mx-auto max-w-6xl px-4 pt-16 pb-12 md:pt-24">
          <Badge tone="accent">Omnichain tokenized stocks · LayerZero V2</Badge>
          <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight md:text-6xl">
            One market. Every chain.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            CrossStock lets anyone trade a tokenized stock from whichever chain they hold funds on, priced by a single
            deep market on its home chain — with no liquidity needed anywhere else.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/app/launch">
              Launch an asset <ArrowRight size={16} aria-hidden />
            </ButtonLink>
            <ButtonLink href="/trade" variant="secondary">Try the trading app</ButtonLink>
          </div>
        </section>

        {/* ---------------------------------------------------------------- proof */}
        <section className="mx-auto max-w-6xl px-4 pb-16">
          <div className="grid gap-4 md:grid-cols-3">
            {PROOF.map((p) => (
              <Card key={p.value} className="p-6">
                <div className="text-2xl font-semibold tabular-nums">{p.value}</div>
                <p className="mt-2 text-sm text-muted">{p.label}</p>
              </Card>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">
            Measured by the validation suite on a local multi-chain set; reproduced on a second mirror, in the sell
            direction, and with Solana as the home chain.
          </p>
        </section>

        {/* ---------------------------------------------------------------- how */}
        <section id="how" className="border-y border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
            <div className="mt-8 grid gap-8 md:grid-cols-3">
              {STEPS.map((s, i) => (
                <div key={s.title}>
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent">
                      <s.icon size={18} aria-hidden />
                    </span>
                    <span className="text-xs font-medium text-muted">Step {i + 1}</span>
                  </div>
                  <h3 className="mt-4 font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm text-muted">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- features */}
        <section className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Built for issuers</h2>
          <p className="mt-2 max-w-2xl text-muted">
            Deploy an asset across chains, watch where every unit lives, and operate it — from one dashboard.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <Card key={f.title} className="p-6">
                <f.icon size={20} className="text-accent" aria-hidden />
                <h3 className="mt-4 font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm text-muted">{f.body}</p>
              </Card>
            ))}
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <ButtonLink href="/app">Open the dashboard <ArrowRight size={16} aria-hidden /></ButtonLink>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <Logo />
          <div className="flex gap-4">
            <Link href="/app" className="hover:text-fg">Dashboard</Link>
            <Link href="/trade" className="hover:text-fg">Trade</Link>
            <a href="https://github.com/CredFluid/boundless-stock" className="hover:text-fg">GitHub</a>
          </div>
        </div>
      </footer>
    </>
  );
}
