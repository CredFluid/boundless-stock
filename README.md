# CrossStock

**One market for every tokenized stock, on Solana, reachable from every chain. Liquidity and
operations are managed from one chain and one place.**

## The problem: tokenized stocks are breaking into pieces

Tokenized stocks are arriving on every chain at once: Solana, Base, Arbitrum, Optimism and more.
Each new chain gets its own copy of the stock, and with it:

- **its own thin pool,** so the same share of Apple trades at different prices on different
  chains, and a large order moves the price far more than it should;
- **its own liquidity to fund,** so an issuer seeds five small markets instead of one deep one;
- **its own operations,** so contracts, fees, stuck transfers and refunds are handled chain by
  chain, by hand;
- **its own ledger,** so nobody can say, at a glance, how much of the stock exists in total or
  where it sits.

This is fragmentation, and it is what has held tokenized assets back. The industry's usual
answers each fix one part of it:

- **A bridge** moves the token, but the user often ends up holding a wrapped IOU, and every
  chain still needs its own market.
- **A pool on every chain** gives each chain a market, but splits the liquidity further.
- **Unified accounting** (one hub keeping the books for many chains) fixes the ledger, but the
  stock still trades in separate markets.

The books can be unified. **The market has not been.**

## Our answer: one home market, every chain a doorway

CrossStock makes Solana the **hub**: the one chain where the stock's market lives, with one pool
of liquidity and one price. Every other chain is a **spoke**, a doorway into that market with
no pool of its own.

```
 Spokes: Base / Arbitrum / Optimism / other Solana chains         Hub: Solana
 ┌──────────────────────────────────┐   order + funds      ┌──────────────────────────────────┐
 │ user presses "buy"                │ ───────────────────► │ the order fills in the one pool: │
 │ in the app they already use       │                      │ one price, one pool of liquidity │
 │ the stock arrives in the same     │ ◄─────────────────── │                                  │
 │ wallet, on the same chain         │   stock + outcome    └──────────────────────────────────┘
 └──────────────────────────────────┘
```

A user on Base presses buy once. The order crosses to Solana, fills in the home pool at the real
market price, and the stock arrives in their wallet on Base, in about three seconds. They never
leave their chain, never hold a wrapper, and never see a bridge.

For the issuer, this changes where everything is managed:

- **Liquidity in one place.** One pool on Solana serves every chain. Deepening it improves the
  price for every user everywhere at once.
- **Operations in one place.** Refunds happen automatically at the hub. Stuck-order
  cancellation, recovery of stranded returns, partners and fees are driven from one command line
  across every chain, and tracked in one issuer dashboard.
- **One source of truth.** Supply on every chain, tokens in flight between chains, the live
  market and every trade are in one view.

## How it stays honest

**Tokens move by burn and mint, not by wrapping.** Every asset is an omnichain token (LayerZero
OFT):

