# NOTES.md — nuances, gotchas, and things a future agent would otherwise rediscover the hard way

> Append-only running log. **Add entries as they happen, not retroactively from memory.**
> Every entry is dated and states which milestone it belongs to.
>
> Companion file: [`agents.md`](agents.md) — the current-state context file.

Format:

```
### [YYYY-MM-DD] <short title>
**Milestone:** <which one>
**What happened / what to know:** ...
**Why it matters / what breaks if ignored:** ...
```

---

### [2026-09-18] Environment has no deployer key or RPC credentials
**Milestone:** M0 — scaffold

**What happened / what to know:** The build environment has no `DEPLOYER_PRIVATE_KEY`, no
mnemonic, no RPC URLs, and no block-explorer API keys. Nothing can be broadcast to Base
Sepolia / Arbitrum Sepolia / Optimism Sepolia from here as-is.

**Why it matters / what breaks if ignored:** The validation suite is therefore built to run
against a **local three-chain environment** (three `anvil` instances standing in for the home
chain and the two mirrors) with **real LayerZero V2 `EndpointV2` contracts deployed to each**,
plus a local packet-delivery relayer that performs the same verify → `lzReceive` sequence that
LayerZero's DVN + Executor perform in production. This is a real end-to-end exercise of the
contracts and the infra, not a mock.

The deliberate design consequence: **chain identity is config, never code.** Switching to live
testnets is a config file swap plus a funded key — no source changes. That constraint is what
keeps the infra honest about being reusable, so treat it as a feature rather than a
limitation. What a local run *cannot* produce is real-world DVN latency and real gas prices;
those numbers must be re-measured on live testnets before any production claim.

---

### [2026-09-18] `--legacy-peer-deps` is required to install the LayerZero stack
**Milestone:** M0 — scaffold

**What happened / what to know:** `npm install` of `@layerzerolabs/oft-evm` alongside
`@layerzerolabs/test-devtools-evm-foundry` fails peer-dependency resolution on npm 10 without
`--legacy-peer-deps`. The LayerZero packages declare narrow peer ranges on each other and on
`@openzeppelin/contracts` that don't co-resolve cleanly.

**Why it matters / what breaks if ignored:** A fresh clone that runs a bare `npm ci` will
fail. Resolved versions actually used here:

| Package | Version |
|---|---|
| `@layerzerolabs/oft-evm` | 3.2.1 |
| `@layerzerolabs/oapp-evm` | 0.3.3 |
| `@layerzerolabs/lz-evm-protocol-v2` | 3.0.168 |
| `@layerzerolabs/lz-evm-messagelib-v2` | 3.0.168 |
| `@layerzerolabs/test-devtools-evm-foundry` | 6.0.3 |
| `@openzeppelin/contracts` | 5.6.1 |

`@layerzerolabs/oft-evm` v3 line requires **OpenZeppelin v5** (not v4) — `Ownable` takes an
initial-owner constructor argument in v5, which changes every contract constructor signature
in this repo.

---

### [2026-09-18] USDC is deliberately not omnichain — this shapes the entire return leg
**Milestone:** M0 — design

**What happened / what to know:** The spec fixes USDC as a plain ERC-20 on the home chain
**only**, because it represents the pairing asset that lives where the real liquidity pool
lives. That means the *output* of a mirror-initiated sell (USDC) has no bridging capability.

Three options were considered for how the mirror chain "receives the result":

1. **Receipt + home delivery** — USDC goes to the user's address on the home chain; an
   authenticated LayerZero settlement receipt returns to the mirror chain carrying the exact
   `amountOut` and status. ✅ **Chosen.**
2. **Make USDC an OFT too** — output physically bridges back as tokens. ❌ Rejected: directly
   contradicts the "USDC on home chain ONLY" requirement, and quietly weakens the
   zero-liquidity claim by putting a second bridgeable asset on the mirror.
3. **Home-chain escrow + explicit claim** — ❌ Rejected for this POC: more state, extra user
   step, proves nothing additional.

