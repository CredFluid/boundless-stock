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

**The primary flow is BUYING.** A user holds USDC on a mirror chain that has no market for the
stock at all, presses buy once, and the stock arrives in their wallet **on that same chain**,
priced by the home chain's pool. Selling works the same way in reverse. Both directions
deliver the result to the user's wallet on the chain they are standing on; they never touch
the home chain.

**What "zero liquidity" means precisely**, because the distinction carries the whole claim:

- A mirror chain has **no pool, no market maker, no reserves, no price** and no way to discover
  one. Nothing there can quote the user or take the other side of their trade.
- It does have token *contracts*, and users hold *wallet balances* they bridged in themselves.
  **A wallet balance is not liquidity.**
- Every validation scenario re-checks this at run time via `assertNoLocalMarket()` rather than
  assuming it.

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
| **Home** | Base Sepolia | `40245` | Both OFTs with full supply, **the Uniswap V3 pool**, SwapRelay |
| **Mirror** | Arbitrum Sepolia | `40231` | Both OFTs (empty), SwapRequest — **no pool, no market** |
| **Mirror** | Optimism Sepolia | `40232` | Both OFTs (empty), SwapRequest — **no pool, no market** |
| **Mirror** (added later) | Polygon Amoy | `40267` | Both OFTs (empty), SwapRequest — **no pool, no market** |

The home chain is the only place a price exists. Mirror chains hold token contracts so users
can *hold* and *pay with* the assets; they hold no reserves and cannot price anything.

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
| `OmniToken` | — | Base implementation: a LayerZero V2 OFT with caller-specified decimals. Exists because LayerZero's own `OFT` only really supports 18-decimal tokens (see `NOTES.md`). |
| `TokenizedStock` | home + every mirror | The stock. A named `OmniToken`. Full supply minted on home at deploy; mirrors start empty and can only be credited by inbound bridge messages. |
| `OmniTokenAdapter` | home only, **adapt mode** | Alternative to minting: locks a **pre-existing** ERC-20 and backs representations on the mirrors. Lets an issuer bring a token they already have — holders keep their balances, the address never changes. |
| `USDC` | home + every mirror | The quote asset, also an OFT. Omnichain **so that a mirror-chain user has something to pay with** — without this, they could only ever sell. Its liquidity still exists only on the home chain. |
| `SwapRelay` | home only | LayerZero OApp. Receives cross-chain orders, executes them against the Uniswap V3 pool, and sends the result back as tokens. |
| `SwapRequest` | every mirror | User-facing entrypoint: `buy()` and `sell()`. Takes the user's input, dispatches it to the home chain, and pays out whatever comes back. |

### 3.2 The round trip (the core mechanism)

Shown for a **buy**. A sell is the same path with the two assets swapped.

```
  MIRROR CHAIN  (no market)                      HOME CHAIN  (all liquidity)
  ──────────────────────────                     ──────────────────────────────

  user holds USDC, no stock
   │  buy(usdcIn, minStockOut)          <- ONE transaction, one fee
   ▼
  SwapRequest
   │  • pulls the user's USDC
   │  • records Request{PENDING}
   │  • USDC OFT send() ── money + order ────────►  USDC (home)
   │     (order rides as composeMsg)                 │ credits SwapRelay
   │                                                 ▼
   │                                       SwapRelay.lzCompose()
   │                                                 │ • direction derived from
   │                                                 │   WHICH OFT delivered
   │                                                 │ • swaps USDC → stock on
   │                                                 │   the Uniswap V3 pool
   │                                                 │   (REAL price discovery)
   │                                                 ▼
   │  ◄──── stock OFT send() + Settlement ───────────┘
   ▼
  SwapRequest.lzCompose()
     • Request{FILLED, amountOut}
     • transfers the stock to the user
        ↓
  user now holds the stock, ON THIS CHAIN
```

Three properties are worth calling out:

1. **Tokens and instruction travel in one packet.** The order rides as the `composeMsg` of the
   OFT `send()`, so neither side can ever be asked to act on a message whose funds have not
   arrived. No separate "did the money land?" check is needed.
2. **Direction is derived, not declared.** `SwapRelay` decides buy-vs-sell from *which OFT
   delivered the tokens*, which a sender cannot forge. The direction stated in the payload is
   only cross-checked, and a mismatch is refunded rather than executed.
3. **Failure uses the same path as success.** On a revert the *input* is bridged back with a
   Settlement marked `REFUNDED`. From the mirror chain's point of view a fill and a refund are
   the same event: tokens arrived and a request closed.

### 3.3 Infra modules

Each module is independently runnable and independently re-runnable (idempotent where it can
be). The full pipeline is the modules in order.

| # | Module | Does |
|---|---|---|
| 1 | Token deployment | Deploys both OFTs — `TokenizedStock` + `USDC` — with full supply on the **home** chain |
| 2 | Mirror deployment | Loops the configured mirror list, deploys **both** OFTs empty on each — contracts, never a market |
| 3 | Peer wiring | `setPeer()` bidirectionally across every chain pair, **reading each registration back** before moving on. Called once per omnichain asset, plus once for the relay pair |
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

### Bringing a token that already exists

Set `token.existingToken` to its address and the infra **adapts** instead of launching: it
deploys an `OmniTokenAdapter` that locks the existing ERC-20 and backs representations on every
mirror chain. Holders keep their balances and the token's address never changes.

```bash
npm run deploy:legacy    # only for the demo: deploys a stand-in "pre-existing" token
EXISTING_STOCK_ADDRESS=0x... npm run deploy -- --config config/localnet-adapter.json
```

`config/localnet-adapter.json` differs from `config/localnet.json` by exactly one line. Both
modes pass the same 6/6 validation suite. Constraints: exactly one adapter may ever exist per
token, and **fee-on-transfer and rebasing tokens are out of scope**.

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
| 6 | Reverse direction (sell) | A mirror user sells; proceeds arrive on the mirror chain |
| 7 | **Solana mirror** | Buy, refund and sell from a **Solana** mirror, plus supply conservation across VMs. Skipped when no Solana chain is configured |
| 8 | **Solana home** | Buy, refund and sell from EVM mirrors against an Orca Whirlpool on a **Solana home chain**; supply conserved across VMs. The only scenario run when the home chain is Solana |

---

## 7. Current state

> ## ✅ CORE PROOF POINT: PROVEN — buying from a chain with no market
>
> **A user holding only USDC on a chain with no pool, no market maker and no price for the
> asset pressed buy once, and the stock arrived in their wallet on that same chain.**
>
> Validation scenario 2, run 2026-09-19 against the local chain set:
>
> | | |
> |---|---|
> | Where the user stood | Arbitrum Sepolia — **no pool, no market maker, no price source** |
> | What they held | 15,000 USDC. **Zero** tAAPL. |
> | What they did | one transaction, `buy()`, 0.0101 ETH fee, on their own chain |
> | What they received | **99.605634 tAAPL, in their wallet on Arbitrum Sepolia** |
> | Price paid | 150.593891 USDC per tAAPL (home pool spot was 150.000000) |
> | Total cost vs spot | 0.3944% = 0.3000% pool fee + 0.0944% price impact |
> | Pool reserves moved | +15,000 USDC in, −99.605634 tAAPL out |
> | Pool spot after | 150.000000 → **150.284352** — the price moved, because the trade was real |
> | Round trip | 84 ms |
>
> The price impact (0.0944%) matches the trade being 0.1000% of the pool's quote reserve —
> which is what confirms genuine Uniswap V3 execution rather than a mocked result. The user
> never touched the home chain.
>
> Reproduced on a second mirror chain (Optimism Sepolia, scenario 5) and in reverse (selling,
> scenario 6, proceeds delivered on the mirror chain).

