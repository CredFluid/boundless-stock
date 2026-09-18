# agents.md — CrossStock

> Living context file. Any agent (human or AI) picking this repo up cold should be able to
> read **only this file** and know what this is, how it works, how to run it, and where the
> sharp edges are. **Update the "Current State" section at the end of every milestone.**
>
> Companion files: [`NOTES.md`](NOTES.md) — running log of gotchas and hard-won findings.
> [`REPORT.md`](REPORT.md) — final report: config-driven vs hardcoded, gas and latency, what
> still needs manual intervention, what is not production-safe.

---

## 1. What CrossStock is

CrossStock is **deployment infrastructure for launching an omnichain token** across one
*home chain* and one or more *mirror chains*, using **LayerZero V2** for messaging.

It is not a one-off deployment script. It is config-driven infra: point it at a different
token, a different home chain, or a different set of mirror chains, and it should produce a
fully wired deployment with **no code changes** — only a new config file.

### The core goal (this is the thing being proven)

> **Prove that a token deployed and liquid on one chain (the home chain) can be traded from
> any other chain where only a mirror instance exists, with ZERO liquidity required on that
> other chain.**

A user standing on a mirror chain submits a trade and receives a real result, even though
there is **no pool, no market maker, and no local liquidity of any kind** where they are.

- All **price discovery and execution** happen on the home chain's Uniswap V3 pool.
- The mirror chain only ever handles **identity, messaging, and final delivery of the result**.

Every other requirement in this repo exists to prove that one claim works reliably, safely,
and repeatably across **more than one** mirror chain. Scenario 2 of the validation suite
(see §6) is the core proof point.

### What this is a proof of concept *for*

The intended product surface is an issuer-facing flow: *"select your base chain, select your
supported chains."* The output of running this infra once, with a given config, is what that
flow would call under the hood — a fully wired, ready-to-use omnichain token deployment with
no manual follow-up steps.

---

## 2. Chain topology for this run

| Role | Chain | LayerZero EID | What lives there |
|---|---|---|---|
| **Home** | Base Sepolia | `40245` | TokenizedStock OFT, USDC (plain ERC-20), Uniswap V3 pool, SwapRelay |
| **Mirror** | Arbitrum Sepolia | `40231` | TokenizedStock OFT (empty), SwapRequest |
| **Mirror** | Optimism Sepolia | `40232` | TokenizedStock OFT (empty), SwapRequest |
| **Mirror** (added later) | Polygon Amoy | `40267` | TokenizedStock OFT (empty), SwapRequest |

The second mirror chain exists specifically to prove the per-chain wiring **generalizes** —
that the infra is not accidentally correct only for the first chain it was tested against.

Polygon Amoy is not part of the base config. It was added to an **already-deployed** chain set
via `config/localnet-add-chain.json` to exercise the "add a supported chain to a live token"
flow, and the core proof was then run against it. That config is kept as the worked example of
that flow — diff it against `config/localnet.json` and the only change is one extra entry in
`mirrorChains`.

Messaging is **LayerZero directly**, not the Hyperbridge adapter. This is deliberate: Solana
is a likely future mirror target and Hyperbridge does not support Solana, so the infra's
messaging assumptions need to stay consistent with what will actually have to scale there.

Fees are paid in the **native testnet gas token**. There is no separate fee-token faucet step.

---

## 3. Architecture

### 3.1 Contracts

| Contract | Chain | Role |
|---|---|---|
| `TokenizedStock` | home + every mirror | LayerZero V2 **OFT**. Full supply minted on home at deploy; mirrors start empty and are credited only by inbound bridge messages. |
| `USDC` (mock) | **home only** | Plain ERC-20. The pairing asset. Deliberately *not* omnichain — it represents the asset that lives where the real liquidity is. |
| `SwapRelay` | home only | LayerZero OApp. Receives cross-chain swap orders, executes them against the Uniswap V3 pool, and returns a settlement result. |
| `SwapRequest` | every mirror | User-facing entrypoint. Locks the user's input, dispatches the swap order to the home chain, and records the settlement result when it comes back. |

### 3.2 The swap round trip (the core mechanism)

