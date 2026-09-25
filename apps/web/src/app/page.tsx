import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  BadgeCheck,
  Coins,
  FileCheck2,
  Handshake,
  Receipt,
  GitBranch,
  KeyRound,
  Layers,
  LifeBuoy,
  RotateCcw,
  Scale,
  ShieldCheck,
  Terminal,
  Undo2,
  Wallet,
  XCircle,
} from "lucide-react";
import { NetworkVisual } from "@/components/landing/network";
import { CodeWindow, C, K, N, S } from "@/components/landing/code-window";
import { CountUp, Reveal, TypedTerminal } from "@/components/landing/motion";

const REPO = "https://github.com/CredFluid/boundless-stock";

/* What stays on Solana, the home chain. Each is how the system works today. */
const CONTROL = [
  {
    icon: FileCheck2,
    title: "Issuance and backing",
    body: "The asset is issued once, on Solana, against the shares that back it. Its supply on every chain is measured continuously and checked against those shares.",
  },
  {
    icon: KeyRound,
    title: "Controls",
    body: "Roles, the partner gate, fees and recovery of any stuck or stranded transfer are held on the home chain and run from one console.",
  },
  {
    icon: Coins,
    title: "Liquidity",
    body: "The reference market lives on Solana and prices every order placed through Boundless Stock. No chain needs a pool of its own to be tradable; local pools can still form, and arbitrage keeps them in line.",
  },
];

/* What every other chain gets. "Roadmap" marks what the infrastructure is built for but does not ship yet. */
const USE_CASES = [
  { icon: Handshake, title: "Distribution through partners", body: "Brokers, wallets and exchanges offer the asset to their verified users on the chains those users already hold funds on.", roadmap: false },
  { icon: ArrowRight, title: "Trading", body: "Buy and sell from any chain in one transaction, filled against the Solana market and settled back on the same chain.", roadmap: false },
  { icon: Layers, title: "Holding, transfers and local markets", body: "The same backed asset on every chain, never a wrapped copy. Holders transfer it and local pools can trade it on that chain; moves between chains burn and mint.", roadmap: false },
  { icon: Scale, title: "Collateral and settlement", body: "The asset as collateral or a settlement leg on other chains, on the same supply and backing guarantees.", roadmap: true },
];

/* Every figure here is true of the system today and measured on local multi-chain deployments. */
const METRICS = [
  { value: "100%", label: "Backed, checked continuously", note: "supply on every chain measured against the shares held" },
  { value: "1", label: "Ledger across every chain", note: "one supply, reconciled wherever the asset sits or trades" },
  { value: "0", label: "Wrapped copies", note: "every chain holds the original asset, never an IOU" },
  { value: "~1s", label: "Cross-chain settlement", note: "an order on another chain, filled on Solana and delivered back" },
];

const NETWORKS = ["Solana · home", "Base", "Arbitrum", "Optimism", "SVM chains", "Any LayerZero V2 chain"];

const LIFECYCLE = [
  { n: "01", title: "Order", body: "A partner's verified user places a buy or sell on their own chain. The funds leave with the order attached, in one transaction." },
  { n: "02", title: "Execute", body: "On Solana the order fills against the reference market, at or above the user's floor, or the funds are returned in full." },
  { n: "03", title: "Settle", body: "The stock, or the proceeds of a sale, is delivered back on the chain the order came from." },
  { n: "04", title: "Reconcile", body: "Every unit is counted on every chain, in transit included, and checked against the shares that back the asset." },
];

const COMPLIANCE = [
  { icon: Handshake, title: "Partner-gated orders", body: "Switch on the partner gate and only orders approved by a registered partner get in. The partner runs KYC on its own users; on Solana it co-signs each order." },
  { icon: Receipt, title: "Fees only on a fill", body: "Partner and platform fees are held in escrow and paid out only when an order fills. A refunded or cancelled order returns them in full." },
  { icon: Terminal, title: "Partner SDK and API", body: "Exact quotes from the Solana market, ready-to-sign orders, order tracking and signed webhooks. The partner never holds user funds." },
  { icon: KeyRound, title: "The issuer keeps the mint", body: "Bring an existing token and it is adapted, not replaced. Holders keep their balances, and on Solana the issuer keeps the mint authority." },
];