**All deployment milestones complete. All 8 validation scenarios passing** (7 needs a Solana mirror, 8 a Solana home; see §12).

| Area | State |
|---|---|
| `agents.md` / `NOTES.md` / `REPORT.md` | ✅ current |
| Contracts: `OmniToken`, `TokenizedStock`, `USDC`, `SwapRelay`, `SwapRequest` | ✅ built, deployed, exercised |
| Local chain environment (real `EndpointV2` per chain + packet relayer) | ✅ working |
| Modules 0–6 | ✅ all green, all idempotent |
| Peer wiring | ✅ 16/16 links verified by read-back (2 asset meshes × 6, + 4 relay star) |
| Validation 1 — direct bridge | ✅ 69 ms, supply conserved |
| Validation 2 — **buy from a chain with no market (CORE PROOF)** | ✅ **PASSING** |
| Validation 3 — bad slippage | ✅ money returned across the bridge, net change 0 |
| Validation 4 — stalled message | ✅ characterised — **recovery is never automatic** |
| Validation 5 — multi-mirror | ✅ generalises to a second chain |
| Validation 6 — reverse direction (sell) | ✅ proceeds delivered on the mirror chain |
| Validation 7 — Solana mirror | ✅ buy, refund, sell, strand, cancel from Solana; supply conserved across VMs |
| Validation 8 — Solana home | ✅ EVM mirrors trade against an Orca Whirlpool on Solana; supply conserved across VMs |

### What runs today

```bash
npm run chains:up
npm run deploy   -- --config config/localnet.json
npm run validate -- --config config/localnet.json      # 6/6 pass, 7 skipped (no Solana chain)
# with a Solana mirror: see §12 for the full sequence — 7/7
```

### Headline numbers

| | |
|---|---|
| Full 3-chain deployment | 63,444,208 gas / 61 txs (home 34.2M incl. deploying Uniswap V3 from scratch) |
| Adding a 4th chain | ~12.4M gas — pool **not** re-seeded, home token unchanged |
| One cross-chain buy | `buy()` 351,514 gas on the mirror, plus the home-side legs |
| User cost | **0.0101 ETH, once, on their own chain** |
| Local round-trip latency | 66–84 ms (says nothing about live LayerZero latency — see `REPORT.md` §4) |

### The one thing that is NOT production-safe

Validation 4 established that a stalled message never loses funds but never self-heals either.
LayerZero V2 has no message expiry: an undelivered packet stays deliverable forever and a
reverting composed call stays retryable forever, and in both cases the user's money is
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

1. **~~No recovery for a stalled message~~ — LARGELY RESOLVED.** Stranded value now records its
   **beneficiary**, `SwapRelay.claimStranded` is **permissionless** and pays that beneficiary on
   the home chain, and a `STRANDED` settlement tells the mirror chain so the request reaches a
   terminal state instead of sitting `PENDING` forever. `SwapRequest` also pays out
   late-arriving settlements to the recorded user rather than keeping them.

   **The undelivered-packet case is also now handled**, via `SwapRelay.cancelStuckInbound`.
   The earlier assessment — that reclaiming it risks a double spend — was only true of a
   *unilateral source-side refund*. LayerZero lets the OApp's delegate make an inbound nonce
   permanently unexecutable (`skip`, and `burn` if it was verified), so the safe sequence is
   **kill on the destination, then authorise the restoration on the source**. Reversing those
   two steps is the double spend; performing them in this order cannot be.

   The remaining gap is *policy*, not mechanism: cancellation is owner-gated, so a user depends
   on the operator to trigger it. A production version wants a timeout after which anyone can,
   and the delegate role behind a timelock.
2. **A failed swap costs the protocol, not the user.** The refund is a second LayerZero message
   paid from `SwapRelay`'s balance. At scale, deliberately-failing orders could drain the relay's
   gas buffer.
