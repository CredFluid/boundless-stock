import Link from "next/link";
import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header";

export const metadata = { title: "Developer docs" };

/* ------------------------------------------------------------------------------------ layout */

const NAV: { group: string; items: [id: string, label: string][] }[] = [
  { group: "Get started", items: [["introduction", "Introduction"], ["quickstart", "Quickstart"], ["how-it-works", "How it works"]] },
  {
    group: "Concepts",
    items: [
      ["home-and-mirrors", "Home chain and mirrors"],
      ["reference-market", "The reference market"],
      ["supply", "Supply and reconciliation"],
      ["reserves", "Proof of reserves"],
      ["partners", "Partners and fees"],
      ["lifecycle", "Order lifecycle"],
      ["recovery", "Recovery"],
    ],
  },
  { group: "CLI", items: [["cli", "Overview"], ["cli-chains", "chains"], ["cli-deploy", "deploy"], ["cli-market", "market"], ["cli-buy", "buy"]] },
  { group: "Configuration", items: [["config", "Deployment config"], ["config-token", "token and reserves"], ["config-chains", "Chains"], ["config-pool", "pool"], ["config-partners", "partners"]] },
  {
    group: "Partner SDK",
    items: [["sdk", "Install"], ["sdk-client", "Client"], ["sdk-evm", "Orders on EVM chains"], ["sdk-solana", "Orders on SVM chains"], ["sdk-track", "Tracking orders"]],
  },
  { group: "REST API", items: [["api", "Authentication"], ["api-endpoints", "Endpoints"], ["api-quote", "Quotes"], ["api-errors", "Errors"]] },
  { group: "Webhooks", items: [["webhooks", "Events"], ["webhooks-verify", "Verifying signatures"]] },
  { group: "Reference", items: [["tokens", "Supported tokens"], ["limits", "Limits"]] },
];

function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="scroll-mt-24 border-t border-line pt-10 text-2xl font-semibold tracking-tight first:border-0 first:pt-0">
      <a href={`#${id}`} className="hover:text-accent">{children}</a>
    </h2>
  );
}

function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="scroll-mt-24 pt-4 text-lg font-semibold">
      <a href={`#${id}`} className="hover:text-accent">{children}</a>
    </h3>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="leading-7 text-muted [&_code]:text-fg">{children}</p>;
}

function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {title && <div className="border-b border-line bg-surface-2 px-4 py-2 font-mono text-xs text-muted">{title}</div>}
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6">{children.trim()}</pre>
    </div>
  );
}

function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px]">{children}</code>;
}

