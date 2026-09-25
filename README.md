# CrossStock

**Solana as the home market for tokenized stocks, tradable from every chain.**

A tokenized stock is issued on Solana, and its one market is an Orca Whirlpool there. Wallets and
apps on other chains (Base, Arbitrum, Optimism, other Solana chains) buy and sell it **against
that market**:

- no pool of their own;
- no wrapped IOU from a bridge operator;
- no split liquidity.

The user presses buy once, on the chain they are on. The order crosses to Solana, fills in the
Orca pool at the real market price, and the stock arrives in their wallet back on their chain.

```
 Base / Arbitrum / Optimism / other Solana chains                   Solana — the home market
 ┌──────────────────────────────────┐   order + funds      ┌──────────────────────────────────┐
 │ user presses "buy"                │ ── LayerZero ──────► │ swap_relay swaps in the          │
 │ (SwapRequest, or swap_request     │                      │ Orca Whirlpool: the one price,   │
 │  on another Solana chain)         │ ◄───── LayerZero ─── │ the one pool of liquidity        │
 │ stock arrives in the same wallet  │   stock + outcome    └──────────────────────────────────┘
 └──────────────────────────────────┘
```

**How the tokens move.** Every asset is a LayerZero omnichain token:

- a burn (or, for an issuer's existing token, a lock) on the chain it leaves;
- a mint on the chain it arrives at;
- a real swap in the Orca pool in between.

Supply summed across chains plus what is in flight always equals what was issued. The validation
suite checks this across both VMs.

**What makes it a platform, not a bridge:**

| | |
|---|---|
| **Issuers keep their token** | Bring an existing SPL mint (or ERC-20) and it is locked in a vault, never replaced. The issuer keeps the mint authority. Or launch a new one. |
| **Partners do KYC, on chain** | With `partnerRequired`, only orders approved by a registered partner (a wallet, exchange or app) get in. On Solana, the partner co-signs the transaction. See [`PARTNERS.md`](PARTNERS.md). |
| **Fees only on a fill** | Partner and platform fees are held in escrow, and returned in full if the order is refunded, cancelled or stranded. |
| **Exact quotes** | The API asks the market itself (Orca's quote of the live Whirlpool), so a fill matches its quote to the base unit. |
| **Nothing is ever lost** | Refunds, cancellation of stuck messages, and recovery of stranded returns, on both VMs. |
| **An issuer dashboard** | Supply per chain with the conservation check, the live market, trade history and operations queues. |

The same infrastructure also runs with an EVM chain as home (a Uniswap V3 pool on Base) and
Solana as a mirror. The home chain is a line in the config.

## Proven, on local chains

These figures come from the full pipeline on local validators, with the real LayerZero V2
programs and contracts and our local relayer standing in for LayerZero's network:

- **A Solana home with EVM mirrors and a second Solana chain as a mirror.**
  - **15,000 USDC spent on Base returned 99.32568 tAAPL** in the same wallet on Base, priced by
    the Orca Whirlpool on Solana (151.02 against a spot of 150.42), in 2.9 s. Base has no market.
  - The same run also proves:
    - an unfillable order refunded in full;
    - a sell;
    - a stranded return recovered by retry;
    - a stuck order cancelled and restored.
  - **10,000 USDC on a second Solana chain bought 66.137881 tAAPL** against the same pool. Its
    orders and returns never touch an EVM chain.
- **Partner orders on a Solana home.**
  - The gate refuses unapproved orders.
  - EIP-712 (EVM) and co-signed (Solana) approvals are enforced.
  - Fees are kept only on fills.
  - Partner-SDK orders fill **exactly** at their Orca-priced quote.
- **Token-2022 mints, end to end.** With the stock and USDC as Token-2022 mints on both Solana
  chains, the same four scenarios pass with the same figures (99.32568 tAAPL on Base, 66.137881
  on the second Solana chain, partner orders filled exactly at their quote), and supply is
  conserved. Mints with unsafe extensions are refused at initialisation.
- **Supply conserved across VMs** after every scenario, with Solana's 9-decimal amounts rescaled
  to compare with EVM's 18.
- **Tests:**
  - 85 Foundry tests, fuzz and invariants included;
  - 45 + 10 Solana program host tests;
  - 5 SDK tests;
  - 11 end-to-end validation scenarios.

## Quick start (Solana home)

```bash
npm install && forge build
npm run solana:build && npm run solana:build:relay        # swap_request, swap_relay (see solana/README.md for OFT, Orca)

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
| `localnet-solana-home.json` | Solana (Orca) | Base, Arbitrum, Optimism |
| `localnet-solana-home-svm-mirror.json` | Solana (Orca) | the above plus a second Solana chain |
| `localnet-solana-home-t22.json` | Solana (Orca), **Token-2022 mints** | the above plus a second Solana chain |
| `localnet-solana-home-adapter.json` | Solana, **the issuer's existing SPL mint** | Base, Arbitrum, Optimism |
| `localnet-solana.json` | Base (Uniswap V3) | Arbitrum, Optimism, Solana |
| `localnet.json` | Base (Uniswap V3) | Arbitrum, Optimism |

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
  relay/                  swap_relay: the home-market relay (Orca Whirlpool)
  vendor/                 LayerZero OFT (with recovery + flow counters), Orca Whirlpool
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