```
  MIRROR CHAIN  (zero liquidity)                 HOME CHAIN  (all liquidity)
  ──────────────────────────────                 ──────────────────────────────

  user
   │  requestSwap(amountIn, minOut)
   ▼
  SwapRequest
   │  • pulls TokenizedStock from user
   │  • locks it, records Request{PENDING}
   │  • OFT send() ── tokens + composed order ──────────►  TokenizedStock (home)
   │                                                        │ credits SwapRelay
   │                                                        ▼
   │                                              SwapRelay.lzCompose()
   │                                                        │  • decodes order
   │                                                        │  • swaps TST → USDC
   │                                                        │    on Uniswap V3 pool
   │                                                        │    (REAL price discovery)
   │                                                        ▼
   │                                              USDC delivered to user's
   │                                              address on the HOME chain
   │                                                        │
   │  ◄──── LayerZero settlement receipt ───────────────────┘
   ▼
  SwapRequest
     • Request{FILLED, amountOut}
     • user's locked input released/consumed
```

**Why the result returns as a receipt rather than as USDC tokens:** USDC is specified as
home-chain-only and is a plain ERC-20 — it has no bridging capability by design, because it
represents the asset that lives where the liquidity lives. So the mirror chain's "delivery of
the result" is the authenticated settlement record (exact `amountOut`, execution price, status),
while the USDC itself is delivered to the user's address on the home chain. The *failure*
path is different: on revert, the locked TokenizedStock is bridged **back** to the mirror
chain via OFT `send()`, so the user is made whole where they started. See `NOTES.md` for the
full reasoning and the alternatives that were rejected.

### 3.3 Infra modules

Each module is independently runnable and independently re-runnable (idempotent where it can
be). The full pipeline is the modules in order.

| # | Module | Does |
|---|---|---|
| 1 | Token deployment | Deploys `TokenizedStock` OFT + `USDC` on the configured **home** chain |
| 2 | Mirror deployment | Loops the configured mirror list, deploys an empty `TokenizedStock` OFT on **each** |
| 3 | Peer wiring | `setPeer()` bidirectionally across every chain pair, **reading each registration back** before moving on |
| 4 | Pool deployment | Uniswap V3 `TokenizedStock/USDC` pool on home, seeded with configurable test liquidity |
| 5 | Relay deployment | `SwapRelay` on home, `SwapRequest` on each mirror, peer-wired by the same module as step 3 |
| 6 | Manifest | Emits one JSON file with every address, every peer-wiring status, and the pool — the single artifact anything downstream reads |

---

## 4. How to run the deployment infra

> **Status:** see §7 for what is actually built right now.

```bash
npm install          # node deps (viem, tsx). NOTE: uses --legacy-peer-deps, see NOTES.md
forge build          # contracts

# bring up the local three-chain environment (home + 2 mirrors)
npm run chains:up

# run the full pipeline against a config
npm run deploy -- --config config/localnet.json

# => writes deployments/crossstock-localnet.manifest.json
npm run chains:down
```

To target live testnets instead, point at the testnet config and supply a funded key:

```bash
cp .env.example .env     # set DEPLOYER_PRIVATE_KEY and RPC URLs
npm run deploy -- --config config/testnet.json
```

**No code changes are required between those two runs.** That is the whole point of the
config-driven design — see §8 for the honest accounting of what is and isn't config-driven.

### Adding a chain to an already-launched token

Add one entry to `mirrorChains` and re-run the same pipeline. Every module is reuse-first, so
existing contracts are kept, the pool is **not** re-seeded and the home token is untouched:

```bash
npm run deploy -- --config config/localnet-add-chain.json
```

The pipeline is idempotent generally: re-running it is safe. `--fresh` forces a clean
deployment, ignoring any existing manifest.

---

## 5. How to run the validation suite

```bash
npm run validate -- --config config/localnet.json          # all five
npm run validate -- --config config/localnet.json --only 2 # just the core proof
npm run validate -- --only 2 --mirror polygon-amoy         # against a specific mirror
```

A manifest can be named directly with `--manifest <path>` instead of a config. Set
`RELAY_VERBOSE=1` to see every LayerZero packet, its gas, and any failed delivery.