3. **Price staleness across message latency.** A cross-chain order is exposed to home-chain price
   movement for the full round trip — tens of seconds to minutes on live chains. `minAmountOut`
   is the only protection, so users face a choice between wide slippage tolerance and frequent
   refunds. Inherent to the design; the strongest argument for the market-maker fast path that
   was out of scope here.
4. **~~Sell-only~~ — RESOLVED.** Both directions now work and deliver the result to the user's
   wallet on the chain they are standing on. Resolved by making the quote asset omnichain, which
   contradicts one line of the original brief deliberately — see `NOTES.md`, 2026-09-19.
5. **Address identity assumes EVM.** "Proceeds delivered to the user's address on the home chain"
   works because an EOA shares an address across EVM chains. That breaks for smart-contract
   wallets and completely for Solana — the stated reason LayerZero was chosen over Hyperbridge.
   A Solana mirror needs an explicit recipient mapping.
6. **No fee-bump retry.** The gas *limit* problem is fixed; a live transaction can still fail on
   *price* if the base fee moves between estimation and inclusion.
7. **Single owner key across all chains.** Every contract is owned by the deployer EOA. Note
   the asset itself is no longer exposed: `OmniToken` has **no mint function**, so supply is
   fixed at deployment and cannot be inflated by a compromised key. Peer configuration remains
   owner-controlled, which is the residual inflation vector.
8. **~~Sub-quantum stranded value has no claim path~~ — RESOLVED** by `claimStranded`, which
   pays on the home chain precisely because such an amount can never cross the bridge. A
   non-EVM beneficiary still cannot be paid this way and reverts rather than truncating a
   32-byte pubkey into the wrong `address`; that needs an explicit recipient mapping.
9. **Incremental runs scale with the existing set**, not with the number of chains being added:
   every peer link is re-checked and `setReturnGas` rewritten for every mirror. Harmless at four
   chains; make it delta-only before running against a large set.

**Settled during this build:** the return-leg asset question (receipt to the mirror + quote asset
delivered on the home chain) — see `NOTES.md`.


---

## 10. Testing

Two layers, deliberately non-overlapping.

| Layer | What it proves | Run |
|---|---|---|
| **Foundry** (`test/`) | The *contracts* are correct, including under adversarial inputs no sensible scenario would pick | `npm test` |
| **TypeScript** (`infra/validation/`) | The *deployment* works across separate chains with a real relayer | `npm run validate -- --config config/localnet.json` |

65 Foundry tests, including 16 fuzz (512 runs each) and 12 invariants (48 runs × 160 calls), plus
34 Rust tests in `solana/` (`npm run solana:test`).

`test/MixedDecimals.t.sol` runs the relay with an 18-decimal home and a 9-decimal mirror — the
shape of a Solana mirror — and is what proves wire amounts are decimal-independent.

```bash
npm test                # everything
npm run test:invariant  # stateful fuzzing only
npm run test:fuzz       # stateless property tests only
```

### The invariants

**Supply** (`test/invariant/SupplyInvariant.t.sol`) — three real LayerZero endpoints, full peer
mesh, handler that deliberately leaves messages in flight:

- `supplyPlusInFlightEqualsMinted` — every token is on a chain or in flight, never elsewhere
- `neverInflates` — aggregate supply never exceeds what was minted
- `deliveredNeverExceedsSent` — a mint can never outpace its burn
- `perChainBalancesSumToSupply` — catches supply/balance divergence an aggregate check misses

**Relay** (`test/invariant/RelayInvariant.t.sol`) — the fuzzer controls price, venue failure,
zero-output swaps and whether delivery completes:

- `neitherAssetIsEverCreated`, `relayHoldingsAreBounded` — conservation
- `settlementIsFinal` — a settled request can never settle again
- `requestStatesAreCoherent`, `fillsDeliverSomething` — the mirror's record matches reality
- `swapRequestDoesNotAccumulate` — the entrypoint is a conduit, not a vault