- it is burned (or, for an issuer's existing token, locked) on the chain it leaves;
- it is minted on the chain it arrives at;
- a real swap in the home pool happens in between.

**Supply is conserved.** Supply on every chain plus what is in flight always equals what was
issued. A spoke can never create supply. The validation suite checks this across both VMs after
every scenario, and the dashboard shows it live.

**Nothing is ever lost:**

- an order that can't fill is refunded in full;
- a stuck message can be cancelled and the funds restored;
- a return that can't be delivered is held and retried.

**Fees are only kept on a fill.** Partner and platform fees wait in escrow, and go back to the
user if the order is refunded, cancelled or stranded.

## Built to be a platform

| | |
|---|---|
| **Issuers keep their token** | Bring an existing SPL mint (Token-2022 included) or ERC-20. It is locked in a vault, never replaced, and the issuer keeps the mint authority. Or launch a new one. |
| **Partners bring the users** | Wallets, exchanges and apps integrate buy and sell through an SDK and API, and handle KYC on their side. With `partnerRequired`, only orders a registered partner approved get in; on Solana the partner co-signs. See [`PARTNERS.md`](PARTNERS.md). |
| **Exact quotes** | The API asks the home market itself, so an order fills at its quote to the base unit. |
| **An issuer dashboard** | Supply per chain with the conservation check, the live market, trade history and operations queues. |
| **Any chain as home** | The home chain is a line in the config. The same infrastructure runs with an EVM chain as the hub and Solana as a spoke. |

## Proven, on local chains

These figures come from the full pipeline on local validators, with the real LayerZero V2
programs and contracts, and our local relayer standing in for LayerZero's network:

- **15,000 USDC spent on Base returned 99.32568 tAAPL** in the same wallet on Base, priced by the
  home pool on Solana (151.02 against a spot of 150.42), in 2.9 s. Base has no market.
- **10,000 USDC on a second Solana chain bought 66.137881 tAAPL** against the same pool. Its
  orders and returns never touch an EVM chain.
- **The safety paths work:** an unfillable order refunded in full, a sell, a stranded return
  recovered by retry, and a stuck order cancelled and restored.
- **Partner orders:** unapproved orders are refused, approvals are enforced on both VMs, fees
  are kept only on fills, and SDK orders fill **exactly** at their quote.
- **Token-2022 mints, end to end:** the same scenarios pass with the same figures, and mints with
  unsafe extensions are refused.
- **Supply conserved across VMs** after every scenario, with Solana's 9-decimal amounts rescaled
  to compare with EVM's 18.
- **Tests:**
  - 85 Foundry tests, fuzz and invariants included;
  - 45 + 10 Solana program host tests;
  - 5 SDK tests;
  - 11 end-to-end validation scenarios.

## Where it goes next

- **Proof of reserves.** The issued half (supply across every chain, in flight included) is
  already measured live. Pairing it with a reserve source (custodian, issuer or oracle) gives a
  continuous "issued ≤ held" check. See [`PROOF_OF_RESERVES.md`](PROOF_OF_RESERVES.md).
- **One price on every chain.** Publish the home market's price to every spoke, checked against
  a reference price of the underlying share, so apps on any chain can price the stock without a
  pool of their own.
- **Holders across chains,** alongside supply, in the issuer dashboard.

## Quick start (Solana home)

```bash
npm install && forge build
npm run solana:build && npm run solana:build:relay        # swap_request, swap_relay (see solana/README.md for the rest)

C=config/localnet-solana-home-svm-mirror.json              # Solana home; Base, Arbitrum, Optimism + a second Solana chain as mirrors
npm run solana:up -- --config $C && npm run chains:up      # local Solana validators + EVM chains
npm run solana:deploy -- --config $C                       # programs onto the validators
npm run deploy   -- --config $C                            # full pipeline -> manifest
npm run validate -- --config $C                            # scenarios 8, 9, 10, 11
npm run supply   -- --config $C                            # where every token lives, across VMs
npm run web:dev                                            # issuer dashboard: http://localhost:3000/app
```

Other topologies are a different config, with no code changes:

| Config | Home | Mirrors |
|---|---|---|
| `localnet-solana-home.json` | Solana | Base, Arbitrum, Optimism |
| `localnet-solana-home-svm-mirror.json` | Solana | the above plus a second Solana chain |
| `localnet-solana-home-t22.json` | Solana, **Token-2022 mints** | the above plus a second Solana chain |
| `localnet-solana-home-adapter.json` | Solana, **the issuer's existing SPL mint** | Base, Arbitrum, Optimism |
| `localnet-solana.json` | Base | Arbitrum, Optimism, Solana |
| `localnet.json` | Base | Arbitrum, Optimism |

Onboard partners and set fees on a running deployment with `npm run partners -- --config …`. The
partner API (`/api/v1`) and the SDK (`@crossstock/sdk`) are described in [`PARTNERS.md`](PARTNERS.md).

## Web app

The repo is an npm-workspaces monorepo:

- **`apps/web`:** the landing page, the issuer dashboard, the trading app and the partner API.
- **`packages/sdk`:** the partner SDK.
- **`packages/shared`:** shared types.

The dashboard reads the deployment records in `deployments/`, and reads each deployment's chains
live, through the same infra code the CLI uses:

- supply on every chain;
- the home market;
- relay health;
- trade history;
- operations queues.

CI (`.github/workflows/ci.yml`) runs:

- the Foundry tests;
- the Solana programs' unit tests;
- the TypeScript and SDK checks;
- the web build.

## Where to read next

| File | What it is |
|---|---|
| **[`agents.md`](agents.md)** | **Start here.** Full context for anyone picking this up cold: goal, architecture, current state, open questions. |
| [`PARTNERS.md`](PARTNERS.md) | Partner orders, fees, the SDK and API, and webhooks. |
| [`NOTES.md`](NOTES.md) | Running log of gotchas, failures and findings. |
| [`FRONTEND.md`](FRONTEND.md) | The web app's plan and phases. |
| [`PROOF_OF_RESERVES.md`](PROOF_OF_RESERVES.md) | Reserves against omnichain supply: parked, and what it needs. |
| [`REPORT.md`](REPORT.md) | Config-driven vs hardcoded, gas and latency, manual steps. |

## Layout

```
solana/         Solana programs
  programs/swap_request   mirror entrypoint: buy/sell, partner orders, fees
  relay/                  swap_relay: the home-market relay
  vendor/                 LayerZero OFT (with recovery + flow counters), the pool program
src/            Solidity: OmniToken / adapter, SwapRequest (mirror), SwapRelay (EVM home), PoolQuoter
infra/          deployment pipeline, local relayer, validation scenarios, partner API core
apps/web/       landing, issuer dashboard, /api/v1
packages/sdk/   partner SDK
config/         deployment configs — the home chain is one of them
```

## Honest limits

- **Local chains only so far.** Deploying on Solana devnet and public testnets with LayerZero's
  own network is the next step.
- **Token-2022: standard mints only.** Token-2022 mints work end to end (metadata extensions
  included; see `NOTES.md`). Mints with transfer fees, a permanent delegate or a transfer hook
  (which includes today's PreStocks) are refused, because each needs a
  product decision (who bears a fee, whether a delegate over the escrow is acceptable) before it
  can be carried safely.
- **The stock is a test token (tAAPL),** and USDC is our own omnichain token. A live deployment
  would pair the stock with a stablecoin that moves natively between chains.