**Why it matters / what breaks if ignored:** The phrase "sends result back via OFT send()" in
the original spec reads literally as *tokens* coming back. With USDC non-bridgeable, the only
asset that *can* ride OFT `send()` back to the mirror is TokenizedStock itself. So the infra
uses OFT `send()` for the **refund/failure path** (locked TokenizedStock returns to the mirror
chain) and an authenticated LayerZero message for the **success path** receipt. Anyone reading
the original spec and expecting USDC to land on Arbitrum Sepolia will be confused otherwise.

The user's EOA address is the same across all EVM chains, so "delivered to the user's address
on the home chain" needs no extra identity mapping today. **That assumption breaks for Solana**
(different key format, different address space) and breaks for smart-contract wallets, which
are *not* guaranteed to share an address across chains. Flagged in `agents.md` §9.

---

### [2026-09-18] Peer wiring is directed, and "bidirectional" means two separate writes
**Milestone:** M3 — peer wiring

**What happened / what to know:** `setPeer(eid, peer)` sets *one direction only*. A path from
Base Sepolia to Arbitrum Sepolia needs `setPeer` called on the Base contract naming Arbitrum's
address **and** on the Arbitrum contract naming Base's address. Setting one and assuming the
other exists produces a deployment where sends succeed and deliveries silently fail.

The infra therefore treats the wiring as a set of *directed* links: the OFT uses a full mesh
(n·(n−1) links — 6 for three chains) so the token can move between mirrors directly, and the
relay pair uses a star with the home chain as hub (2·m links — 4 for two mirrors), since a
SwapRequest only ever talks to the home SwapRelay.

**Why it matters / what breaks if ignored:** Every `setPeer` is followed by reading `peers(eid)`
straight back off the chain and comparing before moving to the next link. This is not
defensive padding — an unverified peer produces a deployment that looks complete and then drops
messages at runtime, which is expensive to debug and nearly free to prevent. The read-back also
catches the redeploy case: if a peer slot is already non-zero and different, the infra logs a
warning that it is repointing a live path rather than silently overwriting it.

---

### [2026-09-18] Local chain ids and eids deliberately match the real testnets
**Milestone:** M1–M3

**What happened / what to know:** `config/localnet.json` uses the *real* chain ids (84532,
421614, 11155420) and the *real* LayerZero eids (40245, 40231, 40232) even though the chains
are local anvil instances.

**Why it matters / what breaks if ignored:** It makes the reusability claim checkable with a
diff instead of a promise. `diff config/localnet.json config/testnet.json` differs only in
`name`, `rpcUrl`, `lzEndpoint`, `explorer`, and the Uniswap `factory` field. Token parameters,
pool parameters, relay gas parameters and the entire chain topology are identical, and **no
module code differs between a local run and a live run**.

`Chain.preflight()` asserts that the chain id the RPC reports matches the chain id in config
before anything is deployed, so a copy-pasted RPC URL pointing at the wrong network is refused
up front rather than discovered after contracts are live on it.

---

### [2026-09-18] Anvil needs `--disable-code-size-limit` for Uniswap's position manager
**Milestone:** M4 prep

**What happened / what to know:** `NonfungiblePositionManager`'s creation bytecode is ~25 KB
and its runtime code sits right at the EIP-170 24,576-byte limit. Deploying it to a default
anvil instance is marginal, so `infra/localnet.ts` starts every node with
`--disable-code-size-limit`.

**Why it matters / what breaks if ignored:** The failure mode is a deployment revert with no
useful message, which reads like a CrossStock bug and is not one. The flag affects only the
local environment — live chains already host these contracts, and the infra uses the canonical
factory address from config there.

---

### [2026-09-18] M4 FAILURE: pool seeding ran out of gas, non-deterministically
**Milestone:** M4 — pool deployment (failure state, committed before the fix)