### Two rules this suite follows

1. **Every invariant campaign asserts its own coverage.** `afterInvariant()` fails the suite
   unless the fuzzer actually reached a fill, a refund and a stalled compose. This is not
   decoration — it caught the supply suite passing vacuously (no bridge send had ever
   succeeded) and three separate ways the relay campaign was testing a broken venue. See
   `NOTES.md`.
2. **Invariants have negative controls.** `SupplyNegativeControl` deliberately inflates supply
   and asserts the property notices. An invariant that cannot fail is not evidence.

---

## 12. Solana support — status and what remains

**Status: Solana works as a MIRROR chain, end to end, locally.** A user on Solana buys, is
refunded and sells against the home chain's pool, and omnichain supply is conserved across
VMs. Validation scenario 7, run 2026-09-23 on three anvils + a local validator:

| | |
|---|---|
| Buy | 15,000 USDC on Solana → **99.605634 tAAPL** in the user's Solana wallet (fresh deployment; identical to the EVM mirrors' figure), ~1.6 s locally |
| Refund | unsatisfiable floor → 5,000 USDC returned in full |
| Sell | 20 tAAPL on Solana → ~3,000 USDC on Solana |
| Stranded | return leg unsendable → STRANDED notice reaches the Solana request; permissionless `retryReturn` later delivers the result |
| Cancelled | order never delivered → killed on the home chain → the input is minted back on Solana, exactly once |
| Supply | EVM Σ + Solana mint (rescaled 9 → 18 decimals) = exactly what was minted, both assets |

Full suite on the mixed deployment: **7/7**. EVM-only regression: 6/6 with unchanged figures.

```bash
# once: toolchains — Agave 3.0.14 CLI (solana-test-validator, cargo-build-sbf, spl-token)
npm run solana:lz-build     # LayerZero endpoint + simple-messagelib, from the vendored commit
npm run solana:build        # swap_request.so
npm run solana:build:oft    # LayerZero's OFT, with OFT_ID baked in

npm run solana:up && npm run chains:up
npm run solana:deploy                                   # OFT + swap_request onto the validator
npm run deploy   -- --config config/localnet-solana.json   # EVM + Solana, one pipeline
npm run validate -- --config config/localnet-solana.json   # 7/7
```

**No devnet access is needed.** `solana:up` loads LayerZero's endpoint and `simple-messagelib`
at their canonical ids from source builds; `--clone-devnet` keeps the old behaviour.

### Solana as the HOME chain (M26)

**Status: works end to end, locally.** With the home chain on Solana, the full supply is minted
there, the market is an **Orca Whirlpool**, and orders from EVM mirrors execute through
**`swap_relay`**. The EVM mirrors run exactly the contracts an EVM home uses — a SwapRequest
addresses its home relay by eid and does not care what VM it runs. Validation scenario 8, run
2026-09-24 on a local validator + three anvils, with Base, Arbitrum and Optimism as mirrors:

| | |
|---|---|
| Buy | 15,000 USDC on Base → **99.32568 tAAPL** on Base at 151.02 (spot 150.42: 0.3% fee + impact), priced by the Whirlpool on Solana |
| Refund | unsatisfiable floor → the relay quotes, declines to swap, and returns 5,000 USDC in full |
| Sell | 20 tAAPL on Base → 3,004.54 USDC on Base |
| Strand | return fee cap below the library's fee → the compose reverts and stays queued; `strand_compose` records it and the mirror shows STRANDED; after the fix, a permissionless `retry_return` refunds 3,000 USDC in full |
| Cancel | an order's message never arrives → `cancel_stuck_inbound` skips it on Solana as the OFT's delegate, the mirror shows CANCELLED and re-creates 2,000 USDC; the killed nonce can never be verified again (next nonce checked as a control) |
| Supply | minted on Solana; Solana mint (9 dec, rescaled) + mirrors (18 dec) = exactly genesis, both assets, after all of the above |

