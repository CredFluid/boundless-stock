# CrossStock POC — Final Report

**Date:** 2026-09-18
**Scope:** config-driven omnichain deployment infra + peer-wiring automation + validation that
the resulting deployment actually works.

---

## 1. Was the core claim proven?

**Yes.**

> A token deployed and liquid on one chain can be traded from any other chain where only a
> mirror instance exists, with **zero liquidity required on that other chain**.

Proven on **three separate mirror chains**, one of which was added *after* the token was
already launched:

| | Arbitrum Sepolia | Optimism Sepolia | Polygon Amoy |
|---|---|---|---|
| Liquidity on that chain | **none** | **none** | **none** |
| Sold | 100 tAAPL | 100 tAAPL | 100 tAAPL |
| Received on Base Sepolia | **14,940.845155 USDC** | **14,898.490980 USDC** | **14,842.298327 USDC** |
| Spot before | 150.000000 | 149.574580 | 149.010164 |
| Effective price | 149.408452 | 148.984910 | 148.422983 |
| Slippage vs spot | 0.3944% | 0.3942% | 0.3941% |
| `requestSwap` gas | 338,666 | 338,666 | 338,666 |
| Round trip | 102 ms | 70 ms | 79 ms |

Absolute USDC figures differ only because each trade executes against a pool the previous trade
already moved.

### Why these numbers constitute a proof rather than a demo

The slippage decomposes exactly:

```
gross at spot (150.000000)         15,000.000000 USDC
less 0.30% pool fee                14,955.000000 USDC
actual received                    14,940.845155 USDC
residual = price impact                14.154845 USDC   (0.0944%)
trade as share of base reserve                            0.1000%
```

A price impact of 0.0944% on a trade worth 0.1000% of the pool's base reserve is what Uniswap
V3 tick math produces at that size. Alongside this, each run verified that the pool's base
reserve moved by **exactly** the amount sold and the pool's spot price moved. A mocked or
short-circuited execution would not reproduce that relationship.

The validation deliberately does not trust the contracts' own reporting. Scenario 2
cross-checks four independent sources: the settlement receipt the mirror chain received, the
user's real USDC balance change on the home chain, the pool's base-reserve delta, and the
pool's spot-price movement. It also runs as a **distinct user account**, not the deployer —
proving it with the account that owns the token, the pool and both relay contracts would have
left an obvious hole.

---

## 2. Config-driven vs still hardcoded

### Fully config-driven

Verified by grep: **no chain identity appears anywhere in `src/` or `infra/` outside comments.**

| Concern | Where it lives |
|---|---|
| Home chain: name, chain id, LayerZero eid, RPC, endpoint address | `config.homeChain` |
| Mirror chain list — any length | `config.mirrorChains[]` |
| Token name, symbol, decimals, initial supply | `config.token` |
| Pairing asset name, symbol, decimals, supply | `config.quoteAsset` |
| Pool fee tier, initial price, seed liquidity, tick range | `config.pool` |
| All LayerZero gas/fee params (`lzReceive`, `lzCompose`, compose value, return gas, relay buffer) | `config.relay` |
| Uniswap addresses per chain, or "deploy them" | `config.homeChain.uniswap` |
| RPC URLs and keys | `${ENV_VAR}` interpolation + `.env` |

The strongest evidence: `config/localnet.json` and `config/testnet.json` differ **only** in
`name`, `rpcUrl`, `lzEndpoint`, `explorer` and the Uniswap `factory`. Token, pool, relay
parameters and the entire chain topology are byte-identical, and **no module code differs
between a local run and a live run**. The local config deliberately uses the real chain ids and
eids so this is checkable with `diff` rather than taken on trust.

### Still hardcoded (and whether it matters)

| Hardcoded | Where | Assessment |
|---|---|---|
| Solidity contract set (OFT, ERC-20, SwapRelay, SwapRequest) | `src/` | By design. Changing the token *standard* is a code change, not config. |
| Uniswap **V3** as the venue | `SwapRelay`, module 4 | **Real limitation.** A different DEX needs a new relay implementation. Worth abstracting behind a venue interface before production. |
| Swap direction: base → quote only | `SwapRelay._settle` | **Real limitation.** A mirror user can sell but not buy, because buying needs the quote asset on the mirror chain — which the zero-liquidity premise forbids. See §6. |
| Default gas constants (`DEFAULT_RETURN_GAS`, etc.) | `SwapRelay`, `SwapRequest` | Low risk. Every one is overridable by an owner setter that the infra calls from config; the constants are only fallbacks. |
| Position NFT descriptor = `address(0)` | module 4 | Cosmetic. Only affects `tokenURI()`, which nothing calls. |
| Mint deadline = now + 1 hour | module 4 | Fine for a POC; should be config for slow live chains. |
| Trade sizes in the validation scenarios (100 tAAPL, etc.) | `infra/validation/` | Test fixtures, not infra. Should become config if the suite is reused for other tokens. |
| `EXECUTOR_OVERHEAD = 120,000` in the relayer | `infra/relayer.ts` | Local-environment only; irrelevant on live chains where LayerZero's Executor runs. |
| Anvil account #1 as the test user | validation harness | Overridable via `USER_PRIVATE_KEY`. |

