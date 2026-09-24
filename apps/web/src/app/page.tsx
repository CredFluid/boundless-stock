import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Coins,
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

/* Every figure here is measured by the validation suite or read from the repo — none is a
   projection. See REPORT.md. */
const METRICS = [
  { value: "0.3944%", label: "All-in cost of a cross-chain buy", note: "0.30% pool fee + 0.0944% impact, nothing else" },
  { value: "1", label: "Transaction for the user", note: "signed on the chain they already hold funds on" },
  { value: "2 VMs", label: "EVM and Solana, as home or mirror", note: "any chain can host the market" },
  { value: "170 / 170", label: "Peer links verified", note: "every LayerZero link read back from chain" },
];

const NETWORKS = ["Base", "Arbitrum", "Optimism", "Solana", "SVM chains", "Any LayerZero V2 chain"];

const LIFECYCLE = [
  { n: "01", title: "Request", body: "A user on a mirror chain calls buy. Their USDC leaves as an omnichain transfer with the order attached — one transaction, one fee." },
  { n: "02", title: "Execute", body: "On the home chain the relay prices it against the one deep pool. It fills only if the user's floor is met — otherwise the input is returned in full." },
  { n: "03", title: "Settle", body: "The stock travels back with a settlement record and lands in the user's wallet on the chain they started from." },
  { n: "04", title: "Account", body: "Every unit is counted on every chain, in flight included, so supply is provably conserved at every moment." },
];

const GUARANTEES = [
  { icon: Undo2, title: "Refund, never a bad fill", body: "An order fills at or above the user's floor, or returns in full. On Solana the relay quotes before it swaps, because a failed swap can't be caught there." },
  { icon: RotateCcw, title: "Stranded is recoverable", body: "If a return can't be sent, the funds are held on the home chain and the mirror is told. Anyone can retry the return later — no one can redirect it." },
  { icon: XCircle, title: "Stuck messages, cancelled safely", body: "A message that never arrives is killed on the home chain first — provably undeliverable — and only then restored on the mirror. Never the reverse." },
  { icon: Scale, title: "Supply conserved, in flight included", body: "Σ supply + in flight = what exists, from chain state alone, across every chain of every VM. Checked mid-transfer, not just at rest." },
  { icon: CheckCircle2, title: "Verified wiring", body: "Every peer link the pipeline writes is read back from chain and compared. A deployment with a mismatched link reports it and refuses to call itself complete." },
  { icon: KeyRound, title: "Issuers keep control", body: "Bring an existing token and it is adapted, not replaced: holders keep balances, the address never changes, and on Solana the issuer keeps the mint authority." },
];

const AUDIENCES = [
  { icon: Building2, title: "Issuers", body: "Launch a tokenized stock on one home chain and make it tradable everywhere — or adapt the token you already issued. One config, one command.", cta: { href: "/app/launch", label: "Launch an asset" } },
  { icon: Layers, title: "Platforms", body: "Wallets, brokers and exchanges offer the asset on the chains their users are on, without sourcing liquidity on each one.", cta: { href: "#developers", label: "See the integration" } },
  { icon: Wallet, title: "Traders", body: "Buy and sell from wherever your funds are. The price is the home market's, and your floor is enforced where the trade executes.", cta: { href: "/trade", label: "Open the trading app" } },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent">{children}</div>;
}