**What happened / what to know:** `NonfungiblePositionManager.mint()` reverted with `OutOfGas`
— but only on the *second* deployment run, against the same code that had succeeded on the
first. The trace shows the mint fully executing: tokens transferred into the pool, `Mint`
emitted with `amount0 = 99999999999999999926594`, `amount1 = 14998807794277`, position
recorded — and then running out of gas on the tail of the call. Gas used: 606,552.

Root cause is gas *estimation*, not the mint itself. `viem`'s `simulateContract` →
`writeContract` path does not attach a gas limit, so the gas comes from `eth_estimateGas`,
whose binary search lands on a figure that is exactly sufficient for the simulated state and
marginally insufficient once mined. An NFT mint whose cost is dominated by cold SSTOREs sits
right on that boundary, which is why it passed once and failed once with no code change.

The run-to-run difference that exposed it: **token ordering flipped between runs.** Uniswap
orders `token0`/`token1` by address, and redeploying produced a tAAPL address lower than
USDC's where the first run produced the reverse. Different ordering means different storage
slots written and a slightly different gas profile. Both orderings are correct; only one was
over the estimation cliff.

**Why it matters / what breaks if ignored:** This is a latent failure in *every* write the
infra makes, not just the mint. Any deployment step could land on the wrong side of an
estimate and revert after doing real work — which is the worst possible failure mode for a
deployment pipeline, because the chain state is half-changed and the manifest says the step
failed. Live chains make this worse, not better: estimates there contend with real mempool
dynamics and fluctuating base fees.

Two lessons worth carrying to production:

1. **Never rely on a bare gas estimate for a deployment write.** Fixed in the next commit by
   estimating explicitly and applying a safety multiplier in `Chain.write()` / `Chain.deploy()`.
2. **Token ordering is not stable across deployments.** Anything that depends on which asset is
   `token0` must derive it from the addresses at runtime, never cache it, and never assume a
   redeploy reproduces the previous ordering. `infra/lib/uniswap.ts` already computes ordering
   from the addresses — this incident is what confirms that was necessary rather than
   fastidious.

---

### [2026-09-18] M4 FIX: explicit gas estimation with a 1.4x margin on every write
**Milestone:** M4 — pool deployment (the fix)

**What happened / what to know:** `Chain.deploy()` and `Chain.write()` now estimate gas
explicitly and apply a 1.4x margin, capped at 90% of the block gas limit. Previously they let
`writeContract` fall back to a bare `eth_estimateGas`.

**Why it matters / what breaks if ignored:** Verified against both token orderings, since the
ordering is what flipped the cost over the cliff. Three consecutive fresh deployments:

| Run | token0 | Pool seeded | mint gas used |
|---|---|---|---|
| 1 | tAAPL | ✅ | 603,752 |
| 2 | USDC | ✅ | 603,528 |
| 3 | USDC | ✅ | 603,528 |

Run 1 is the ordering that previously failed. The actual gas used barely differs between
orderings (224 gas) — which confirms the estimate was the problem, not the call. The margin
applies to *every* infra write, so the class of bug is closed rather than the one instance.

One thing this does not fix: on a live chain, a transaction can still fail on *price* rather
than gas limit, if the base fee moves between estimation and inclusion. That needs retry
logic with fee bumping before this is production-safe. Not implemented — flagged in
`agents.md` §9.

---

### [2026-09-18] Pool reserves do not exactly match the configured seed amounts
**Milestone:** M4 — pool deployment

**What happened / what to know:** Config asks for 100,000 tAAPL and 15,000,000 USDC. The pool
ends up holding 99,999.999999999999926594 tAAPL and 14,998,807.794277 USDC.

**Why it matters / what breaks if ignored:** This is correct Uniswap V3 behaviour, not a bug,
and it will look like one to whoever reads the manifest next. A V3 position is defined by a
liquidity value `L` over a tick range, not by two token amounts. The position manager takes
the desired amounts as *maxima*, computes the largest `L` that both can support, and pulls only
what that `L` actually requires — here, the tAAPL side binds and ~1,192 USDC is left unused.

Practical consequences: don't assert exact reserve equality in tests, and read the pool's real
reserves from the manifest (module 4 records what the chain reports, not what config asked
for) rather than recomputing them from the config figures.

