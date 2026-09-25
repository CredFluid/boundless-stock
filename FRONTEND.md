# CrossStock frontend — plan

Status:

- **Phase 1 is built and merged.** Every page exists, and the issuer dashboard shows real
  deployment data.
- **Phase 2a/2b are built** on branch `feature/live-dashboard-and-ci`:
  - the read API;
  - the live issuer dashboard;
  - trade history;
  - CI.
- **Phase 2c, partner distribution, is in progress.** The contracts, SDK and partner API are on `feature/partner-access-and-fees`. The reference trading page and the sandbox come next.

This document is the plan for the rest.

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

/api/deployments                    Every recorded deployment (the same view as /app)
/api/deployments/[name]             One deployment, as recorded
/api/deployments/[name]/live        Live: supply per chain + in flight + conserved,
                                    home market, relay health
/api/deployments/[name]/requests    Trade history (?status=filled|pending|…&limit=1..1000)
/api/operations                     Queues across every live deployment
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
- **Honest placeholders.** Where something is not wired yet, the page says so ("Preview") and
  names the phase that delivers it. Live supply and the operations queues have since arrived in
  phase 2b. Wallet connection and live quotes are still to come.
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

#### Delivered: 2a (read API and CI) and 2b (live dashboard and trade history)

- **Read API: Next route handlers that import the infra directly** (`apps/web/src/lib/live.ts`).
  - Supply is `measureSupply`, the function behind `npm run supply`.
  - The home market and relay health come from `infra/lib/market.ts`:
    - Uniswap V3 `slot0` and liquidity, or the Whirlpool account;
    - the relay's native balance and token holdings.
  - Each deployment's RPC endpoints come from the `config/*.json` that produced it
    (`infra/lib/deployment-config.ts`).
  - Reads are cached for 4 s, so any number of viewers polling one deployment cost one set of
    RPC reads per interval. Each read times out after 8 s.
  - A deployment is reported as one of:
    - `live`;
    - `no-config`: no config names it, so its RPCs are unknown;
    - `not-running`: a local deployment older than the chains now running. Anvil reuses
      addresses, so reading it would describe a different deployment.
    - `unreachable`.
- **Trade history: a small poller, not a hosted indexer** (`infra/history.ts`, which is also
  `npm run history`).
  - It reads `nextRequestId` and each request from every mirror's SwapRequest (EVM) or
    `swap_request` (Solana).
  - It re-reads only what can still change:
    - requests that are still pending;
    - stranded requests while the home relay still holds their amount.
  - The stranded amount comes from `SwapRelay.stranded` on an EVM home, and from the
    Stranded PDA on a Solana home.
  - The history is stored in `.crossstock/history/<deployment>.json`. It is git-ignored, and a
    derived cache: it can be deleted at any time.
- **Live dashboard.** Client components poll the API every 5 s, pausing while the tab is
  hidden.
  - A deployment page shows:
    - the live price against launch;
    - omnichain supply per chain with in-flight amounts and the conservation check;
    - pool depth, relay gas and holdings;
    - the trade history, filterable by status.
  - Operations shows the queues across every live deployment:
    - needs attention: pending over 10 minutes, usually a stuck inbound message;
    - pending;
    - stranded, with the amount held;
    - recovered;
    - cancelled;
    - and which deployments cannot be read, with the reason.
  - Offline deployments fall back to the recorded figures and say why.
- **CI** (`.github/workflows/ci.yml`):
  - On every pull request and every push to main:
    - Foundry build and tests;
    - the Solana programs' unit tests;
    - the infra and web typechecks;
    - the web build.
  - Nightly and on demand: the local EVM end-to-end run (deploy, validate, supply).
- **Build note.** The web app builds with webpack (`next build --webpack`). The infra is
  NodeNext-style TypeScript that imports `./x.js` to mean `./x.ts`, and Turbopack has no
  equivalent of webpack's `resolve.extensionAlias` yet.

What the poller does not see yet:

- A stuck message is only inferred from age. Reading the LayerZero endpoint's inbound nonces
  would confirm it.
- History lives on the one server that polls. A hosted indexer (Ponder, Envio, Helius) becomes
  worth it with many deployments or many servers.

#### Still to do: 2c (partner distribution)

The product decision: **partners distribute and we provide the endpoints.** Wallets, exchanges
and apps own their users, and those users' KYC. CrossStock provides the buy and sell endpoints,
and the contracts enforce that orders come through a registered partner. See `PARTNERS.md`.

1. **Contracts: partner access and fees.** Done, on `feature/partner-access-and-fees`:
   - EIP-712 authorisation on EVM, co-signing on Solana;
   - `partnerRequired`;
   - escrowed partner and platform fees, kept only on a fill.
2. **Partner SDK and API.** Done, on the same branch:
   - `@crossstock/sdk`;
   - `/api/v1`: descriptor, exact quotes, order building, tracking and order lists;
   - API keys and rate limits;
   - signed webhooks (`npm run webhooks`).
   See `PARTNERS.md`. Positions (balances across chains) are still to do.
3. **Reference trading page.** `/trade` rebuilt on the SDK, with wallet connection:
   - wagmi + viem, and the Solana wallet adapter;
   - live quotes and the request tracker.
   It doubles as the demo for partners.
4. **Partner docs and a sandbox**: a hosted testnet and test tokens.

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

The backend was not moved in phase 1, on purpose. The infra resolves its paths from the repo root:
`deployments/`, `config/`, `solana/keys`, forge's `out/` and the vendored programs.

- **Phase 2a** routed every one of those paths through `repoRoot()` (`infra/lib/root.ts`). That is
  `CROSSSTOCK_ROOT` when set, and the working directory otherwise.
- **The web server** sets `CROSSSTOCK_ROOT` at startup (`apps/web/src/instrumentation.ts`), so it can
  run the infra from `apps/web`.
- **Moving the backend into `packages/`** is now a matter of setting that root. It still means
  rerunning the whole validation suite on every topology.

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
