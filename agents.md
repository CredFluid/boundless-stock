# agents.md — CrossStock

> Living context file. Any agent (human or AI) picking this repo up cold should be able to
> read **only this file** and know what this is, how it works, how to run it, and where the
> sharp edges are. **Update the "Current State" section at the end of every milestone.**
>
> Companion file: [`NOTES.md`](NOTES.md) — the running log of gotchas and hard-won findings.

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

The second mirror chain exists specifically to prove the per-chain wiring **generalizes** —
that the infra is not accidentally correct only for the first chain it was tested against.

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
npm install          # node deps (viem, tsx)
forge build          # contracts

# bring up the local three-chain environment (home + 2 mirrors)
npm run chains:up

# run the full pipeline against a config
npm run deploy -- --config config/localnet.json

# => writes deployments/<network-set>.manifest.json
```

To target live testnets instead, point at the testnet config and supply a funded key:

```bash
cp .env.example .env     # set DEPLOYER_PRIVATE_KEY and RPC URLs
npm run deploy -- --config config/testnet.json
```

**No code changes are required between those two runs.** That is the whole point of the
config-driven design — see §8 for the honest accounting of what is and isn't config-driven.

---

## 5. How to run the validation suite

```bash
npm run validate -- --manifest deployments/<name>.manifest.json
```

Individual scenarios can be run on their own; see §6 for what each one proves.

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

**Milestones 1–3 complete: token deployment, mirror deployment, peer wiring.**

| Area | State |
|---|---|
| `agents.md` / `NOTES.md` | ✅ current |
| Contracts: `TokenizedStock` (OFT), `USDCMock` | ✅ built, deployed, verified on-chain |
| Local 3-chain environment (real `EndpointV2` per chain + relayer) | ✅ working |
| Module 0 — endpoint bootstrap | ✅ deploys/uses LayerZero endpoint per chain |
| Module 1 — token deployment | ✅ home token + pairing asset, supply verified on-chain |
| Module 2 — mirror deployment | ✅ loops mirror list, both mirrors deployed with supply 0 (verified) |
| Module 3 — peer wiring | ✅ **6/6 OFT mesh links verified bidirectionally by read-back** |
| Module 4 — pool deployment | ⬜ not started |
| Module 5 — relay contracts | ⬜ not started |
| Module 6 — manifest | ⬜ not started |
| Validation 1–5 | ⬜ not started |

**Core proof point (scenario 2): NOT YET PROVEN.** Requires modules 4–6.

### What runs today

```bash
npm run chains:up
npm run deploy -- --config config/localnet.json
```

Deploys tAAPL + USDC on the home chain, an empty tAAPL on each of the two mirror chains, and
wires the full OFT peer mesh with read-back verification on every link.

---

## 8. Config-driven vs hardcoded

*(Filled in honestly as the build progresses — see §11 of the final report.)*

---

## 9. Open questions / unresolved design decisions

1. **Return-leg asset.** Settled: receipt-to-mirror + USDC-to-home-address. The alternative
   (making USDC an OFT too) was rejected as contradicting the zero-liquidity premise. Revisit
   if the product needs the output asset to be spendable on the mirror chain.
2. **Stalled-message recovery.** LayerZero V2 delivers or reverts; it does not time out. If a
   destination call permanently fails, what releases the locked input on the mirror chain?
   Validation scenario 4 exists to characterise this. **Likely a production blocker.**
3. **Who pays the return-leg fee?** The home→mirror receipt costs native gas on the home
   chain. Currently funded from value forwarded with the original request. Needs review for
   fee-volatility safety.
4. **Solana as a future mirror.** The messaging layer is LayerZero specifically to keep this
   open, but `SwapRequest` is Solidity. A Solana mirror needs an equivalent program and a
   different address encoding (32-byte native, which LayerZero already assumes).
5. **Price staleness / MEV.** A cross-chain order is exposed to home-chain price movement for
   the full message latency. `minOut` is the only protection right now.

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
