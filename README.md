# CrossStock

Config-driven deployment infrastructure for launching an omnichain token across a **home
chain** and any number of **mirror chains**, using LayerZero V2 — plus a validation suite that
proves the resulting deployment actually works.

## The claim being proven

> A token deployed and liquid on one chain can be traded from any other chain where only a
> mirror instance exists, with **zero liquidity required on that other chain**.

A user on a mirror chain submits a trade and receives a real result, even though there is no
pool, no market maker and no local liquidity of any kind where they are. All price discovery
and execution happen on the home chain's Uniswap V3 pool; the mirror chain handles only
identity, messaging and delivery of the result.

**Status: proven.** 100 tAAPL sold from Arbitrum Sepolia (zero local liquidity) returned
14,940.845155 USDC on Base Sepolia at 0.3944% slippage — which decomposes exactly into the
0.30% pool fee plus 0.0944% price impact. Reproduced on two further mirror chains, one of them
added to the token *after* it was already launched.

## Quick start

```bash
npm install
forge build

npm run chains:up                                    # local chain set
npm run deploy   -- --config config/localnet.json    # full pipeline -> manifest
npm run validate -- --config config/localnet.json    # 5/5 scenarios
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
  core/         TokenizedStock (LayerZero OFT), USDCMock
  relay/        SwapRelay (home), SwapRequest (mirror), shared wire format
  mocks/        local-only: EndpointV2 wrapper, message library, WETH9
infra/          TypeScript deployment infrastructure
  modules/      the deployment modules, 0-6, run in order
  lib/          config, chain clients, artifacts, manifest, Uniswap math
  validation/   the five validation scenarios
config/         deployment configs
deployments/    generated manifests
```

Not in scope for this POC: front-end, freeze/pause/KYC, market-maker fast path.