---

## 3. Adding a new mirror chain to an already-launched token

**Confirmed: it reuses the same mirror-deployment and peer-wiring modules. No new code path.**

This was *not* true initially, and the honest first answer was no. Modules 0, 1, 2, 4 and 5
deployed unconditionally — re-running with one extra chain would have deployed a **second home
token and a second pool**, forking the supply and orphaning the live one. Only module 3 was
already safe, because it reads each peer back before writing.

Fixed by making every module reuse-first (`infra/lib/reuse.ts`), which treats the manifest as a
*claim* rather than the truth: an address is reused only if there is actually code at it on
that chain.

### The flow, as it now stands

```bash
# 1. add one entry to config.mirrorChains
# 2. re-run the same pipeline, no flags
npm run deploy -- --config config/localnet-add-chain.json
```

### Verified by doing it

A fourth chain (Polygon Amoy, eid 40267) was added to a live 3-chain deployment:

| | Before | After |
|---|---|---|
| Home `TokenizedStock` | `0x75c6…1135` | `0x75c6…1135` — unchanged |
| Pool | `0xF8dd…A648` | `0xF8dd…A648` — unchanged |
| Pool liquidity `L` | 1288875159409035126 | 1288875159409035126 — **not re-seeded** |
| `SwapRelay` | existing | reused |
| Peer links | 10, all verified | 18, all verified |

Then the core proof ran against the new chain and passed, with `requestSwap` gas identical
(338,666) to both original mirrors.

### Cost of adding one chain

| Chain | Gas | Txs | What it paid for |
|---|---:|---:|---|
| Polygon Amoy (new) | 11,685,135 | 16 | LayerZero endpoint stack, OFT, SwapRequest, wiring |
| Base Sepolia (home) | 309,494 | 7 | peer wiring + `setReturnGas` only |
| Arbitrum Sepolia | 191,696 | 4 | peer wiring to the new chain only |
| Optimism Sepolia | 191,696 | 4 | peer wiring to the new chain only |
| **Total** | **12,378,021** | **31** | |

On a live chain the endpoint already exists, so the new-chain figure drops to roughly the OFT +
SwapRequest deployments (~3–4M gas).

**Caveat:** the incremental run re-checks every existing peer link and rewrites `setReturnGas`
for every mirror, so cost scales with the size of the existing set rather than with the number
of chains being added. Harmless at four chains; should be made delta-only before this runs
against a large set.

---

## 4. Gas and latency

### Deployment (full 3-chain launch, from empty)

| Chain | Gas | Txs |
|---|---:|---:|
| Base Sepolia (home) | 31,908,168 | 25 |
| Arbitrum Sepolia | 11,522,310 | 13 |
| Optimism Sepolia | 11,522,310 | 13 |
| **Total** | **54,952,788** | **51** |

The home chain's share is dominated by deploying Uniswap V3 from scratch (factory, router,
position manager). On a live testnet the canonical factory comes from config, so the real home
figure is substantially lower.

### Runtime — one complete cross-chain swap