function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5">
        <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-contrast">C</span>
          CrossStock
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-muted md:flex">
          <a href="#architecture" className="hover:text-fg">Architecture</a>
          <a href="#developers" className="hover:text-fg">Developers</a>
          <a href="#security" className="hover:text-fg">Security</a>
          <Link href="/trade" className="hover:text-fg">Trade</Link>
          <a href={REPO} className="hover:text-fg">GitHub</a>
        </nav>
        <Link href="/app" className="rounded-lg bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-90">
          Open dashboard
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
            <a href="#architecture" className="enter enter-1 inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 py-1 pr-3 pl-1 text-xs text-muted hover:text-fg">
              <span className="rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent">New</span>
              Solana can now be the home chain
              <ArrowRight size={12} aria-hidden />
            </a>
            <h1 className="enter enter-2 mt-7 text-5xl font-semibold leading-[1.02] tracking-tight md:text-7xl">
              The settlement layer for{" "}
              <span className="text-shimmer bg-gradient-to-r from-accent via-evm to-accent bg-clip-text text-transparent">omnichain stocks</span>.
            </h1>
            <p className="enter enter-3 mt-6 max-w-xl text-lg leading-relaxed text-muted">
              One deep market on a home chain. Mirrors everywhere else. Users trade a tokenized stock from whichever chain
              they&apos;re on — priced at home, settled back to them, with no liquidity needed where they stand.
            </p>
            <div className="enter enter-4 mt-9 flex flex-wrap gap-3">
              <Link href="/app/launch" className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-accent-contrast hover:opacity-90">
                Launch an asset <ArrowRight size={16} aria-hidden />
              </Link>
              <a href="#developers" className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-5 py-3 text-sm font-medium hover:bg-surface-2">
                <Terminal size={16} aria-hidden /> Start building
              </a>
            </div>
            <div className="enter enter-5 mt-10 flex flex-wrap gap-x-6 gap-y-2 font-mono text-xs text-muted">
              <span>▸ LayerZero V2 messaging</span>
              <span>▸ EVM + Solana</span>
              <span>▸ Open source</span>
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
          <div className="shrink-0 font-mono text-xs uppercase tracking-[0.2em] text-muted">Validated across</div>
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

      {/* ================================================================ problem */}
      <section className="mx-auto max-w-7xl px-5 py-24">
        <Reveal>
          <Eyebrow>The problem</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">
            Liquidity shouldn&apos;t have to follow the token.
          </h2>
        </Reveal>
        <div className="mt-12 grid gap-4 lg:grid-cols-2">
          <Reveal delay={100}><div className="h-full rounded-2xl border border-line bg-surface p-8">
            <div className="text-sm font-medium text-bad">Today</div>
            <ul className="mt-5 space-y-4 text-muted">
              <li className="flex gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />A pool on every chain, each thin, each needing its own market maker.</li>
              <li className="flex gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />Users bridge first, then trade — two products, two fees, two ways to lose funds.</li>
              <li className="flex gap-3"><XCircle size={18} className="mt-0.5 shrink-0 text-bad" aria-hidden />Wrapped copies and prices that drift from chain to chain.</li>
            </ul>
          </div></Reveal>
          <Reveal delay={250}><div className="h-full rounded-2xl border border-accent/40 bg-gradient-to-b from-accent-soft to-surface p-8">
            <div className="text-sm font-medium text-accent">With CrossStock</div>
            <ul className="mt-5 space-y-4">
              <li className="flex gap-3"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />One market, on the home chain. Every other chain is a mirror with no market of its own.</li>
              <li className="flex gap-3"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />One transaction for the user; the order, the funds and the result travel together.</li>
              <li className="flex gap-3"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden />One asset, not wrapped copies — its supply provably conserved across chains.</li>
            </ul>
          </div></Reveal>
        </div>
      </section>

      {/* ================================================================ architecture */}
      <section id="architecture" className="scroll-mt-20 border-y border-line bg-surface/40">
        <div className="mx-auto max-w-7xl px-5 py-24">
          <Reveal>
            <Eyebrow>Architecture</Eyebrow>
            <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">Four layers. One market.</h2>
            <p className="mt-5 max-w-2xl text-lg text-muted">
              CrossStock sits between the applications users touch and the messaging layer that moves value — so the chain a
              user is on stops mattering.
            </p>
          </Reveal>

          <div className="mt-14 grid gap-10 lg:grid-cols-[1.1fr_1fr]">
            {/* stack */}
            <div className="space-y-3">
              {[
                { tag: "Applications", title: "Wallets · brokers · exchanges · the CrossStock app", tone: "border-line", items: ["Buy / sell from any chain", "Issuer console"] },
                { tag: "CrossStock", title: "Omnichain asset + request/relay protocol", tone: "border-accent/60 bg-accent-soft/40", items: ["SwapRequest on every mirror", "Relay at the home market", "OFT supply accounting"] },
                { tag: "LayerZero V2", title: "Verified messaging between chains", tone: "border-line", items: ["DVN verification", "Executor delivery", "Compose messages"] },
                { tag: "Chains", title: "EVM and SVM networks", tone: "border-line", items: ["Uniswap V3 on EVM homes", "Orca Whirlpool on Solana homes"] },
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
            <h2 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">From config to live market in one command.</h2>
            <p className="mt-5 text-lg text-muted">
              Describe the asset, its home chain and its mirrors in one file. The pipeline deploys, wires and verifies every
              chain — then proves it works.
            </p>
            <ul className="mt-8 space-y-4 text-sm">
              {[
                ["Config-driven", "Adding a chain is one more entry and a re-run. No code changes to go from local to testnet."],
                ["Verified, not assumed", "Every peer link read back from chain; a manifest records exactly what was deployed."],
                ["Validation suite", "Nine end-to-end scenarios — buys, refunds, sells, strands, cancellations, Solana to Solana."],
                ["Supply report", "Where every unit lives, across every chain and VM, in-flight included."],
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
  `}<K>&quot;token&quot;</K>{`: { `}<K>&quot;symbol&quot;</K>{`: `}<S>&quot;tAAPL&quot;</S>{`, `}<K>&quot;initialSupply&quot;</K>{`: `}<S>&quot;1000000&quot;</S>{` },
  `}<K>&quot;homeChain&quot;</K>{`: { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;solana&quot;</S>{`, `}<K>&quot;vm&quot;</K>{`: `}<S>&quot;svm&quot;</S>{` },`}<C>{`   // any chain can be home`}</C>{`
  `}<K>&quot;mirrorChains&quot;</K>{`: [
    { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;base&quot;</S>{` }, { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;arbitrum&quot;</S>{` }, { `}<K>&quot;key&quot;</K>{`: `}<S>&quot;optimism&quot;</S>{` }
  ],
  `}<K>&quot;pool&quot;</K>{`: { `}<K>&quot;initialPrice&quot;</K>{`: `}<S>&quot;150&quot;</S>{`, `}<K>&quot;feeTier&quot;</K>{`: `}<N>3000</N>{` }
}`}
            </CodeWindow>
            <TypedTerminal
              title="terminal"
              lines={[
                { kind: "cmd", text: "npm run deploy -- --config config/my-asset.json" },
                { kind: "out", text: "deployment complete · 3 mirrors · 21/21 links verified" },
                { kind: "cmd", text: "npm run validate -- --config config/my-asset.json" },
                { kind: "out", text: "scenarios passed: buy · refund · sell · strand · cancel" },
                { kind: "cmd", text: "npm run supply -- --config config/my-asset.json" },
                { kind: "out", text: "conserved: equals the genesis supply exactly" },
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
              <Eyebrow>Guarantees</Eyebrow>
              <h2 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">Funds are never lost. Every failure has a path home.</h2>
            </Reveal>
            <Reveal delay={150}><p className="text-lg text-muted">
              Cross-chain systems fail in the gaps between chains. CrossStock names each of those gaps and gives it a recovery
              path — then tests every one end to end, on EVM and on Solana.
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
            <span className="inline-flex items-center gap-2"><Coins size={16} className="text-accent" aria-hidden /> Proof of reserves on the roadmap</span>
          </div>
        </div>
      </section>

      {/* ================================================================ audiences */}
      <section className="mx-auto max-w-7xl px-5 py-24">
        <Reveal>
          <Eyebrow>Who it&apos;s for</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight md:text-5xl">One asset, three ways in.</h2>
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
          <h2 className="text-4xl font-semibold tracking-tight md:text-6xl">Make your asset tradable on every chain.</h2>
          <p className="mx-auto mt-6 max-w-xl text-lg text-muted">
            Start from the issuer console, or read the code — it&apos;s all open.
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
              <span aria-hidden className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-contrast">C</span>
              CrossStock
            </div>
            <p className="mt-4 max-w-xs text-sm text-muted">The settlement layer for omnichain tokenized stocks. Built on LayerZero V2.</p>
          </div>
          {[
            { title: "Product", links: [["Issuer console", "/app"], ["Launch an asset", "/app/launch"], ["Operations", "/app/operations"], ["Trading app", "/trade"]] },
            { title: "Developers", links: [["GitHub", REPO], ["Architecture", `${REPO}/blob/main/agents.md`], ["Validation report", `${REPO}/blob/main/REPORT.md`], ["Engineering notes", `${REPO}/blob/main/NOTES.md`]] },
            { title: "Roadmap", links: [["Frontend plan", `${REPO}/blob/main/FRONTEND.md`], ["Proof of reserves", `${REPO}/blob/main/PROOF_OF_RESERVES.md`]] },
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
            <span>© {new Date().getFullYear()} CrossStock</span>
            <span>Figures measured by the open validation suite on local multi-chain sets.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