const GUARANTEES = [
  { icon: BadgeCheck, title: "Proof of reserves", body: "Supply across every chain, in transit included, is checked against the shares held for the asset, with the source and date of the attestation." },
  { icon: Scale, title: "Continuous reconciliation", body: "Supply on every chain plus what is in transit always equals what was issued, measured from chain state, mid-transfer included." },
  { icon: Undo2, title: "Filled or refunded", body: "An order fills at or above the user's floor, or its funds come back in full. There is no partial or bad fill." },
  { icon: RotateCcw, title: "Nothing stranded", body: "If a return can't be delivered, the funds are held on Solana and the origin chain is told. The return can be retried later, and never redirected." },
  { icon: XCircle, title: "Stuck transfers reversed safely", body: "A transfer that never arrives is cancelled on Solana first, provably undeliverable, and only then restored on the origin chain." },
  { icon: CheckCircle2, title: "Verified deployment", body: "Every cross-chain connection is read back from chain and checked. A deployment with a mismatch refuses to report itself complete." },
];

const AUDIENCES = [
  { icon: Building2, title: "Issuers and asset managers", body: "Issue a tokenized stock or RWA once, on Solana, or bring the token you already have. Choose the chains to distribute to, and run supply, backing and controls from one console.", cta: { href: "/app/launch", label: "Launch an asset" } },
  { icon: Handshake, title: "Distribution partners", body: "Brokers, wallets and exchanges offer the asset to their verified users on the chains they use, earn a fee on every fill, and never source liquidity.", cta: { href: "#compliance", label: "See the partner model" } },
  { icon: FileCheck2, title: "Custodians and auditors", body: "See where every unit of the asset sits, on every chain and in transit, and check it against the shares held. Live, from chain state.", cta: { href: "/app", label: "Open the issuer console" } },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent">{children}</div>;
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-contrast">B</span>
          Boundless Stock
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
          <a href="#platform" className="hover:text-fg">Platform</a>
          <a href="#compliance" className="hover:text-fg">Distribution</a>
          <a href="#security" className="hover:text-fg">Controls</a>
          <a href="#developers" className="hover:text-fg">Developers</a>
          <a href={REPO} className="hover:text-fg">GitHub</a>
        </nav>
        <Link href="/app" className="rounded-lg bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90">
          Issuer console
        </Link>
      </div>
    </header>
  );
}