function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm leading-6 ${tone === "warn" ? "border-warn/40 bg-warn-soft" : "border-accent/30 bg-accent-soft"}`}>
      {children}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
          <tr>{head.map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => <td key={j} className="px-4 py-2.5 leading-6 [&_code]:whitespace-nowrap">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Method({ m }: { m: "GET" | "POST" }) {
  return <span className={`mr-2 rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${m === "GET" ? "bg-ok-soft text-ok" : "bg-evm-soft text-evm"}`}>{m}</span>;
}

/* ------------------------------------------------------------------------------------ page */

export default function Docs() {
  return (
    <>
      <SiteHeader />
      <div className="mx-auto grid max-w-7xl gap-10 px-4 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_200px]">
        {/* left navigation */}
        <aside className="hidden lg:block">
          <nav className="sticky top-14 max-h-[calc(100dvh-3.5rem)] space-y-6 overflow-y-auto py-10 text-sm">
            {NAV.map((g) => (
              <div key={g.group}>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg">{g.group}</div>
                <ul className="space-y-1 border-l border-line">
                  {g.items.map(([id, label]) => (
                    <li key={id}>
                      <a href={`#${id}`} className="-ml-px block border-l border-transparent py-0.5 pl-3 text-muted hover:border-accent hover:text-fg">{label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* content */}
        <main className="min-w-0 space-y-6 py-10 pb-32">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-accent">Developer docs</div>
            <h1 id="introduction" className="mt-2 scroll-mt-24 text-4xl font-semibold tracking-tight">Boundless Stock</h1>
            <p className="mt-4 max-w-2xl text-lg leading-8 text-muted">
              Issue a tokenized stock or RWA once, on Solana, distribute it to any EVM or SVM chain, and keep one reconciled
              ledger of where every unit sits. These docs cover the CLI an issuer deploys with, the config it reads, and the SDK
              and REST API a distribution partner integrates.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["#quickstart", "Quickstart", "Deploy an asset and trade it across chains locally."],
              ["#sdk", "Partner SDK", "Quote, approve and track orders from any chain."],
              ["#api-endpoints", "REST API", "Every endpoint, parameter and error."],
            ].map(([href, t, d]) => (
              <a key={href} href={href} className="rounded-lg border border-line bg-surface p-4 hover:border-accent/60">
                <div className="font-medium">{t}</div>
                <div className="mt-1 text-sm text-muted">{d}</div>
              </a>
            ))}
          </div>

          {/* ------------------------------------------------------------ quickstart */}
          <H2 id="quickstart">Quickstart</H2>
          <P>Run the whole system on your machine: local Solana validators, three EVM chains, a second SVM chain, and the real LayerZero V2 programs and contracts, with a local relayer standing in for LayerZero&apos;s network.</P>
          <H3 id="prerequisites">Prerequisites</H3>
          <Table
            head={["Tool", "Version", "Used for"]}
            rows={[
              ["Node.js", "22+", "The CLI, deployment pipeline and web app"],
              ["Foundry", "1.x", <><C>forge</C> builds the EVM contracts; <C>anvil</C> runs the local EVM chains</>],
              ["Rust", "stable, via rustup", "Building the Solana programs"],
              ["Solana CLI (Agave)", "3.0.14", <><C>cargo build-sbf</C> and <C>solana-test-validator</C></>],
            ]}
          />
          <H3 id="install">Install and build</H3>
          <Code title="terminal">{`
git clone https://github.com/CredFluid/boundless-stock && cd boundless-stock
npm install && forge build

# One-time Solana builds
npm run solana:lz-build        # LayerZero endpoint and message library
npm run solana:build           # swap_request: orders on SVM distribution chains
npm run solana:build:oft       # LayerZero OFT: the omnichain token program
npm run solana:build:orca      # the market program
npm run solana:build:relay     # swap_relay: fills orders on the Solana market
`}</Code>
          <H3 id="first-deployment">Deploy and trade</H3>
          <Code title="terminal">{`
npx boundless-stock chains                                   # what you can distribute to
npx boundless-stock deploy --mirrors base,arbitrum,svm-chain # issue on Solana, mirror, open the market
npx boundless-stock market                                   # price, supply by chain, proof of reserves
npx boundless-stock buy --on base --spend 15000              # a buy on Base, filled on Solana
npx boundless-stock market                                   # supply moved; total and backing did not
`}</Code>
          <P>Then open the issuer console, which reads the same chains live:</P>
          <Code title="terminal">{`npm run web:build && npm run web:start    # http://localhost:3000/app`}</Code>
          <Note>
            <C>deploy</C> starts from fresh local chains every time, and takes about two minutes. It rewrites the tracked records in <C>deployments/</C>; restore them with <C>git checkout deployments/</C> rather than committing them.
          </Note>

          <H3 id="how-it-works">How it works</H3>
          <Code>{`
 Distribution chains (EVM, SVM)                              Solana (home)
 ┌────────────────────────────────┐   order + funds     ┌───────────────────────────────┐
 │ a partner's user places an     │ ──────────────────► │ swap_relay fills the order on │
 │ order through SwapRequest /    │                     │ the reference market          │
 │ swap_request                   │ ◄────────────────── │                               │
 │ the stock or proceeds arrive   │   stock + outcome   └───────────────────────────────┘
 └────────────────────────────────┘
`}</Code>
          <P>An order carries its funds with it as an omnichain transfer. On Solana it fills against the market at or above the user&apos;s floor, or the funds are returned in full. The result travels back as a second transfer and lands on the chain the order came from, in the same wallet. Moving between chains burns on one side and mints on the other, so supply is never created.</P>

          {/* ------------------------------------------------------------ concepts */}
          <H2 id="home-and-mirrors">Home chain and mirrors</H2>
          <P>The asset is issued once, on its <strong className="text-fg">home chain</strong>, Solana. Every other chain it is distributed to holds a <strong className="text-fg">mirror</strong>: a native token on that chain, an ERC-20 on EVM or an SPL mint on SVM. A mirror is never a separate issue. It is minted only when stock arrives from another chain and burned when it leaves, so every mirror token is one of the original backed tokens.</P>
          <P>An issuer with an existing SPL mint can adapt it instead of launching a new one: the mint is locked behind an adapter on Solana, holders keep their balances, and the issuer keeps the mint authority.</P>

          <H2 id="reference-market">The reference market</H2>
          <P>The asset&apos;s deepest liquidity sits in one market on Solana. Orders placed through Boundless Stock fill there, which is why a distribution chain needs no pool of its own to be tradable. A delivered mirror is still an ordinary token on its chain: holders transfer it, and local pools can list it without touching Solana. If a local price drifts from the reference market, buying on one and selling on the other pulls it back.</P>

          <H2 id="supply">Supply and reconciliation</H2>
          <P>Supply is measured on every chain from chain state, with transfers in transit counted from the omnichain token&apos;s flow counters on EVM and SVM alike. The invariant, checked continuously:</P>
          <Code>{`supply on every chain + in transit = what was issued`}</Code>
          <P>Amounts are compared in the finest precision of any chain, so a 9-decimal SPL mint and an 18-decimal ERC-20 reconcile exactly.</P>

          <H2 id="reserves">Proof of reserves</H2>
          <P>A tokenized stock&apos;s supply is fixed by the shares that back it. Set the shares held and who reports them in the config&apos;s <C>token.reserves</C>, and the CLI and console check the supply measured on every chain against them:</P>
          <Code>{`backed = shares held × tokens per share      fully backed when backed ≥ issued on every chain`}</Code>

          <H2 id="partners">Partners and fees</H2>
          <P>Distribution partners (brokers, wallets, exchanges) route orders for their own verified users. Each is registered on every distribution chain with a signer and a fee ceiling.</P>
          <Table
            head={["Setting", "Effect"]}
            rows={[
              [<C key="a">partners.required</C>, "When on, only partner-approved orders reach the market. On EVM the partner signs an EIP-712 authorization; on SVM it co-signs the transaction."],
              [<C key="b">maxFeeBps</C>, "The most a partner may charge on one order, at most 300 bps."],
              [<C key="c">platformFee</C>, "An optional platform fee on every partner order, at most 100 bps."],
            ]}
          />
          <Note>Fees are held in escrow and paid out only when an order fills. A refunded, cancelled or stranded order returns them to the user in full.</Note>

          <H2 id="lifecycle">Order lifecycle</H2>
          <Table
            head={["Status", "Meaning", "User's funds"]}
            rows={[
              [<C key="p">pending</C>, "Sent from the distribution chain, not yet settled. Normally about a second.", "In transit"],
              [<C key="f">filled</C>, "Filled on the reference market at or above the floor.", "Output delivered on the origin chain"],
              [<C key="r">refunded</C>, "The market could not meet the floor.", "Input returned in full"],
              [<C key="s">stranded</C>, "Filled or refused, but the return could not be delivered.", "Held on Solana; any caller can retry the return"],
              [<C key="c">cancelled</C>, "The order never arrived on Solana and was cancelled there.", "Input restored on the origin chain"],
            ]}
          />

          <H2 id="recovery">Recovery</H2>
          <Table
            head={["Action", "Who", "What it does"]}
            rows={[
              ["Retry a return", "Anyone", "Sends a held result back to the recorded user. A caller pays only the fee and cannot redirect funds."],
              ["Cancel a stuck transfer", "Market operator", "Proves on Solana that the transfer can never execute, then restores the user's input on the origin chain."],
              ["Hold an undeliverable order", "Market operator", "Closes the order on Solana, holds its funds, and notifies the origin chain."],
            ]}
          />

          {/* ------------------------------------------------------------ CLI */}
          <H2 id="cli">CLI</H2>
          <P><C>boundless-stock</C> is installed with the repo (<C>npm install</C> links it). Every command takes <C>--config &lt;file&gt;</C>; <C>market</C> and <C>buy</C> default to the last deployment, so they need no flags after <C>deploy</C>. Full logs go to <C>.boundless/logs/</C>.</P>

          <H3 id="cli-chains">boundless-stock chains</H3>
          <P>Lists the home chain and every chain the asset can be mirrored to, by short name.</P>

          <H3 id="cli-deploy">boundless-stock deploy</H3>
          <P>Starts fresh local chains, deploys the Solana programs, issues the asset on Solana, creates a mirror on each chosen chain, opens the market, registers partners, and verifies every cross-chain connection.</P>
          <Table
            head={["Flag", "Default", "Description"]}
            rows={[
              [<C key="m">--mirrors</C>, "every chain in the config", <>Comma-separated short names, for example <C>base,arbitrum,svm-chain</C>.</>],
              [<C key="c">--config</C>, <C key="d">config/localnet-solana-home-svm-mirror.json</C>, "The deployment config to start from."],
            ]}
          />

          <H3 id="cli-market">boundless-stock market</H3>
          <P>Prints the price from the reference market, market depth, supply on Solana and on every other chain with the reconciliation check, and proof of reserves.</P>
          <Code title="output (abridged)">{`
PRICE     150.71 USDC per tAAPL    from the home market on Solana
SUPPLY    1,000,000 tAAPL across 5 chains
  Solana     home     999,900.67   99.99%
  Base       mirror        99.32   <0.01%
  ✓ conserved: every chain plus in flight equals the 1,000,000 issued
PROOF OF RESERVES
  shares held 1,000,000 · tokens issued 1,000,000 · ✓ fully backed
`}</Code>

          <H3 id="cli-buy">boundless-stock buy</H3>
          <P>Places a buy on an EVM distribution chain from a demo wallet, waits for it to fill on Solana, and reports what was delivered.</P>
          <Table
            head={["Flag", "Default", "Description"]}
            rows={[
              [<C key="o">--on</C>, "the first EVM chain", "The chain to buy on."],
              [<C key="s">--spend</C>, <C key="d">15000</C>, "USDC to spend, in whole units."],
            ]}
          />

          {/* ------------------------------------------------------------ config */}
          <H2 id="config">Deployment config</H2>
          <P>One JSON file describes a deployment. The CLI&apos;s <C>--mirrors</C> flag narrows its chain list without editing it, and the issuer console&apos;s launch wizard writes one for you.</P>
          <Code title="config/my-asset.json (abridged)">{`
{
  "name": "boundless-taapl",
  "token": {
    "name": "Tokenized Apple Inc.", "symbol": "tAAPL", "decimals": 18, "initialSupply": "1000000",
    "reserves": { "shares": "1000000", "source": "custodian attestation", "asOf": "2026-09-25" }
  },
  "quoteAsset": { "name": "USD Coin", "symbol": "USDC", "decimals": 6, "initialSupply": "50000000" },
  "homeChain": { "key": "solana-devnet", "name": "Solana", "vm": "svm", "eid": 40168, "rpcUrl": "…" },
  "mirrorChains": [
    { "key": "base-sepolia", "name": "Base", "chainId": 84532, "eid": 40245, "rpcUrl": "…" },
    { "key": "svm-b", "name": "SVM chain", "vm": "svm", "eid": 40999, "rpcUrl": "…" }
  ],
  "pool": { "feeTier": 3000, "initialPrice": "150", "baseLiquidity": "100000", "quoteLiquidity": "15000000" },
  "partners": {
    "required": true,
    "partners": [{ "id": 1, "name": "Acme Broker", "maxFeeBps": 50, "evm": { "signer": "0x…", "feeRecipient": "0x…" } }]
  }
}
`}</Code>

          <H3 id="config-token">token and reserves</H3>
          <Table
            head={["Field", "Type", "Description"]}
            rows={[
              [<C key="1">name</C>, "string", "The asset's full name."],
              [<C key="2">symbol</C>, "string", "Its ticker."],
              [<C key="3">decimals</C>, "number", "At least 6: amounts cross chains in 6 shared decimals."],
              [<C key="4">initialSupply</C>, "string", "Whole units, issued once on the home chain. Ignored when adapting."],
              [<C key="5">existingToken</C>, "string?", "An existing mint to adapt instead of launching a new one."],
              [<C key="6">reserves.shares</C>, "string", "Shares held for the asset."],
              [<C key="7">reserves.tokensPerShare</C>, "number?", "Tokens per share. Default 1."],
              [<C key="8">reserves.source</C>, "string", "Who reports the figure: a custodian, transfer agent or oracle."],
              [<C key="9">reserves.asOf</C>, "string?", "When it was reported (ISO date)."],
            ]}
          />

          <H3 id="config-chains">Chains</H3>
          <Table
            head={["Field", "Type", "Description"]}
            rows={[
              [<C key="1">key</C>, "string", "A stable identifier."],
              [<C key="2">name</C>, "string", "Shown in the CLI and console."],
              [<C key="3">vm</C>, <><C>&quot;evm&quot;</C> | <C>&quot;svm&quot;</C></>, "Default evm. The home chain is svm."],
              [<C key="4">eid</C>, "number", "The chain's LayerZero endpoint id."],
              [<C key="5">chainId</C>, "number", "EVM chains only."],
              [<C key="6">rpcUrl</C>, "string", "May reference environment variables."],
              [<C key="7">svm.tokenProgram</C>, <><C>&quot;spl-token&quot;</C> | <C>&quot;token-2022&quot;</C></>, "SVM chains: which token program new mints use."],
            ]}
          />

          <H3 id="config-pool">pool</H3>
          <Table
            head={["Field", "Type", "Description"]}
            rows={[
              [<C key="1">initialPrice</C>, "string", "USDC per unit of the asset at open."],
              [<C key="2">feeTier</C>, "number", "Trading fee in hundredths of a basis point: 3000 = 0.30%."],
              [<C key="3">baseLiquidity</C>, "string", "Asset seeded into the market, whole units."],
              [<C key="4">quoteLiquidity</C>, "string", "USDC seeded into the market, whole units."],
            ]}
          />

          <H3 id="config-partners">partners</H3>
          <Table
            head={["Field", "Type", "Description"]}
            rows={[
              [<C key="1">required</C>, "boolean", "Accept partner-approved orders only. Default false."],
              [<C key="2">platformFee</C>, "{ bps, recipient }", "Optional; at most 100 bps."],
              [<C key="3">partners[].id</C>, "number", "Non-zero, unique; names the partner on chain."],
              [<C key="4">partners[].maxFeeBps</C>, "number", "Fee ceiling per order, at most 300."],
              [<C key="5">partners[].evm</C>, "{ signer, feeRecipient }", "The key that signs authorizations on EVM chains, and where fees go."],
              [<C key="6">partners[].svm</C>, "{ signer, feeRecipient }", "The key that co-signs on SVM chains, and the fee wallet."],
              [<C key="7">partners[].webhook</C>, "{ url, secretEnv }", "Where order events are delivered; the secret is read from the named variable."],
            ]}
          />

          {/* ------------------------------------------------------------ SDK */}
          <H2 id="sdk">Partner SDK</H2>
          <P><C>@boundless-stock/sdk</C> is a TypeScript client for the REST API plus the helpers a partner&apos;s backend uses to approve orders. It never holds user funds: the API builds transactions, and the user&apos;s own wallet signs and sends them.</P>
          <Code title="terminal">{`npm install @boundless-stock/sdk viem @solana/web3.js`}</Code>

          <H3 id="sdk-client">Client</H3>
          <Code title="ts">{`
import { BoundlessStockApi } from "@boundless-stock/sdk";

const api = new BoundlessStockApi({ baseUrl: "https://api.example.com", apiKey: process.env.BOUNDLESS_API_KEY });

const { deployments } = await api.deployments();
const asset = await api.deployment("boundless-taapl");   // contracts, tokens, decimals, EIP-712 domain per chain

const q = await api.quote({
  deployment: "boundless-taapl", chain: "arbitrum", side: "buy",
  amountIn: "15000000000",           // 15,000 USDC in base units on that chain
  partnerId: 1, partnerFeeBps: 25, slippageBps: 50,
});
// q.expectedAmountOut, q.minAmountOut, q.fees, q.priceImpactBps, q.messagingFee
`}</Code>

          <H3 id="sdk-evm">Orders on EVM chains</H3>
          <P>The partner&apos;s backend signs an EIP-712 authorization over exactly the order, after its own checks (KYC, limits). The API refuses an authorization that doesn&apos;t match before the user pays any gas.</P>
          <Code title="ts">{`
import { authorizeEvmOrder, orderIdFromLogs } from "@boundless-stock/sdk";

const mirror = asset.mirrors.find((m) => m.key === "arbitrum")!;
const authorization = await authorizeEvmOrder(partnerAccount, mirror, {
  user, side: "buy", amountIn: q.amountIn, minAmountOut: q.minAmountOut, partnerId: 1, feeBps: 25,
});

const built = await api.buildOrder({
  deployment: "boundless-taapl", chain: "arbitrum", side: "buy", user,
  amountIn: q.amountIn, minAmountOut: q.minAmountOut, partnerId: 1, partnerFeeBps: 25, authorization,
});
// The user's wallet sends built.transactions in order (an approval, then the order).
const id = orderIdFromLogs(receipt.logs, mirror.swapRequest);
`}</Code>

          <H3 id="sdk-solana">Orders on SVM chains</H3>
          <P>The API returns an unsigned v0 transaction. The partner decodes it and co-signs only if it is exactly the approved order; the user then signs and sends it.</P>
          <Code title="ts">{`
import { authorizeSolanaOrder } from "@boundless-stock/sdk";

const svm = asset.mirrors.find((m) => m.key === "svm-b")!;
const built = await api.buildOrder({
  deployment: "boundless-taapl", chain: "svm-b", side: "buy", user: userPubkey,
  amountIn: q.amountIn, minAmountOut: q.minAmountOut, partnerId: 1, partnerFeeBps: 25,
});
const cosigned = authorizeSolanaOrder(built.transaction, partnerKeypair, {
  program: svm.program, user: userPubkey, side: "buy",
  amountIn: q.amountIn, minAmountOut: q.minAmountOut, feeBps: 25,
});
// built.requestId is the order id.
`}</Code>
          <Note tone="warn">Never co-sign a partner transaction any other way. The co-signature is what lets an order in; <C>authorizeSolanaOrder</C> refuses anything but one order for the stated user, side, amount, fee and floor.</Note>

          <H3 id="sdk-track">Tracking orders</H3>
          <Code title="ts">{`
const order = await api.waitForOrder("boundless-taapl", "arbitrum", id);
order.status;     // "filled" | "refunded" | "stranded" | "cancelled"
order.amountOut;  // delivered on a fill
order.next;       // what happens next, in words you can show the user

const { orders } = await api.orders("boundless-taapl", { user });   // across every chain
`}</Code>

          {/* ------------------------------------------------------------ API */}
          <H2 id="api">REST API</H2>
          <P>The API quotes and builds transactions; it holds no keys. Send your key in the <C>x-api-key</C> header. Keys are rate-limited to 60 requests a minute by default.</P>
          <Code title="terminal">{`curl -H "x-api-key: $KEY" https://api.example.com/api/v1/deployments/boundless-taapl`}</Code>
          <Note>Every amount is a string of integer base units, in the token&apos;s decimals on the chain named.</Note>

          <H3 id="api-endpoints">Endpoints</H3>
          <Table
            head={["Endpoint", "Description"]}
            rows={[
              [<span key="1"><Method m="GET" /><C>/api/v1/deployments</C></span>, "Lists deployments."],
              [<span key="2"><Method m="GET" /><C>/api/v1/deployments/:name</C></span>, "Each distribution chain's contracts, tokens and decimals, the EIP-712 domain, whether partners are required, and the platform fee."],
              [<span key="3"><Method m="POST" /><C>/api/v1/quote</C></span>, "An exact quote for an order, as it will execute."],
              [<span key="4"><Method m="POST" /><C>/api/v1/orders</C></span>, <>Builds an order. EVM: <C>{"{ transactions }"}</C> with the messaging fee as <C>value</C>. SVM: <C>{"{ transaction, requestId }"}</C>, an unsigned v0 transaction in base64.</>],
              [<span key="5"><Method m="GET" /><C>/api/v1/orders/:deployment/:chain/:id</C></span>, "One order: status, amounts, fees, what Solana holds if stranded, and next."],
              [<span key="6"><Method m="GET" /><C>/api/v1/orders?deployment=&amp;user=</C></span>, "A user's orders across every distribution chain."],
            ]}
          />

          <H3 id="api-quote">Quotes</H3>
          <P>Quotes are exact: the reference market prices the order itself, then the quote follows it through fees and the bridge&apos;s precision in both directions. Fills match their quote to the base unit.</P>
          <Table
            head={["Field", "Description"]}
            rows={[
              [<C key="1">fees.partner</C>, "Partner fee, held in escrow until the order fills."],
              [<C key="2">fees.platform</C>, "Platform fee, likewise."],
              [<C key="3">traded</C>, "What crosses to Solana after fees, rounded to the bridge's precision."],
              [<C key="4">dust</C>, "The part below that precision, returned at submission."],
              [<C key="5">expectedAmountOut</C>, "What the market would deliver right now, as it arrives on the chain."],
              [<C key="6">minAmountOut</C>, <>The floor to pass to the order: expected less <C>slippageBps</C>.</>],
              [<C key="7">priceImpactBps</C>, "Execution price against spot, including the trading fee."],
              [<C key="8">messagingFee</C>, "The native fee for the cross-chain round trip."],
            ]}
          />

          <H3 id="api-errors">Errors</H3>
          <P>Every error has the shape <C>{'{ "error": { "code", "message" } }'}</C>.</P>
          <Table
            head={["Status", "Codes"]}
            rows={[
              ["400", <span key="1" className="font-mono text-xs leading-6">invalid_json · missing_parameter · invalid_deployment · invalid_side · invalid_amount · amount_too_small · invalid_user · invalid_id · invalid_bps · fee_too_high · unknown_partner · partner_required · authorization_required · invalid_authorization · authorization_expired · nonce_used</span>],
              ["401", <span key="2" className="font-mono text-xs">missing_api_key · invalid_api_key</span>],
              ["404", <span key="3" className="font-mono text-xs">unknown_deployment · unknown_chain · unknown_order</span>],
              ["429", <span key="4" className="font-mono text-xs">rate_limited</span>],
              ["503", <span key="5" className="font-mono text-xs">no_market · api_keys_not_configured</span>],
            ]}
          />

          {/* ------------------------------------------------------------ webhooks */}
          <H2 id="webhooks">Webhooks</H2>
          <P>Add a <C>webhook</C> to a partner&apos;s config entry and run the worker beside the API. Each event carries the full order, as tracking returns it. Delivery is at least once, retried with backoff up to 8 times; deduplicate by the event <C>id</C>.</P>
          <Table
            head={["Event", "When"]}
            rows={[
              [<C key="1">order.filled</C>, "The order filled and its output was delivered."],
              [<C key="2">order.refunded</C>, "The market could not meet the floor; the input was returned."],
              [<C key="3">order.stranded</C>, "The return could not be delivered; the funds are held on Solana."],
              [<C key="4">order.recovered</C>, "A stranded order's return was retried and delivered."],
              [<C key="5">order.cancelled</C>, "The order never arrived and was cancelled; the input was restored."],
            ]}
          />
          <H3 id="webhooks-verify">Verifying signatures</H3>
          <P>Each delivery is signed with HMAC-SHA256 in the <C>x-crossstock-signature</C> header, as <C>t=&lt;unix&gt;,v1=&lt;signature&gt;</C>. <C>verifyWebhook</C> checks it and refuses replays older than five minutes.</P>
          <Code title="ts">{`
import { verifyWebhook } from "@boundless-stock/sdk";

app.post("/hooks/boundless", express.raw({ type: "application/json" }), (req, res) => {
  const event = verifyWebhook(req.body.toString(), req.header("x-crossstock-signature"), process.env.WEBHOOK_SECRET!);
  // event.type, event.id, event.order
  res.sendStatus(200);
});
`}</Code>

          {/* ------------------------------------------------------------ reference */}
          <H2 id="tokens">Supported tokens</H2>
          <Table
            head={["Token", "Supported"]}
            rows={[
              ["SPL Token mints", "Yes"],
              ["Token-2022 mints, including metadata extensions", "Yes"],
              ["Token-2022 with a transfer fee, permanent delegate, transfer hook, non-transferable, default account state or confidential transfer fee", "Refused at initialisation"],
              ["ERC-20 on EVM distribution chains", "Yes, as mirrors"],
            ]}
          />

          <H2 id="limits">Limits</H2>
          <Table
            head={["Limit", "Value"]}
            rows={[
              ["Partner fee ceiling", "300 bps"],
              ["Platform fee", "100 bps"],
              ["Cross-chain precision", "6 shared decimals"],
              ["API rate limit", "60 requests a minute per key (configurable)"],
              ["Webhook replay window", "5 minutes"],
              ["Order flagged for attention", "Pending over 10 minutes"],
            ]}
          />

          <div className="border-t border-line pt-8 text-sm text-muted">
            Something missing? The source is on{" "}
            <a href="https://github.com/CredFluid/boundless-stock" className="text-accent hover:underline">GitHub</a>, or go to the{" "}
            <Link href="/app" className="text-accent hover:underline">issuer console</Link>.
          </div>
        </main>

        {/* right: on this page */}
        <aside className="hidden xl:block">
          <div className="sticky top-14 py-10 text-sm">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg">On this page</div>
            <ul className="space-y-1.5">
              {NAV.map((g) => (
                <li key={g.group}>
                  <a href={`#${g.items[0][0]}`} className="text-muted hover:text-fg">{g.group}</a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </>
  );
}