```bash
npm run solana:build:orca && npm run solana:build:relay   # in addition to the builds above
npm run solana:up && npm run chains:up && npm run solana:deploy
npm run deploy   -- --config config/localnet-solana-home.json
npm run validate -- --config config/localnet-solana-home.json   # scenario 8
```

How `swap_relay` differs from `SwapRelay.sol`, and why (details in `NOTES.md`, 2026-09-24):

- **It quotes before it swaps.** Solana cannot catch a failed CPI, so "try the swap, refund in
  the catch" is impossible. The relay runs Orca's own swap maths (`swap_manager::swap`, the
  function Orca's `swap` instruction runs) read-only over the same accounts, and swaps only when
  the result clears the user's floor — which is also passed to Orca as the swap's threshold.
- **The return leg's accounts are recorded, not derived.** The return is a full OFT `send`
  (~20 accounts). For each (asset, mirror) that list is static, so setup derives it once with
  LayerZero's OFT SDK and records it as a `ReturnRoute`; every delivery is checked against it.
- **A lookup table carries the static accounts**, and planning names them by index: a plan
  naming ~60 accounts in full exceeds Solana's 1 KB return-data limit.
- **Stranding is an explicit step** (M28). `SwapRelay.sol` strands in the `catch` of a failed
  return; on Solana a failed return reverts the whole compose, which stays queued — nothing is
  lost, but the mirror hears nothing. `strand_compose` (admin) consumes that compose, records the
  untraded input in a `Stranded` account and sends a STRANDED notice; `retry_return` (anyone)
  later sends it back as a refund, closing the record. Notices are plain endpoint sends from the
  relay over a recorded `notice route`, like return routes.
- **Cancellation uses Solana's kill semantics** (M28). `cancel_stuck_inbound` runs as the OFT
  stores' endpoint delegate (set at deploy, after every path is configured). An unverified
  message is `skip`ped — which needs its payload-hash account, created first with the
  permissionless `init_verify` — and a verified one `burn`ed; either way `init_verify` refuses the
  nonce afterwards. Then the CANCELLED notice, exactly as on EVM.
- **Bring-your-own SPL token** (M29). `token.existingToken` (or `quoteAsset.existingToken`) may
  name an SPL mint on a Solana home: the OFT is initialised as an **adapter** that locks it in
  escrow, the mint and its authority stay with the issuer, and nothing is minted. The mint is
  checked before any contract is deployed (classic SPL Token, decimals as configured).
  `npm run deploy:legacy -- --config config/localnet-solana-home.json` creates a stand-in;
  `config/localnet-solana-home-adapter.json` deploys against it. Scenario 8 then checks the
  adapter's invariant — escrow = Σ mirror supply, issuer's supply untouched, authority kept.
- **Its own Cargo workspace** (`solana/relay/`), seeded from Orca's lock: under the main
  workspace's lock, Orca's dependency tree needs Rust edition 2024, which the SBF cargo cannot
  parse. Orca's program is vendored (`solana/vendor/whirlpool`, two recorded local changes).

### What is built and verified

| | |
|---|---|
| Multi-VM config schema | `vm: "evm" \| "svm"`, with per-VM validation. An SVM chain carries an `svm` block and must omit `chainId`; an EVM chain must have one. |
| VM routing in the pipeline | An SVM chain is detected before anything is deployed and reported clearly, rather than failing several layers down inside viem. |
| Local Solana validator | `npm run solana:up` starts a validator with LayerZero's **real** EndpointV2 cloned from devnet — 1,639,888 bytes, executable under BPFLoaderUpgradeab1e. Verified working. |
| Manifest records the VM | So downstream tooling never has to infer it. |
| `swap_request` program | Builds against LayerZero's real `oapp` crate; deploys; `init_store` executes and registers the OApp. |
| `SolanaChain` backend | Deployment, account reads, PDA derivation, and a preflight that checks the endpoint is *executable* rather than merely present. |

