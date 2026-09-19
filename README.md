# CrossStock

Config-driven deployment infrastructure for launching an omnichain token across a **home
chain** and any number of **mirror chains**, using LayerZero V2 — plus a validation suite that
proves the resulting deployment actually works.

## The claim being proven

> A token deployed and liquid on one chain can be traded from any other chain where only a
> mirror instance exists, with **no market required on that other chain**.

A user holds USDC on a chain that has no pool, no market maker and no price for the asset. They
press buy once. The stock arrives in their wallet **on that same chain**, priced by the home
chain's Uniswap V3 pool. Selling works the same way in reverse.

**Status: proven.** 15,000 USDC spent on Arbitrum Sepolia — a chain with no market — returned
**99.605634 tAAPL to the user's wallet on Arbitrum Sepolia**, at 0.3944% total cost, which
decomposes exactly into the 0.30% pool fee plus 0.0944% price impact. One transaction, one fee,
84 ms. Reproduced on a second mirror chain and in the sell direction.

## Quick start

```bash
npm install
forge build

npm run chains:up                                    # local chain set
npm run deploy   -- --config config/localnet.json    # full pipeline -> manifest
npm run validate -- --config config/localnet.json    # 6/6 scenarios
npm run chains:down
```

Targeting live testnets is a config swap plus a funded key — no code changes:

```bash
cp .env.example .env    # DEPLOYER_PRIVATE_KEY + RPC URLs
npm run deploy -- --config config/testnet.json
```

Adding a chain to an already-launched token is one extra entry in `mirrorChains` and a re-run:

```bash
npm run deploy -- --config config/localnet-add-chain.json
```

## Where to read next

| File | What it is |
|---|---|
| **[`agents.md`](agents.md)** | **Start here.** Full context for anyone picking this up cold: goal, architecture, current state, open questions. |
| [`NOTES.md`](NOTES.md) | Running log of gotchas, failures and findings — including several that cost real debugging time. |
| [`REPORT.md`](REPORT.md) | Final report: config-driven vs hardcoded, gas and latency, what still needs manual intervention. |

## Layout

```
src/            Solidity
  core/         OmniToken (OFT base), TokenizedStock, USDC
  relay/        SwapRelay (home), SwapRequest (mirror: buy/sell), wire format
  mocks/        local-only: EndpointV2 wrapper, message library, WETH9
infra/          TypeScript deployment infrastructure
  modules/      the deployment modules, 0-6, run in order
  lib/          config, chain clients, artifacts, manifest, Uniswap math
  validation/   the five validation scenarios
config/         deployment configs
deployments/    generated manifests
```

Not in scope for this POC: front-end, freeze/pause/KYC, market-maker fast path.