| Step | Chain | Gas |
|---|---|---:|
| `requestSwap` (user's only transaction) | mirror | 338,666 |
| OFT `lzReceive` — delivers tokens, queues compose | home | 123,759 |
| `lzCompose` — the swap + return message | home | 261,625 |
| Receipt `lzReceive` | mirror | 88,895 |
| **Total across both chains** | | **812,945** |

A plain bridge with no swap, for comparison: `send()` 120,443 + `lzReceive` 108,583.

**Fees:** the user pays **0.0101 ETH once, on the mirror chain**, and never touches the home
chain. That figure includes the 0.01 ETH `lzCompose` value forwarded to `SwapRelay` to pre-pay
the return leg, which is why the round trip is a single user transaction.

### Latency

| Scenario | Local |
|---|---:|
| Direct bridge | 56–73 ms |
| Swap round trip | 70–102 ms |
| Bad-slippage refund | 84–97 ms |
| Recovery after compose retry | 28 ms |

**These are local-anvil figures and say nothing about production latency.** Real LayerZero
latency is dominated by DVN attestation and destination block times — typically tens of seconds
to minutes across testnets. What the local numbers *do* establish is that CrossStock adds no
meaningful overhead of its own: the round trip is bounded by message transport, not by anything
the protocol does.

**A correction worth recording:** every latency figure measured before a mid-build fix was
wrong. Scenarios 1–3 originally reported ~4,100 ms. That was almost entirely the relayer
waiting out viem's 4-second `getBlockNumber` cache — the harness was measuring itself. The
figure was stable, plausible and repeatable, which is exactly why it went unquestioned for a
while. Details in `NOTES.md`.

---

## 5. What required manual intervention that the infra should have handled

Everything in this list was found and fixed during the build. None remain outstanding.

| Problem | Why it mattered | Resolution |
|---|---|---|
| **Gas estimation too tight** | `mint()` reverted `OutOfGas` *intermittently* — the same code succeeded on one run and failed on the next, because Uniswap token ordering flipped between deployments and nudged the cost over the estimate. Worst possible failure mode for a pipeline: the tx does real work, runs out of gas at the tail, and leaves state half-changed. | Every write now estimates explicitly and pads 1.4x, capped at 90% of the block gas limit. |
| **viem caches `getBlockNumber()`** | The relayer compared a **stale** head against its scan cursor, concluded there was nothing new, and skipped block ranges containing packets. Silent, timing-dependent, and it looked exactly like a protocol bug. | All public clients use `cacheTime: 0`. Nothing in a deployment tool or relayer should act on a cached view of chain state. |
| **Pipeline not idempotent** | Adding a chain would have redeployed the home token and pool. | Every module is reuse-first (§3). |
| **Validation could corrupt a deployment** | Scenario 4 deliberately misconfigures gas; an interrupted run left the deployment broken and the *next* run failed in a way that looked unrelated. | Restore moved into a `finally` wrapping the whole scenario. |
| **Anvil code-size limit** | Uniswap's position manager sits at the EIP-170 boundary; deploys failed with no useful message. | Local nodes start with `--disable-code-size-limit`. |
| **`--legacy-peer-deps` required** | A clean `npm ci` fails on LayerZero's peer ranges. | Documented in `NOTES.md` with the exact resolved versions. |

### Still manual, by necessity

- **Funding the deployer** on each chain. Unavoidable — the infra refuses to start if any
  deployer balance is zero, which is the right behaviour.
- **Funding `SwapRelay`'s native buffer** beyond the initial config amount. Each order pre-pays
  its own return leg, so the buffer only covers fee drift, but nothing tops it up automatically.

---

## 6. What is not production-safe

Ordered by severity.

1. **No timeout or refund for a stalled message.** Validation scenario 4 established that funds
   are never *destroyed* — every stall is recoverable — but recovery is **never automatic**.
   LayerZero V2 has no message expiry: an undelivered packet stays deliverable indefinitely, a
   reverting composed call stays retryable indefinitely, and in both cases the user's input is
   unusable until somebody acts. Worse, in the "delivered but compose reverted" case the tokens
   sit in `SwapRelay` on the home chain where the user cannot reach them at all. **This is the
   blocker.** A production version needs a claim path with a deadline.

2. **A failed swap costs the protocol, not the user.** The refund is a second LayerZero message
   paid from `SwapRelay`'s native balance. At scale someone could submit orders they know will
   fail and drain the relay's gas buffer. Needs a fee that survives the failure path.

3. **Price staleness across message latency.** A cross-chain order is exposed to home-chain
   price movement for the full round trip, which on live chains is tens of seconds to minutes.
   `minAmountOut` is the only protection, so in practice users face a choice between wide
   slippage tolerance and frequent refunds. This is inherent to the design, not a bug, and it
   is the strongest argument for the market-maker fast path that was explicitly out of scope
   here.

4. **Sell-only.** A mirror user can sell the omnichain asset but cannot buy it, because buying
   requires the quote asset on the mirror chain — which the zero-liquidity premise forbids. The
   honest framing: this POC proves **cross-chain access to home-chain liquidity in one
   direction**. Buying needs either a bridgeable quote asset or a credit/intent mechanism.

5. **Address identity assumes EVM.** "Proceeds delivered to the user's address on the home
   chain" works because an EOA has the same address on every EVM chain. That breaks for
   smart-contract wallets, and it breaks completely for Solana — which is the stated reason
   LayerZero was chosen over Hyperbridge. A Solana mirror needs an explicit recipient mapping.

6. **No fee-bump retry.** The gas *limit* problem is fixed, but a live transaction can still
   fail on price if the base fee moves between estimation and inclusion.

7. **Single owner key across all chains.** Every contract is owned by the deployer EOA. Fine for
   a POC, unacceptable for production.

---

## 7. Summary

| | |
|---|---|
| Core claim | **Proven**, on three mirror chains, with execution economics that decompose exactly |
| Deployment infra | 6 modules, fully config-driven, one command, no manual follow-up |
| Peer wiring | Automated, bidirectional, **read back and verified** on every link |
| Add-a-chain flow | **Confirmed** to reuse the same modules; verified by doing it on a live deployment |
| Validation | 5/5 scenarios passing from a clean deployment |
| Biggest gap | No timeout/refund for a stalled message — funds recoverable but never automatically |

The repo carries its own findings: `agents.md` for current state and architecture, `NOTES.md`
for the running log of what went wrong and why.