Why `eid` needs no special-casing: LayerZero addresses every chain as a `bytes32` and routes on
`eid` regardless of VM, so the *messaging* layer is already VM-agnostic. What differs is
everything around it — deployment, addressing, and what a "pool" is.

### Verified facts the next step should start from

- **LayerZero EndpointV2 on Solana:** `76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6`, same id
  on mainnet and devnet. Must be cloned with `--clone-upgradeable-program`; a plain `--clone`
  produces an account the loader cannot execute.
- **The `oapp` crate is not on crates.io.** It lives at
  `packages/layerzero-v2/solana/programs/libs/oapp` in `LayerZero-Labs/LayerZero-v2` and must be
  vendored or path-referenced.
- **Version pins are NOT an obstacle — this was tested, not assumed.** The repo has two
  variants. `programs/` pins `anchor-lang 0.29.0` / rust 1.75 and carries the full endpoint
  program. `anchor-latest/` pins `anchor-lang 0.32.1`, is **interface-only**
  (`endpoint-interface` + `messagelib-interface`), and is the right base for an OApp — you CPI
  into the deployed endpoint rather than building it.

  `cargo build-sbf` on `anchor-latest/libs/oapp` **compiles cleanly on this machine in ~67s.**
  The local anchor-cli version (0.30.1) is irrelevant to compilation; it matters only for IDL
  generation and test scaffolding. Use `anchor-latest`.
- **LayerZero already ships a complete Solana OFT program** (`programs/oft` in that repo), so
  the token side does not need to be written — only deployed and initialised.

### Fixed in M24a/b (see `NOTES.md`, 2026-09-23)

- **Wire amounts are in shared decimals** on both VMs, so a mirror may use different local
  decimals than the home chain. Solana mints default to `min(asset decimals, 9)` via
  `svm.decimals`; config loading refuses a u64 overflow. Previously an 18-decimal tAAPL mint was
  being created on Solana, and a mirror's slippage floor would have been read at the wrong scale.
- **`swap_request::lz_compose` now works.** It parses the OFT's compose frame, authenticates the
  home relay, binds the request to the settlement, checks the recipient and both token accounts,
  and pays the user. It could not close a single trade before. The checks are
  `verify_settlement`, unit-tested case by case.