export default function Landing() {
  return (
    <div data-theme="dark" className="min-h-dvh">
      <LandingHeader />

      {/* ================================================================ hero */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="bg-grid mask-fade absolute inset-0" aria-hidden />
        <div className="glow absolute inset-0" aria-hidden />
        <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 pt-16 pb-20 lg:grid-cols-[1.05fr_1fr] lg:pt-24 lg:pb-28">
          <div>
            <a href="#platform" className="enter enter-1 inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 py-1 pr-3 pl-1 text-xs text-muted hover:text-fg">
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">RWA</span>
              For issuers, asset managers and their distribution partners
              <ArrowRight size={12} aria-hidden />
            </a>
            <h1 className="enter enter-2 mt-7 text-5xl font-semibold leading-[1.02] tracking-tight text-balance md:text-7xl">
              Manage from one chain.{" "}
              <span className="text-shimmer bg-gradient-to-r from-accent via-evm to-accent bg-clip-text text-transparent">Power every other.</span>
            </h1>
            <p className="enter enter-3 mt-6 max-w-xl text-lg leading-relaxed text-muted">
              Issue a tokenized stock or RWA once, on Solana. Run its supply, backing, controls and liquidity from one console,
              and distribute it to every other chain through regulated partners, with no market to fund there first.
            </p>
            <div className="enter enter-4 mt-9 flex flex-wrap gap-3">
              <Link href="/app/launch" className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast hover:opacity-90">
                Launch an asset <ArrowRight size={16} aria-hidden />
              </Link>
              <a href="#developers" className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-5 py-3 text-sm font-medium hover:bg-surface-2">
                <Terminal size={16} aria-hidden /> Start building
              </a>
            </div>
            <div className="enter enter-5 mt-10 grid max-w-xl gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-surface/60 px-4 py-3">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent">Solana · home</div>
                <div className="mt-1 text-sm">Issuance · Controls · Liquidity</div>
              </div>
              <div className="rounded-lg border border-line bg-surface/60 px-4 py-3">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-evm">Every other chain</div>
                <div className="mt-1 text-sm">Distribution · Trading · Transfers</div>
              </div>
            </div>
          </div>
          <div className="enter enter-3 relative">
            <div className="floaty">
              <NetworkVisual />
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================ metrics */}
      <section className="border-b border-line bg-surface/40">
        <div className="mx-auto grid max-w-7xl grid-cols-2 lg:grid-cols-4">
          {METRICS.map((m, i) => (
            <div key={m.label} className={`px-5 py-10 ${i > 0 ? "lg:border-l" : ""} ${i % 2 === 1 ? "border-l" : ""} ${i >= 2 ? "border-t lg:border-t-0" : ""} border-line`}>
              <div className="text-3xl font-semibold tracking-tight tabular-nums md:text-4xl"><CountUp value={m.value} /></div>
              <div className="mt-2 text-sm font-medium">{m.label}</div>
              <div className="mt-1 text-xs text-muted">{m.note}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================ networks */}
      <section className="border-b border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-8 md:flex-row md:items-center">
          <div className="shrink-0 font-mono text-xs uppercase tracking-[0.2em] text-muted">Distributes to</div>
          {/* Scrolls when motion is on (the list twice, moved by half); a plain wrapped row otherwise. */}
          <div className="marquee relative min-w-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_8%,#000_92%,transparent)]">
            <div className="marquee-row flex">
              {[false, true].map((copy) => (
                <div key={String(copy)} aria-hidden={copy || undefined} className="marquee-track flex shrink-0 gap-2 pr-2">
                  {NETWORKS.map((n) => (
                    <span key={n} className="whitespace-nowrap rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-muted">{n}</span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ================================================================ platform: one chain to run it */}
      <section id="platform" className="scroll-mt-20 mx-auto max-w-7xl px-5 py-24">
        <Reveal>
          <Eyebrow>Manage on Solana · distribute everywhere</Eyebrow>
          <h2 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">
            Manage issuance, controls and liquidity from one chain. Distribute to every other.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            The parts an institution is accountable for, what backs the asset, who can touch it and where it trades, stay on
            Solana. Every other chain holds a mirror of the same asset and none of the overhead.
          </p>
        </Reveal>

        <div className="mt-14 grid items-stretch gap-6 lg:grid-cols-[1fr_72px_1.25fr]">
          {/* control plane */}
          <Reveal delay={80}>
            <div className="h-full rounded-2xl border border-accent/50 bg-gradient-to-b from-accent-soft to-surface p-7">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs uppercase tracking-[0.18em] text-accent">Solana · control plane</span>
                <span className="rounded-full border border-accent/40 px-2 py-0.5 text-xs text-accent">home</span>
              </div>
              <ul className="mt-7 space-y-6">
                {CONTROL.map((c) => (
                  <li key={c.title} className="flex gap-4">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-surface text-accent">
                      <c.icon size={18} aria-hidden />
                    </span>
                    <div>
                      <h3 className="font-semibold">{c.title}</h3>
                      <p className="mt-1 text-sm leading-relaxed text-muted">{c.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          {/* the link between them: LayerZero messaging, drawn as a moving beam */}
          <div className="relative flex items-center justify-center" aria-hidden>
            <div className="beam h-16 w-0.5 rounded-full lg:h-0.5 lg:w-full" />
            <span className="absolute rounded-full border border-line bg-bg px-2 py-1 font-mono text-[10px] tracking-wider text-muted">LZ V2</span>
          </div>

          {/* use cases */}
          <Reveal delay={200}>
            <div className="grid h-full gap-4 sm:grid-cols-2">
              {USE_CASES.map((u) => (
                <div key={u.title} className={`lift flex flex-col rounded-2xl border bg-surface p-6 ${u.roadmap ? "border-dashed border-line" : "border-line hover:border-evm/60"}`}>
                  <div className="flex items-center justify-between">
                    <u.icon size={18} className={u.roadmap ? "text-muted" : "text-evm"} aria-hidden />
                    <span className={`rounded-full px-2 py-0.5 text-[11px] ${u.roadmap ? "bg-surface-2 text-muted" : "bg-evm-soft text-evm"}`}>
                      {u.roadmap ? "Roadmap" : "Live"}
                    </span>
                  </div>
                  <h3 className="mt-5 font-semibold">{u.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{u.body}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <div className="mt-10 flex flex-wrap items-center gap-2 text-sm">
            <span className="mr-2 font-mono text-xs uppercase tracking-[0.18em] text-muted">Works for</span>
            {["Tokenized equities", "Tokenized treasuries", "Fund shares", "Other real-world assets"].map((a) => (
              <span key={a} className="rounded-md border border-line bg-surface px-3 py-1.5 text-muted">{a}</span>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ================================================================ problem */}
      <section className="mx-auto max-w-7xl px-5 py-24">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">
            A backed asset can&apos;t be minted again for every chain.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            When a team launches an ordinary token, it decides how much to mint, and mints more when a new market needs
            liquidity. A tokenized stock has no such freedom: an issuer holding 100,000 shares can issue 100,000 tokens and not
            one more. Every chain it goes to takes a slice of that fixed supply.
          </p>
        </Reveal>
        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          <Reveal delay={100}><div className="h-full rounded-2xl border border-line bg-surface p-8">
            <div className="text-sm font-medium text-bad">Today</div>
            <ul className="mt-5 space-y-4 text-muted">
              <li className="flex gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />Every chain gets its own thin pool, carved out of a supply that cannot grow to fill it, so the same share trades at different prices.</li>
              <li className="flex gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />Every chain adds its own market to fund, its own operations and its own ledger to reconcile.</li>
              <li className="flex gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />Bridges leave wrapped copies, and custodians and auditors can no longer say where the supply sits.</li>
            </ul>
          </div></Reveal>
          <Reveal delay={250}><div className="h-full rounded-2xl border border-accent/40 bg-gradient-to-b from-accent-soft to-surface p-8">
            <div className="text-sm font-medium text-accent">With Boundless Stock</div>
            <ul className="mt-5 space-y-4">
              <li className="flex gap-3"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />The asset is issued once, on Solana, and its reference market lives there, holding the deepest liquidity in one place.</li>
              <li className="flex gap-3"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />Every other chain holds a mirror, minted only when stock arrives from Solana and burned when it leaves. Never a new issue.</li>
              <li className="flex gap-3"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />Supply on every chain is reconciled continuously against the shares behind it, from one console.</li>
            </ul>
          </div></Reveal>
        </div>
      </section>

      {/* ================================================================ regulated distribution */}
      <section id="compliance" className="scroll-mt-20 mx-auto max-w-7xl px-5 pb-24">
        <Reveal>
          <Eyebrow>Built for regulated distribution</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">
            Your partners own the customer. You keep control of the asset.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            Brokers, wallets and exchanges bring the asset to their verified users on the chains those users are on. The
            issuer decides who can route orders, and every order is approved before it reaches the market.
          </p>
        </Reveal>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {COMPLIANCE.map((c, i) => (
            <Reveal key={c.title} delay={i * 100}><div className="lift flex h-full flex-col rounded-2xl border border-line bg-surface p-6 hover:border-accent/50">
              <c.icon size={20} className="text-accent" aria-hidden />
              <h3 className="mt-5 font-semibold">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{c.body}</p>
            </div></Reveal>
          ))}
        </div>
      </section>

      {/* ================================================================ architecture */}
      <section id="architecture" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-7xl px-5 py-24">
          <Reveal>
            <Eyebrow>Architecture</Eyebrow>
            <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">Four layers. One ledger.</h2>
            <p className="mt-5 max-w-2xl text-lg text-muted">
              From the partner that serves the customer to the ledger an auditor checks, each layer has one job, and the chain
              a customer is on stops mattering.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-10 lg:grid-cols-[1.1fr_1fr]">
            {/* stack */}
            <div className="space-y-3">
              {[
                { tag: "Distribution", title: "Brokers · wallets · exchanges, serving verified users", tone: "border-line", items: ["Partner SDK and API", "Partner approval", "Fees on fill"] },
                { tag: "Settlement", title: "Partner orders from any chain filled on the Solana market", tone: "border-accent/60 bg-accent-soft/40", items: ["Reference market on Solana", "Filled or refunded", "Delivered on the origin chain"] },
                { tag: "Reconciliation", title: "One supply, measured on every chain", tone: "border-line", items: ["Supply per chain", "In-transit tracking", "Proof of reserves"] },
                { tag: "Messaging", title: "LayerZero V2, verified between chains", tone: "border-line", items: ["Burn-and-mint transfers", "Independent verification", "EVM and SVM chains"] },
              ].map((l, i) => (
                <Reveal key={l.tag} delay={i * 120}><div className={`lift rounded-xl border bg-surface p-5 ${l.tone}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-mono text-xs uppercase tracking-[0.18em] text-accent">{l.tag}</span>
                    <span className="text-sm font-medium">{l.title}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {l.items.map((i) => (
                      <span key={i} className="rounded-md bg-surface-2 px-2.5 py-1 text-xs text-muted">{i}</span>
                    ))}
                  </div>
                </div></Reveal>
              ))}
            </div>

            {/* lifecycle */}
            <Reveal className="rail relative">
            {/* the rail, and its fill that draws down as the section comes into view */}
            <span aria-hidden className="absolute top-0 bottom-0 left-0 w-px bg-line" />
            <span aria-hidden className="rail-fill absolute top-0 bottom-0 left-0 w-px bg-gradient-to-b from-accent to-evm" />
            <ol className="relative space-y-8 pl-8">
              {LIFECYCLE.map((s) => (
                <li key={s.n} className="relative">
                  <span className="absolute top-0 -left-[46px] grid h-7 w-7 place-items-center rounded-full border border-line bg-bg font-mono text-[11px] text-accent">
                    {s.n}
                  </span>
                  <h3 className="font-semibold">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ developers */}
      <section id="developers" className="scroll-mt-20 mx-auto max-w-7xl px-5 py-24">
        <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <Reveal className="min-w-0">
            <Eyebrow>For developers</Eyebrow>
            <h2 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">From one command to a live, reconciled market.</h2>
            <p className="mt-5 text-lg text-muted">
              Describe the asset and choose the chains to distribute to. One command issues it on Solana, creates the mirrors,
              opens the market and verifies every connection.
            </p>
            <ul className="mt-8 space-y-4 text-sm">
              {[
                ["Choose the chains", "Distribute to any mix of EVM and SVM chains with one flag, and add more later."],
                ["Verified, not assumed", "Every cross-chain connection is read back from chain, and a record keeps exactly what was deployed."],
                ["Market data", "Price, supply on Solana and on every other chain, and proof of reserves, in one view."],
                ["Partner SDK and API", "Exact quotes, ready-to-sign orders, tracking and signed webhooks for distribution partners."],
              ].map(([t, b]) => (
                <li key={t} className="flex gap-3">
                  <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                  <span><span className="font-medium">{t}.</span> <span className="text-muted">{b}</span></span>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={150} className="min-w-0 space-y-4">
            <CodeWindow title="config/my-asset.json — abridged">
{`{
  `}<K>&quot;token&quot;</K>{`: { `}<K>&quot;symbol&quot;</K>{`: `}<S>&quot;tAAPL&quot;</S>{`, `}<K>&quot;initialSupply&quot;</K>{`: `}<S>&quot;1000000&quot;</S>{`,
    `}<K>&quot;reserves&quot;</K>{`: { `}<K>&quot;shares&quot;</K>{`: `}<S>&quot;1000000&quot;</S>{`, `}<K>&quot;source&quot;</K>{`: `}<S>&quot;custodian attestation&quot;</S>{` } },
  `}<K>&quot;homeChain&quot;</K>{`: { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;solana&quot;</S>{`, `}<K>&quot;vm&quot;</K>{`: `}<S>&quot;svm&quot;</S>{` },`}<C>{`   // issued and traded here`}</C>{`
  `}<K>&quot;mirrorChains&quot;</K>{`: [
    { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;base&quot;</S>{` }, { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;arbitrum&quot;</S>{` }, { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;optimism&quot;</S>{` }
  ],
  `}<K>&quot;pool&quot;</K>{`: { `}<K>&quot;initialPrice&quot;</K>{`: `}<S>&quot;150&quot;</S>{`, `}<K>&quot;feeTier&quot;</K>{`: `}<N>3000</N>{` }
}`}
            </CodeWindow>
            <TypedTerminal
              title="terminal"
              lines={[
                { kind: "cmd", text: "boundless-stock deploy --mirrors base,arbitrum,svm-chain" },
                { kind: "out", text: "tAAPL issued on Solana · mirrored to 3 chains · market live" },
                { kind: "cmd", text: "boundless-stock buy --on base --spend 15000" },
                { kind: "out", text: "99.32568 tAAPL delivered on Base · 1.2s" },
                { kind: "cmd", text: "boundless-stock market" },
                { kind: "out", text: "1,000,000 tAAPL · conserved on every chain · fully backed" },
              ]}
            />
          </Reveal>
        </div>
      </section>

      {/* ================================================================ security */}
      <section id="security" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-7xl px-5 py-24">
          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:items-end">
            <Reveal>
              <Eyebrow>Controls and assurance</Eyebrow>
              <h2 className="mt-4 text-4xl font-semibold tracking-tight text-balance md:text-5xl">Every unit accounted for. Every failure has a path home.</h2>
            </Reveal>
            <Reveal delay={150}><p className="text-lg text-muted">
              An asset spread across chains has to stay as accountable as one on a single register. Boundless Stock reconciles it
              continuously, checks it against its backing, and gives every failure between chains a recovery path, tested end to
              end on EVM and on Solana.
            </p></Reveal>
          </div>
          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {GUARANTEES.map((g, i) => (
              <Reveal key={g.title} delay={(i % 3) * 110} className="bg-surface"><div className="h-full p-7 transition-colors hover:bg-surface-2">
                <g.icon size={20} className="text-accent" aria-hidden />
                <h3 className="mt-5 font-semibold">{g.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{g.body}</p>
              </div></Reveal>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted">
            <span className="inline-flex items-center gap-2"><ShieldCheck size={16} className="text-accent" aria-hidden /> Fuzzed and invariant-tested contracts</span>
            <span className="inline-flex items-center gap-2"><LifeBuoy size={16} className="text-accent" aria-hidden /> Recovery actions on chain today</span>
            <span className="inline-flex items-center gap-2"><BadgeCheck size={16} className="text-accent" aria-hidden /> Proof of reserves in the issuer console</span>
          </div>
        </div>
      </section>

      {/* ================================================================ audiences */}
      <section className="mx-auto max-w-7xl px-5 py-24">
        <Reveal>
          <Eyebrow>Who it&apos;s for</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-balance md:text-5xl">Built for everyone accountable for the asset.</h2>
        </Reveal>
        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {AUDIENCES.map((a, i) => (
            <Reveal key={a.title} delay={i * 120}><div className="lift group flex h-full flex-col rounded-2xl border border-line bg-surface p-8 hover:border-accent/50">
              <a.icon size={22} className="text-accent" aria-hidden />
              <h3 className="mt-6 text-xl font-semibold">{a.title}</h3>
              <p className="mt-3 flex-1 text-muted">{a.body}</p>
              <Link href={a.cta.href} className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-accent">
                {a.cta.label} <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" aria-hidden />
              </Link>
            </div></Reveal>
          ))}
        </div>
      </section>

      {/* ================================================================ cta */}
      <section className="relative overflow-hidden border-t border-line">
        <div className="bg-grid mask-fade absolute inset-0 opacity-60" aria-hidden />
        <div className="glow absolute inset-0" aria-hidden />
        <Reveal className="relative mx-auto max-w-4xl px-5 py-28 text-center">
          <h2 className="text-4xl font-semibold tracking-tight text-balance md:text-6xl">Issue once. Distribute everywhere. Stay accountable.</h2>
          <p className="mx-auto mt-6 max-w-xl text-lg text-muted">
            Start from the issuer console, or read the code. It is all open.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <Link href="/app/launch" className="inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-accent-contrast hover:opacity-90">
              Launch an asset <ArrowRight size={16} aria-hidden />
            </Link>
            <a href={REPO} className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-6 py-3 text-sm font-medium hover:bg-surface-2">
              <GitBranch size={16} aria-hidden /> View on GitHub
            </a>
          </div>
        </Reveal>
      </section>

      {/* ================================================================ footer */}
      <footer className="border-t border-line bg-surface/40">
        <div className="mx-auto grid max-w-7xl gap-10 px-5 py-16 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5 font-semibold">
              <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-contrast">B</span>
              Boundless Stock
            </div>
            <p className="mt-4 max-w-xs text-sm text-muted">Issuance, distribution and reconciliation for tokenized stocks and real-world assets, with Solana as home.</p>
          </div>
          {[
            { title: "Product", links: [["Issuer console", "/app"], ["Launch an asset", "/app/launch"], ["Operations and controls", "/app/operations"], ["Partner trading preview", "/trade"]] },
            { title: "Developers", links: [["GitHub", REPO], ["Partner SDK and API", `${REPO}/blob/main/PARTNERS.md`], ["Overview", `${REPO}#readme`]] },
            { title: "Assurance", links: [["Proof of reserves", `${REPO}/blob/main/PROOF_OF_RESERVES.md`], ["Validation report", `${REPO}/blob/main/REPORT.md`]] },
          ].map((col) => (
            <div key={col.title}>
              <div className="font-mono text-xs uppercase tracking-[0.18em] text-muted">{col.title}</div>
              <ul className="mt-4 space-y-2.5 text-sm">
                {col.links.map(([label, href]) => (
                  <li key={label}>
                    <a href={href} className="inline-flex items-center gap-1 text-muted hover:text-fg">
                      {label}
                      {href.startsWith("http") && <ArrowUpRight size={12} aria-hidden />}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-line">
          <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-6 text-xs text-muted sm:flex-row sm:justify-between">
            <span>© {new Date().getFullYear()} Boundless Stock</span>
            <span>Figures measured on local multi-chain deployments.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