---

### [2026-09-18] Validation 1: bridge works; OFT shared decimals quantise every transfer
**Milestone:** V1 — direct bridge sanity check

**What happened / what to know:** 1,000 tAAPL moved Base Sepolia → Arbitrum Sepolia. Home
debited exactly 1,000, mirror credited exactly 1,000, aggregate supply across all three chains
unchanged at 1,000,000. Latency 4,100 ms locally, send gas 120,443, LayerZero fee 1e14 wei
(the local message library's configured flat base fee — **not** a real-world figure).

The important nuance is `sharedDecimals`. A LayerZero OFT bridges amounts at 6 decimals of
precision regardless of the token's own decimals. For an 18-decimal token that means the
bottom **12 decimal places are silently dropped** on every `send()`: the OFT debits only the
quantised amount and leaves the remainder in the caller's balance.

Two places this shows up concretely:

- The home deployer balance reads `900000.000000000000073406 tAAPL` rather than a round number.
  That `0.000000000000073406` is dust left over from pool seeding, not a rounding error.
- `SwapRequest.requestSwap()` must return the dust to the user. If it did not, every request
  would strand a sliver of the user's input in the contract forever. It reads
  `oftReceipt.amountSentLD` from the send and refunds `amountIn - amountSentLD` explicitly,
  and records the *sent* amount as the request's `amountIn` so the receipt reconciles.

**Why it matters / what breaks if ignored:** Any code that assumes `amountSent == amountRequested`
across an OFT hop is wrong, and the discrepancy is small enough to pass casual testing and
then accumulate. Never compute an expected destination balance by adding the requested amount;
read what the OFT reports it actually sent.

---

### [2026-09-18] ✅ CORE PROOF: zero-liquidity cross-chain trade works end to end
**Milestone:** V2 — full swap-relay round trip

**What happened / what to know:** A user on Arbitrum Sepolia — a chain with no pool, no quote
asset, no market maker and no local liquidity of any kind — sold 100 tAAPL and received
14,940.845155 USDC on Base Sepolia. One transaction, submitted on the mirror chain, paying
0.0101 ETH in LayerZero fees. Round trip 4,129 ms.

The numbers decompose exactly, which is what makes this a proof rather than a demo:

| Component | Value |
|---|---|
| Gross at spot (150.000000) | 15,000.000000 USDC |
| Less 0.30% pool fee | 14,955.000000 USDC |
| Actual received | 14,940.845155 USDC |
| Residual = price impact | 14.154845 USDC (0.0944%) |
| Trade as share of base reserve | 0.1000% |

Price impact of 0.0944% against a trade worth 0.1000% of the base reserve is exactly what
Uniswap V3 tick math produces for a swap of that size. The pool's spot price moved
150.000000 → 149.716186 and its base reserve moved by exactly the 100 tAAPL sold. A mocked or
shortcut execution would not reproduce that relationship.

**Why it matters / what breaks if ignored:** The assertions deliberately do not trust the
contracts' own reporting. The scenario cross-checks four independent sources: the settlement
receipt the mirror chain received, the user's actual USDC balance change on the home chain,
the pool's base reserve delta, and the pool's spot price movement. The receipt matching the
balance matters most — a relay that reported a number it had not actually delivered would pass
a weaker test.

Design points confirmed by this run:

1. **Coupling tokens to the instruction works.** The order rides as the `composeMsg` of the OFT
   `send()`, so the relay physically cannot be asked to execute an order whose funds have not
   arrived. No separate "did the money land" check is needed.
2. **One user transaction covers the whole round trip.** The return-leg fee is pre-paid via the
   `lzCompose` value in the executor options, forwarded to SwapRelay, and spent there. The user
   never touches the home chain.
3. **The user's EOA address is the same on both chains**, so "delivered to the user's address on
   the home chain" needs no identity mapping today. This breaks for Solana and for
   smart-contract wallets — see `agents.md` §9.

---

### [2026-09-18] Validation 3: bad slippage refunds the user in full, on the mirror chain
**Milestone:** V3 — failure case, bad slippage

**What happened / what to know:** A request demanding 2x the spot price (unsatisfiable at any
trade size) was submitted from Arbitrum Sepolia. Exact behaviour observed:

1. The user was debited 50 tAAPL on the mirror chain at submit time, as normal.
2. The OFT packet delivered the 50 tAAPL to `SwapRelay` on Base Sepolia.
3. `SwapRelay.lzCompose` called the router, which reverted on `amountOutMinimum`.
4. The `try/catch` around the swap caught it, cleared the router allowance, and bridged the
   50 tAAPL **back** to Arbitrum Sepolia with a `RefundNotice` as the composeMsg.
5. `SwapRequest.lzCompose` marked the request `REFUNDED` (reason `1` = SLIPPAGE) and
   transferred the tokens to the user.

Measured: net token change **0**, USDC received **0**, pool base reserve change **0**, refund
latency 4,129 ms.

**Why it matters / what breaks if ignored:** Two implementation details are what make this
safe, and both are easy to get wrong:

1. **The swap is wrapped in `try/catch` rather than allowed to revert the whole `lzCompose`.**
   If the compose reverted, the tokens would sit in `SwapRelay` and the message would be stuck
   in a retryable-but-failing state forever — the user's funds would be recoverable only by
   manual intervention. Catching converts a failed swap into a refund the protocol performs by
   itself.
2. **The router allowance is cleared in the catch branch before the refund is dispatched.** A
   leftover allowance over tokens that are about to be bridged away is exactly the kind of
   dangling approval that becomes an exploit later.

Also worth noting: the refund costs a *second* LayerZero message, paid from SwapRelay's native
balance. A failed swap is therefore more expensive for the protocol than a successful one, and
the user does not pay for it. At scale that is a griefing vector — someone could submit orders
they know will fail and drain the relay's gas buffer. Not addressed in this POC; flagged in
`agents.md` §9.

---

### [2026-09-18] viem caches `getBlockNumber()` — this silently broke packet delivery
**Milestone:** V4 — found while building the stalled-message scenario

**What happened / what to know:** The relayer intermittently failed to deliver packets that
were plainly on chain. A scan would report "nothing new" for a block range that contained a
`PacketSent`, and the same packet would be picked up fine a few seconds later.

Cause: **`viem`'s `getBlockNumber()` is cached.** The default `cacheTime` is the client's
polling interval — 4 seconds. The relayer compares the chain head against its scan cursor to
decide what to scan; with a stale head it concluded `head <= cursor` and skipped the range
entirely. The cursor then advanced past those blocks on the next scan, so the packets were
never revisited.

This is a nasty failure mode:

- It is **timing-dependent**. Anything that waits a few seconds makes it vanish, so it
  disappears under a debugger and reappears in fast back-to-back operations.
- It is **silent**. No error, no revert — just a delivery that does not happen.
- It looked exactly like a CrossStock protocol bug. Hours could go into the contracts before
  suspecting the RPC client.

**Why it matters / what breaks if ignored:** Fixed by constructing every public client with
`cacheTime: 0` in `infra/lib/chains.ts`. That is deliberately applied to **all** infra clients,
not just the relayer's: a deployment pipeline and a relayer both make decisions from chain
state, and neither should ever act on a cached view of it. The small extra RPC load is worth
far more than the debugging time.

Generalisable lesson for anyone building on this: when an on-chain tool behaves
non-deterministically in a way that "waiting fixes", suspect the client library's caching
before suspecting the chain.

---

### [2026-09-18] Test isolation: a scenario that misconfigures a contract must restore it
**Milestone:** V4 — stalled-message scenario

**What happened / what to know:** Scenario 4 deliberately sets `homeComposeGas` to 30,000 to
starve the composed call. An early version restored it at the end of the happy path. A run that
was interrupted mid-scenario therefore left the deployment misconfigured, and the *next* run's
Phase A inherited the broken gas setting and failed in a way that looked unrelated.

**Why it matters / what breaks if ignored:** The restore now lives in a `finally` block that
wraps the whole scenario, so an interruption cannot leave a deployment in a state that
misleads the next person. Worth generalising: any validation step that mutates deployment
configuration owns restoring it, and owns restoring it on the failure path too.

Related, and visible in the run output: `SwapRelay` still held tokens stranded by those earlier
interrupted runs. That residue is a real illustration of the scenario's own finding — nothing
sweeps stranded funds automatically — but as *test* state it is noise. Run the validation suite
against a fresh deployment when the numbers matter.

---

### [2026-09-18] CORRECTION: earlier latency figures were measuring the viem cache
**Milestone:** V1–V3 (numbers superseded)

**What happened / what to know:** Every latency figure recorded before the `cacheTime: 0` fix
is wrong. Scenarios 1–3 reported ~4,100 ms round trips. That number was almost entirely the
relayer waiting out viem's 4-second `getBlockNumber` cache before it would scan again — it was
measuring the bug, not the protocol.

Corrected figures, same code, clean deployment, after the fix:

| Scenario | Before (cached) | After (correct) |
|---|---|---|
| 1 — direct bridge | 4,100 ms | **56 ms** |
| 2 — swap round trip | 4,129 ms | **102 ms** |
| 3 — bad-slippage refund | 4,129 ms | **97 ms** |
| 4 — recovery after retry | — | **28 ms** |
| 5 — second mirror | — | **70 ms** |

**Why it matters / what breaks if ignored:** The commits for V1–V3 quote the old numbers and
are left as they are, because rewriting them would erase the fact that the measurement was
wrong for a while — which is itself the useful part.

Two things follow, and the second matters more than the first:

1. **These are local-anvil numbers and say nothing about production latency.** Real LayerZero
   latency is dominated by DVN attestation and destination block times, typically tens of
   seconds to minutes across testnets. What the local figures *do* establish is that the
   protocol adds no meaningful overhead of its own: the round trip is bounded by message
   transport, not by anything CrossStock does.
2. **A measurement harness can be the thing under test.** The 4,100 ms figure was stable,
   plausible and repeatable, which is exactly why it went unquestioned. Treat suspiciously
   round numbers that match a library's default timing constant as a red flag.

---

### [2026-09-18] Validation 5: per-chain wiring generalises to a second mirror
**Milestone:** V5 — multi-mirror check

**What happened / what to know:** The core proof was repeated against Optimism Sepolia, the
second mirror, using scenario 2's code verbatim with a different chain key. Side by side:

| | Arbitrum Sepolia | Optimism Sepolia |
|---|---|---|
| Sold | 100 tAAPL | 100 tAAPL |
| Received | 14,940.845155 USDC | 14,898.490980 USDC |
| Spot before | 150.000000 | 149.574580 |
| Effective price | 149.408452 | 148.984910 |
| Slippage | 0.3944% | 0.3942% |
| `requestSwap` gas | 338,666 | 338,666 |
| LayerZero fee | 0.0101 ETH | 0.0101 ETH |
| Latency | 102 ms | 70 ms |

The absolute USDC figures differ only because the second trade executes against a pool the
first trade already moved — the spot price had fallen from 150.000000 to 149.574580. Slippage
is identical to four decimal places, and gas is identical to the wei.

**Why it matters / what breaks if ignored:** This is the check that catches a pipeline being
*accidentally correct for the first chain it was tested against*. The realistic ways to get
that wrong are all cheap to introduce and invisible with one mirror:

- caching an address from the first loop iteration and reusing it,
- writing a peer in one direction and assuming the reverse,
- calling a per-chain setter (`setReturnGas`, `setGasParams`) once instead of per chain,
- deriving the home eid from "whichever chain isn't this one".

Identical gas on both mirrors is the strongest single signal: the same code path executed, with
the same storage-write pattern, against a chain the infra had never run a swap on.

Scenario 5 deliberately calls scenario 2 rather than duplicating it. If the second chain had
needed its own test code, the infra would not actually have been generalising — the reuse is
part of the assertion, not a convenience.

---

### [2026-09-18] "Add a mirror chain to an already-launched token" — made to work, then verified
**Milestone:** M7 — incremental deployment

**What happened / what to know:** The brief asks whether a future "add a new mirror chain"
flow would reuse the mirror-deployment and peer-wiring modules. Checked rather than assumed —
and the honest first answer was **no**.

Modules 0, 1, 2, 4 and 5 deployed unconditionally. Re-running the pipeline with one extra chain
in the config would have deployed a *second* home-chain token and a *second* pool, forking the
supply and orphaning the live one. Module 3 (peer wiring) was already idempotent, because it
reads each peer back before writing.

Fixed by making every module reuse-first via `infra/lib/reuse.ts`. The manifest is treated as a
*claim*, not the truth: an address is reused only if there is actually code at it on that chain,
which catches a manifest left over from a chain that has since been reset.

Verified by adding a fourth chain (Polygon Amoy, eid 40267) to an already-deployed set and
re-running the same pipeline with no flags:

| | Before | After |
|---|---|---|
| Home `TokenizedStock` | `0x75c6…1135` | `0x75c6…1135` — **unchanged** |
| Pool | `0xF8dd…A648` | `0xF8dd…A648` — **unchanged** |
| Pool liquidity `L` | 1288875159409035126 | 1288875159409035126 — **not re-seeded** |
| `SwapRelay` | existing | reused |
| Peer links | 10, all verified | 18, all verified |
| Chains | 3 | 4 |

Then the core proof was run against the newly added chain: 100 tAAPL sold from Polygon Amoy →
**14,842.298327 USDC** delivered on Base Sepolia, slippage 0.3941%, `requestSwap` gas 338,666 —
identical to the gas on both original mirrors.

**Why it matters / what breaks if ignored:** This is the flow an issuer actually performs
repeatedly; a launch happens once. Two specific traps are now closed, and both would have been
silent:

- **Re-seeding the pool.** An incremental run must not pull more liquidity from the deployer or
  move the home chain's price. Module 4 now returns early on an existing pool and only refreshes
  the reserve figures it reports.
- **Re-funding the relay buffer.** Module 5 funds `SwapRelay`'s native buffer only on first
  deployment, so repeated runs do not quietly drain the deployer's gas.

One caveat worth carrying forward: the incremental run rewrites `setReturnGas` for every mirror
and re-checks every peer link, so cost grows with the size of the existing chain set rather than
with the number of chains being added. Harmless at four chains; worth making delta-only before
this runs against a large set.

---

### [2026-09-18] Toolchain trim: forge-std removed, Foundry is compile-only here
**Milestone:** final

**What happened / what to know:** `forge-std` was installed early out of habit and never used —
this repo has no Foundry tests. It was vendored with `forge install --no-git`, which copies the
files in rather than adding a submodule, so 68 files of someone else's repo had been committed.
Removed, along with its remapping and the `lib` entry in `foundry.toml`.

**Why it matters / what breaks if ignored:** Worth knowing the division of labour here, because
it is not the usual Foundry layout:

- **Foundry is used only to compile.** `forge build` produces the artifacts in `out/`, and
  nothing else in the toolchain touches it.
- **All orchestration and all testing is TypeScript** (`infra/`), reading those artifacts via
  `infra/lib/artifacts.ts`.

That split is deliberate. Foundry tests run in a single EVM instance, which cannot represent
three independent chains with their own endpoints, their own block production and a real
off-chain relayer between them — and that separation *is* the thing under test. A Foundry test
using `TestHelperOz5` would have proven the contracts work; it could not have proven the
deployment infrastructure works across a chain set.

Consequence for anyone adding tests: `forge test` will find nothing. Add contract-level unit
tests under `test/` with `forge-std` reinstalled if you want them, but keep cross-chain
behaviour in `infra/validation/`, where it exercises the real deployment.