Run against a **fresh** deployment when the numbers matter — scenario 4 deliberately strands
funds, and the residue is real (see `NOTES.md`). See §6 for what each scenario proves.

---

## 6. Validation scenarios

| # | Scenario | Proves |
|---|---|---|
| 1 | Direct bridge sanity check | OFT `send()` home → mirror moves balance correctly; establishes baseline latency |
| 2 | **Full swap-relay round trip** | **THE CORE PROOF.** `requestSwap()` from a mirror chain with zero local liquidity → funds locked → swap executes on home pool → result delivered back |
| 3 | Failure case: bad slippage | Swap reverts safely, user's locked input is **not** lost |
| 4 | Failure case: stalled message | Documents what happens to locked funds when the destination call never completes; flags whether timeout/refund is needed before production |
| 5 | Multi-mirror check | Scenario 2 repeated against a **second** mirror chain — proves per-chain wiring generalizes |

---

## 7. Current state

> ## ✅ CORE PROOF POINT: PROVEN — and proven on two independent mirror chains
>
> **A trade submitted from a chain with zero liquidity executed on the home chain's pool and
> returned a real, authenticated result to the originating chain.**
>
> | | Arbitrum Sepolia | Optimism Sepolia |
> |---|---|---|
> | Local liquidity there | **none** — no pool, no quote asset, no market maker | **none** |
> | Sold | 100 tAAPL | 100 tAAPL |
> | Received (on Base Sepolia) | **14,940.845155 USDC** | **14,898.490980 USDC** |
> | Effective price | 149.408452 | 148.984910 |
> | Slippage vs spot | 0.3944% | 0.3942% |
> | `requestSwap` gas | 338,666 | 338,666 |
> | Round-trip latency | 102 ms | 70 ms |
>
> Slippage decomposes exactly into the 0.3000% pool fee plus 0.0944% price impact, and the
> impact matches the trade being 0.1% of the pool's base reserve — which is what confirms this
> is genuine Uniswap V3 execution, not a mocked result. The pool's spot price moved on every
> trade and its reserves moved by exactly the amount sold.
>
> Identical gas across two different mirror chains is the evidence that the per-chain wiring
> **generalises** rather than being accidentally correct for the first chain tested.

**All 6 deployment milestones complete. All 5 validation scenarios passing.**

| Area | State |
|---|---|
| `agents.md` / `NOTES.md` | ✅ current |
| Contracts | ✅ built, deployed, exercised end to end |
| Local 3-chain environment (real `EndpointV2` per chain + packet relayer) | ✅ working |
| Module 0 — endpoint bootstrap | ✅ |
| Module 1 — token deployment | ✅ |
| Module 2 — mirror deployment | ✅ |
| Module 3 — peer wiring | ✅ 10/10 links verified by read-back |
| Module 4 — pool deployment | ✅ |
| Module 5 — relay contracts | ✅ |
| Module 6 — manifest | ✅ |
| Validation 1 — direct bridge | ✅ 56 ms, supply conserved |
| Validation 2 — **swap round trip (CORE PROOF)** | ✅ **PASSING** |
| Validation 3 — bad slippage | ✅ input returned in full, net change 0 |
| Validation 4 — stalled message | ✅ characterised — **recovery is never automatic** |
| Validation 5 — multi-mirror | ✅ generalises to a second chain |

### What runs today

```bash
npm run chains:up
npm run deploy   -- --config config/localnet.json
npm run validate -- --config config/localnet.json      # 5/5 pass
```

### Headline numbers

| | |
|---|---|
| Full 3-chain deployment | 54,952,788 gas / 51 txs (home 31.9M incl. deploying Uniswap V3 from scratch) |
| Adding a 4th chain | 12,378,021 gas / 31 txs — pool **not** re-seeded, home token unchanged |
| One cross-chain swap | 812,945 gas across both chains; user pays **0.0101 ETH once, on the mirror chain** |
| Local round-trip latency | 70–102 ms (says nothing about live LayerZero latency — see `REPORT.md` §4) |

### The one thing that is NOT production-safe

