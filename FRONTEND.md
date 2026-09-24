# CrossStock frontend — plan

Status: **phase 1 built** on branch `feature/frontend-monorepo`. It is a high-level UI: every
page exists and the issuer dashboard shows real deployment data, but nothing yet connects a
wallet or reads live chain state. This document is the plan for the rest.

## Who it is for

| Audience | What they need | Where |
|---|---|---|
| **Visitors** (issuers, partners, investors) | What CrossStock is, why it matters, proof that it works | `/` |
| **Issuers and operators** | Launch an asset across chains, see where it lives, operate it | `/app` (issuer console) |
| **Traders** | Buy or sell a tokenized stock from the chain they are already on | `/trade` |

## Site map

```
/                          Landing: hero, validated proof figures, how it works, issuer features
/trade                     Trading app: pick asset + your chain, buy/sell, indicative quote
/app                       Issuer console — deployments overview (KPIs + every deployment)
/app/deployments/[name]    One deployment: topology, chains & contracts, home market,
                           supply, peer-link verification, pipeline history
/app/launch                Launch wizard: asset → home chain → mirrors → market → review;
                           emits a deployment config the pipeline runs as-is
/app/operations            Pending requests, stranded returns, stuck messages;
                           the recovery actions, who may run them and where
```

Later additions, in the phases below: `/app/deployments/[name]/supply`, `/app/deployments/[name]/activity`,
`/app/settings` (team, roles, API keys), `/portfolio` (a trader's positions across chains) and
`/docs`.

## What phase 1 delivers

- **A monorepo**, using npm workspaces:
  - `apps/web`: the Next.js app, with the App Router, React 19, Tailwind 4 and TypeScript.
  - `packages/shared`: types shared by the infra and the apps.
  - The contracts, infra and Solana programs stay at the root for now (see "Monorepo layout").
- **Real data, not mocks, in the issuer console.**
  - The server reads the deployment records the pipeline writes to `deployments/`: EVM manifests
    plus the Solana `.solana.json` records, merged into one view per deployment. So the home
    chain, mirrors, contracts, pool, peer verification and pipeline steps are what was actually
    deployed.
  - The manifest and config types are imported from the infra's own definitions, through
    `@crossstock/shared`. If the pipeline changes a field, the UI fails to compile rather than
    drifting.
- **A launch wizard that produces a working config.** Its chain presets come from the repo's
  `config/*.json`, and its output is a `DeploymentConfig` for `npm run deploy -- --config`.
- **Honest placeholders.** Where live data or signing is not wired yet — live supply, the operations
  queues, wallet connection, live quotes — the page says so ("Preview") and names the phase that
  delivers it.
- **Design system.** Colours are CSS-variable tokens with a dark mode. There are no external
  fonts or scripts, and the layout is responsive (checked at 390px wide with no horizontal
  scroll). Evidence and chain types get consistent badges.

```bash
npm install
npm run web:dev        # http://localhost:3000
npm run web:build
```

## Phases

### Phase 2 — live read API and wallets

- **Read API** (`apps/api` or Next route handlers). It serves live state per deployment by reusing
  the infra rather than reimplementing it:
  - `measureSupply` for supply across chains, in-flight amounts included;
  - request status from SwapRequest (EVM) and `swap_request` (Solana);
  - pool price and depth from Uniswap V3 and Orca;
  - stranded amounts and relay balances.
- **Indexer** for anything event-shaped: a trade history per user and per deployment, and the
  operations queues (pending, stranded, stuck). This could be something off the shelf (e.g. Ponder
  or Envio on EVM; Helius webhooks or a Geyser plugin on Solana), or a small poller over the same
  RPCs the local relayer already uses.
- **Wallets.** wagmi + viem on EVM, and Solana wallet adapter on Solana, behind one "connect"
  control that shows the chain the user is on.
- **Trading app goes live.**
  - Live quotes, taken from the home pool the same way the relay quotes: Uniswap quoter; Orca's
    swap maths on Solana.
  - Messaging fee from `quoteTrade` / the OFT quote.
  - Approve and submit, then a request tracker (sent → priced at home → settled back), and a
    user-facing refund/stranded/cancelled state with what happens next.
- **Supply page.** The same figures as `npm run supply`: per chain, in flight, conserved, and when
  last checked.

### Phase 3 — issuer operations from the browser

- **Deploy service.** Run the pipeline server-side from a wizard config.
  - It needs a signer strategy: the issuer's own keys through a wallet, per-chain transactions
    signed step by step, or a managed deployer key with approvals.
  - Stream progress per module, just as the CLI logs it.
- **Recovery actions as buttons**, with role checks that mirror the chain's own:
  - retry a return: anyone;
  - cancel a stuck message: relay owner or admin;
  - strand an order on a Solana home: relay admin.
- **Accounts, teams and roles**: issuer admin, operator, viewer. There are also audit logs for
  every operator action.
- **Alerts**: supply not conserved, a link failing verification, a request stuck past N minutes,
  relay native balance low.

### Phase 4 — trust and polish

- **Proof of reserves**: reserves vs. omnichain supply, with data age and source (see
  `PROOF_OF_RESERVES.md`).
- **Public status page per asset**: chains, supply and reserves.
- **Docs site** (`apps/docs`).
- **Accessibility audit**, i18n and analytics.

## Monorepo layout

Now:

```
apps/web/            Next.js app
packages/shared/     shared types (re-exports infra/lib/types.ts)
src/ test/ lib/      Solidity contracts (Foundry)          ← root, unchanged
infra/               deploy pipeline, relayer, validation  ← root, unchanged
solana/              Solana programs                       ← root, unchanged
config/ deployments/ configs and deployment records        ← root, unchanged
```

Target:

```
apps/web  apps/api  apps/docs
packages/contracts   (src, test, lib, foundry.toml)
packages/infra       (deploy, relayer, validation, supply)
packages/solana      (programs, vendor, keys)
packages/shared
config/  deployments/   (stay at the root: they describe deployments, not code)
```

The backend was not moved in phase 1, on purpose. The infra resolves most of its paths from the
repo root: `deployments/`, `config/`, `solana/keys`, forge's `out/`, the vendored programs. Moving
it means making every path configurable, then rerunning the whole validation suite on every
topology. That is its own milestone, best done before the read API starts importing infra code.

## Decisions to make

- **Framework for the API**: Next route handlers (one deployable) or a separate service (can own
  the indexer and long-running jobs). A separate `apps/api` is the likely answer by phase 3.
- **Indexing**: hosted indexer vs. our own poller; this depends on the chain list and cost.
- **Deploy signing model**: the issuer's wallet, or a managed key. This is a security and product
  decision more than a UI one.
- **Hosting**: e.g. Vercel for `apps/web`; somewhere with long-running processes for the API and
  indexer.
- **Brand**: the current look is a neutral placeholder system. Colours and type are tokens in
  `apps/web/src/app/globals.css`, so a brand pass is contained.