- **Compose planning speaks V2**: `lz_compose_types_info` added, `lz_compose_types_v2` returns
  the instruction plan (create the user's token account, then `lz_compose`).
- **Settlement carries `recipient`**, which Solana needs to name the user's token account
  before delivery.

All of the above is now exercised on a local validator by scenario 7, not only host-tested.

### Built in M24 (see `NOTES.md`, 2026-09-23)

- **One pipeline for both VMs.** `npm run deploy` runs the EVM modules over the EVM chains,
  routes every EVM endpoint to every chain, then sets up each Solana chain and points every EVM
  OFT and the home relay at the Solana accounts. Solana OFTs peer with every EVM chain (full
  mesh). Peer wiring verifies all links by read-back, EVM → Solana included.
- **Local LayerZero on Solana** (`infra/solana/lz-local.ts`): endpoint initialised (permissionless
  on a fresh validator), `simple-messagelib` registered as the default library, per-OApp nonce /
  library / config accounts for every path. Built with LayerZero's SDK, not hand-encoded.
- **Relayer speaks SVM** (`infra/solana/relay.ts`): reads `PacketSent` from Solana event CPIs;
  delivers into Solana via `init_verify` → `validate_packet` → the receiver's own
  `lz_receive`/`lz_compose` plan, executed by LayerZero's SDK Executor helpers. So a program that
  plans a delivery wrongly fails here as it would under LayerZero's real Executor.
- **`lz_receive` on `swap_request`** (M25): STRANDED and CANCELLED notices reach Solana
  requests. A CANCELLED input is minted back through `recovery_credit`, a gated instruction
  CrossStock adds to the vendored OFT (`solana/vendor/oft-solana/LOCAL_CHANGES.md`), callable
  only by the request store. Each request records its outbound nonce in a `NonceIndex` PDA keyed
  by (OFT store, nonce), which is how a notice naming only a killed message finds its request.
- **A Solana user client** (`infra/solana/client.ts`) for `open_request`, deriving the forwarded
  OFT `send` accounts with LayerZero's OFT SDK.
- **Real messaging fees and Solana-native executor options** (M27). The local
  `simple-messagelib` charges a fee per send (`svm.localMessageLibFeeLamports`, default 50,000
  lamports), so nothing passes by sending zero. `open_request` sends with a quoted fee — the
  client quotes the OFT send as it will be made, with an order-sized composeMsg, and the user,
  who signs as the send's payer, pays it. `swap_relay`'s return leg passes a per-mirror cap
  (`Peer.max_return_fee`); the Executor's payer pays the actual fee. Return legs from an EVM
  relay to a Solana mirror carry compute units and lamports (`SwapRelay.returnValue`,
  `returnOptions(eid)`, set from `svm.executor`), and mirror SwapRequests facing a Solana home
  ask for compute units and a lamport compose value that covers the return fee. Scenarios 7 and
  8 check the fee actually charged, not merely that sends succeed.

### What remains, in dependency order

**Solana as a mirror chain:** nothing functional. Against a live cluster, the fee path has been
exercised only with `simple-messagelib`; the ULN debits the same `payer` account of the send,
but the default `svm.executor` figures are local guesses and want measuring on devnet.

**Solana as the home chain:**

1. **Several Solana chains in one deployment** (a Solana home with Solana mirrors) — refused today.
2. **Supply accounting on SPL**: `bridgedOut`/`bridgedIn` counters for the Solana OFT, and
   `infra/supply.ts` plus the supply invariants extended to it. (Scenarios 7 and 8 already check
   conservation across VMs from mint supplies.)

### The real difficulties

Neither is a toolchain problem. Both are architectural, and both were found by reading
LayerZero's actual Solana source rather than assuming the EVM design carries over.

**1. Compose is invoked differently.** On EVM, `endpoint.lzCompose()` *calls into* your
contract. The Solana endpoint has **no `lz_compose` instruction at all** — only `send_compose`
and `clear_compose`. The executor invokes the **composer program's own** instruction, which
then CPIs `clear_compose` to validate and consume the queued message. So the compose handling
in `SwapRelay` and `SwapRequest` is inverted: the program is the entrypoint, not the callee.

**2. Every account must be declared up front.** Solana requires a program to enumerate, ahead
of time, every account a delivery will touch — through an `lz_receive_types` view instruction
the executor calls before delivering. An EVM contract simply touches whatever storage it
likes. For `SwapRequest` that means deterministically listing the request PDA, both token
accounts and the escrow; for a Solana `swap_relay` it additionally means listing **every
account the DEX swap will touch**, which for a concentrated-liquidity venue includes tick
arrays that depend on the price at execution time. This is the single hardest part of putting
the relay on Solana, and it has no EVM analogue.

**What carries over unchanged:** the core mechanism. Solana's OFT supports composed messages
(`SendParams.compose_msg: Option<Vec<u8>>`) with a `compose_msg_codec` matching the EVM one,
so "tokens and instruction travel in one packet" holds on both VMs. LayerZero's OFT program
also already implements `init_adapter_oft`, so the bring-your-own-token work has a direct
Solana counterpart.

### Honest assessment

Steps 1–5 are a substantial build; steps 6–8 are larger still, because the venue integration is
new work rather than a translation, and because account pre-declaration makes a
concentrated-liquidity swap materially harder to express than its EVM equivalent.

Nothing is blocked. The toolchain builds, the endpoint runs locally, and the messaging
semantics carry over. The work is real engineering rather than obstacle-clearing.

---

## 11. Repo layout

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