Validation 4 established that a stalled message never loses funds but never self-heals either.
LayerZero V2 has no message expiry: an undelivered packet stays deliverable forever and a
reverting composed call stays retryable forever, and in both cases the user's input is
unusable until somebody acts. **A timeout/refund path is required before this design goes to
production.** See `NOTES.md` and §9 below.

---

## 8. Config-driven vs hardcoded

Full accounting in [`REPORT.md`](REPORT.md) §2. Summary:

**Config-driven:** home chain and mirror list (any length), chain ids, LayerZero eids, endpoint
addresses, RPCs, token name/symbol/decimals/supply, pairing asset, pool fee tier / price / seed
liquidity / tick range, every LayerZero gas and fee parameter, and Uniswap addresses per chain.

Verified by grep: **no chain identity appears anywhere in `src/` or `infra/` outside comments.**
`config/localnet.json` and `config/testnet.json` differ only in `name`, `rpcUrl`, `lzEndpoint`,
`explorer` and the Uniswap `factory` — checkable with `diff`, because the local config
deliberately uses the real chain ids and eids.

**Still hardcoded, and worth knowing:**

- **Uniswap V3 as the venue.** A different DEX needs a new relay implementation. Should be
  abstracted behind a venue interface before production.
- **Sell-only direction.** A mirror user can sell but not buy — buying needs the quote asset on
  the mirror chain, which the zero-liquidity premise forbids. See §9.
- Default gas constants in the contracts (all overridable by owner setters the infra calls from
  config), the position-NFT descriptor, the mint deadline, and the trade sizes inside the
  validation scenarios.


---

## 9. Open questions / unresolved design decisions

Ordered by severity. Full discussion in [`REPORT.md`](REPORT.md) §6.

1. **No timeout or refund for a stalled message. THIS IS THE BLOCKER.** Validation scenario 4
   established that funds are never destroyed — every stall is recoverable — but recovery is
   **never automatic**. LayerZero V2 has no message expiry: an undelivered packet stays
   deliverable indefinitely, a reverting composed call stays retryable indefinitely, and in both
   cases the user's input is unusable until somebody acts. In the "delivered but compose
   reverted" case the tokens sit in `SwapRelay` on the home chain where the user cannot reach
   them at all. A production version needs a claim path with a deadline.
2. **A failed swap costs the protocol, not the user.** The refund is a second LayerZero message
   paid from `SwapRelay`'s balance. At scale, deliberately-failing orders could drain the relay's
   gas buffer.
3. **Price staleness across message latency.** A cross-chain order is exposed to home-chain price
   movement for the full round trip — tens of seconds to minutes on live chains. `minAmountOut`
   is the only protection, so users face a choice between wide slippage tolerance and frequent
   refunds. Inherent to the design; the strongest argument for the market-maker fast path that
   was out of scope here.
4. **Sell-only.** This POC proves cross-chain access to home-chain liquidity in **one direction**.
   Buying from a mirror chain needs either a bridgeable quote asset or a credit/intent mechanism.
5. **Address identity assumes EVM.** "Proceeds delivered to the user's address on the home chain"
   works because an EOA shares an address across EVM chains. That breaks for smart-contract
   wallets and completely for Solana — the stated reason LayerZero was chosen over Hyperbridge.
   A Solana mirror needs an explicit recipient mapping.
6. **No fee-bump retry.** The gas *limit* problem is fixed; a live transaction can still fail on
   *price* if the base fee moves between estimation and inclusion.
7. **Single owner key across all chains.** Every contract is owned by the deployer EOA.
8. **Incremental runs scale with the existing set**, not with the number of chains being added:
   every peer link is re-checked and `setReturnGas` rewritten for every mirror. Harmless at four
   chains; make it delta-only before running against a large set.

**Settled during this build:** the return-leg asset question (receipt to the mirror + quote asset
delivered on the home chain) — see `NOTES.md`.


---

## 10. Repo layout

```
src/            Solidity contracts
  core/         TokenizedStock (OFT), USDC mock
  relay/        SwapRelay (home), SwapRequest (mirror)
infra/          TypeScript deployment infrastructure
  modules/      the six deployment modules
  lib/          config loading, chain clients, artifact loading
  validation/   the five validation scenarios
config/         deployment configs (localnet, testnet)
deployments/    generated manifests
test/           Foundry tests
```
