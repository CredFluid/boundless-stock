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

---

### [2026-09-19] DIRECTION CORRECTION: the POC was proving the wrong flow
**Milestone:** M8 — symmetric buy/sell

**What happened / what to know:** Everything up to this point proved the **sell** direction: a
user holding the stock on a mirror chain sells it, and the USDC proceeds land on the *home*
chain. The intended flow is the opposite and considerably more useful — a user holding **USDC
on a mirror chain buys the stock and receives it there**.

Why it went wrong is worth recording, because the mistake was structural rather than careless.
The brief specified USDC as a plain ERC-20 on the home chain **only** — "the pairing asset that
lives where the real liquidity pool lives". Taken literally, that forces sell-only: if the quote
asset cannot exist on a mirror chain, a user there has nothing to pay with, so the only thing
they can send is the stock. The clarifying question that was asked about the return leg was
already framed inside that assumption, so answering it could not surface the problem. **The
lesson: when a clarifying question has a hidden premise, the answer confirms the premise rather
than testing it.** The premise itself should have been the question.

**Why it matters / what breaks if ignored:** The fix is that the quote asset becomes omnichain
too. That contradicts one line of the original brief, deliberately, and it changes nothing about
the core claim — but the claim has to be stated precisely:

- **What a mirror chain still does not have:** a pool, a market maker, reserves, a price, or any
  way to discover one. `assertNoLocalMarket()` checks this at run time in every scenario.
- **What it does have:** token contracts, and users holding balances in their own wallets. A
  wallet balance is not liquidity. Nobody on the mirror chain quotes a price or takes the other
  side of the trade.

Arguably the claim is now *stronger*: the user buys an asset that has no market whatsoever on
their chain, and it arrives in their wallet there.

One pleasing consequence: the original spec's phrase "sends result back via OFT `send()`" finally
makes sense. In the buy direction the output **is** the omnichain stock, so it genuinely bridges
back as tokens. In the sell direction the output was USDC, which could not travel — which is
exactly why the earlier build had to return a receipt instead.

Both directions are now supported and symmetric, and scenario 6 exists to check that "symmetric"
is true of the code and not just of the prose.

---

### [2026-09-19] `OFT` only really supports 18-decimal tokens
**Milestone:** M8 — symmetric buy/sell

**What happened / what to know:** Making USDC an OFT with its usual 6 decimals does not work
with LayerZero's `OFT` base contract. `OFT`'s constructor passes `decimals()` into `OFTCore`
from its *initializer list*, which runs before any derived constructor body. A subclass that
stores decimals in a variable and overrides `decimals()` therefore returns **0** at that moment,
and `OFTCore` computes `10 ** (0 - 6)`, which underflows and reverts.

Fixed with `src/core/OmniToken.sol`, which subclasses `OFTCore` directly and passes decimals in
explicitly. `_debit` / `_credit` are byte-for-byte the same burn-on-source / mint-on-destination
logic as `OFT`; nothing about the cross-chain semantics changes. `TokenizedStock` is now just a
named `OmniToken`, so there is one token implementation rather than two.

**Why it matters / what breaks if ignored:** The failure is a constructor revert with no useful
message, and the obvious workaround — overriding `decimals()` — is exactly the thing that does
not work. Anyone adding a non-18-decimal omnichain asset will hit this.

A pleasant side effect: `sharedDecimals()` is 6, so a **6-decimal token bridges with a conversion
rate of exactly 1 and loses nothing to dust**. It is the 18-decimal stock that quantises away its
bottom 12 decimal places on every hop. So on a buy the money crosses exactly and only the
delivered stock is subject to dust; on a sell it is the reverse. `SwapRelay` tracks the
remainder in `dustAccrued` rather than silently absorbing it.

---

### [2026-09-19] An OFT's `totalSupply()` is per chain, not global
**Milestone:** M9 — supply reporting

**What happened / what to know:** The first thing an issuer notices after users start trading
is that the home chain's `totalSupply()` no longer matches what they minted. That is correct
behaviour and reads like a bug, so `infra/supply.ts` exists to make it legible.

A bridge **burns on the source chain and mints on the destination**. Each chain's
`totalSupply()` is therefore just the portion currently sitting there. Only the **sum across
the whole chain set** is invariant. Measured after running all six validation scenarios:

| Chain | tAAPL | USDC |
|---|---:|---:|
| Base Sepolia (home) | 998,781.262829 | 49,990,995.953509 |
| Arbitrum Sepolia | 1,119.395112 | 9,004.046491 |
| Optimism Sepolia | 99.342059 | 0 |
| **Sum** | **1,000,000.000000** | **50,000,000.000000** |

Both sums are exactly what was minted at launch. Nothing was created or destroyed — supply
moved.

**Why it matters / what breaks if ignored:** Three consequences worth carrying:

1. **Never treat one chain's `totalSupply()` as the token's supply.** Any supply cap, any
   circulating-supply figure and any accounting check has to sum across the set. A naive
   home-chain read understates it, and understates it by more the more successful the product is.
2. **The invariant genuinely breaks while a message is in flight.** Validation scenario 4
   measured the aggregate dipping from 1,000,000 to 999,975 during a stall — burned on the
   source, not yet minted on the destination. Any monitor that alerts on "sum != minted" will
   fire spuriously on every in-flight message, so it needs a tolerance or a pending-message feed.
3. **The pool's holdings are separate from supply.** The pool held 99,781.26 tAAPL after
   trading, which is a *balance on the home chain*, not a share of supply. Reconciled against
   the trades: 100,000 seeded, minus 198.95 bought by the two mirror users, minus ~40 from
   scenario 4's two buys, plus 20 sold back — matching the measured figure.

---

### [2026-09-19] The coverage assertion caught the invariant suite passing vacuously
**Milestone:** M10 — invariant and fuzz tests

**What happened / what to know:** The first version of `SupplyInvariant` reported six passing
invariants over 4,096 calls with zero reverts. It was proving nothing. **Not a single bridge
send had succeeded** — aggregate supply never moved off its genesis value, so
`aggregateSupply() + inFlight == MINTED` was comparing `1,000,000 + 0` against `1,000,000`
every time.

Two separate causes, both silent:

1. **`vm.prank` rewrites `msg.sender`, not who pays `{value:}`.** The handler funded the
   *actor* and then called `token.send{value: fee}` under a prank. The ETH comes from the
   **handler contract**, which had a zero balance, so every send reverted into the handler's
   `try/catch` and returned `false`. Fixed by dealing the handler, not the actor.
2. **The whole supply started on one chain.** With three chains, two thirds of randomly chosen
   source chains had nothing to send. The fixture now bridges a third of supply onto each
   mirror through the real mechanism before fuzzing begins.

**Why it matters / what breaks if ignored:** The only reason this was caught is
`afterInvariant()` asserting that the fuzzer actually reached the state under test:

```solidity
assertGt(handler.ghostSent(), 0, "fuzzer never bridged anything - invariants passed vacuously");
assertGt(handler.maxInFlight(), 0, "fuzzer never left a message in flight");
```

Without it, the suite would have sat in the repo looking like strong evidence and providing
none. **A passing invariant is only evidence if you can also show the campaign reached the
interesting state.** Every invariant suite should carry a coverage assertion of this kind, and
a negative control — `SupplyNegativeControl` deliberately inflates supply and asserts the
property notices.

Post-fix, every campaign reaches 60,000–82,000 tokens simultaneously in flight, which is the
window the whole exercise is about.

---

### [2026-09-19] The relay invariant fuzzer found two real bugs, both around bridge precision
**Milestone:** M10 — relay accounting invariants

**What happened / what to know:** Neither bug was reachable through the TypeScript validation
suite, because both need trade sizes or prices no sensible scenario would pick. Both were found
within minutes of the invariant campaign running.

**Bug 1 — zombie requests from sub-quantum inputs.** Caught by
`invariant_requestStatesAreCoherent` ("a request must record a non-zero input").

An OFT bridges at 6 shared decimals, so an 18-decimal asset cannot move anything smaller than
`1e12`. `SwapRequest._submit` checked `_amountIn != 0` but then recorded `amountSentLD`, which
is the amount *after* dust removal — and that can be zero. The result: a request created with
`amountIn == 0`, a zero-amount packet sent to the home chain, `_returnToMirror` returning early
on a zero amount, and therefore **no settlement ever coming back**. The request sits `PENDING`
forever. The user loses nothing (their dust is returned) but the record is a permanent zombie.

Fixed by rejecting any trade whose input bridges to zero, with
`AmountBelowBridgeableMinimum(amountIn, quantum)` so the caller learns the actual floor.

**Bug 2 — a fill that delivers nothing.** Caught by `invariant_fillsDeliverSomething` ("a FILLED
request must have delivered a non-zero amount"). This one loses money.

When a swap's *output* was smaller than one bridgeable unit, the return send quantised it to
zero. The user's input had already been consumed by the venue, and a settlement claiming
`FILLED` arrived carrying nothing. Reproduced exactly: a user spent 1,000 USDC, the request was
marked `FILLED`, `amountOut` was `0`, and zero tokens reached their wallet.

Fixed in two layers:

1. **`SwapRelay._settle` now raises `amountOutMinimum` to at least one bridgeable unit.** A
   swap that could only produce an undeliverable amount is rejected *by the venue*, which
   routes into the existing refund path and returns the user's money. This is the real fix —
   it converts a silent loss into a clean refund.
2. **`_returnToMirror` strands anything sub-quantum** rather than sending a settlement that
   claims a delivery it cannot make. A belt-and-braces net for any path that gets past (1).

**Why it matters / what breaks if ignored:** The general lesson is that **precision loss at a
protocol boundary is not a rounding nuisance, it is a correctness boundary.** Both bugs come
from the same root: code treated "the amount the user asked for" and "the amount that can
actually cross" as interchangeable. Anywhere those two differ needs an explicit decision about
what happens to the difference.

Worth noting what the fix does *not* solve: a sub-quantum amount recorded in `stranded` is not
recoverable by `retryReturn`, because it will never become bridgeable. It needs a home-chain
claim path — which is the same gap as the stalled-message finding, and is recorded in
`agents.md` §9.

---

### [2026-09-19] Three ways an invariant campaign can pass while testing nothing
**Milestone:** M10 — relay accounting invariants

**What happened / what to know:** Getting the relay campaign to genuinely exercise the system
took four separate fixes, each of which produced a green or near-green suite that was proving
much less than it appeared to.

1. **`bool` parameters in a handler are almost always `true`.** Foundry fuzzes a `bool` from a
   random byte and treats anything non-zero as true — so `setVenueFailing(bool)` was true
   roughly 255 times in 256. The venue was permanently broken and no trade ever filled. Handler
   switches now take a `uint256` seed and are weighted explicitly (`bound(seed, 0, 4) == 0` for
   ~20%).
2. **An unbounded `minAmountOut` makes every order unsatisfiable.** Bounding it over the whole
   `uint256` range meant every single order was rejected on slippage. It is now anchored to
   what the venue would actually pay and ranged 0–150% of that, so roughly a third are rejected
   and the rest fill.
3. **A single `rate` cannot price both directions.** The first mock router applied one
   `num/den` to every swap, which cannot be right for buys and sells simultaneously — a rate
   calibrated for buys made sells absurd. The router is now direction-aware.
4. **A stalled compose must stay retryable.** The fixture originally read `ComposeSent` from the
   logs of the delivering call, so `deliverPacketsOnly()` discarded the compose permanently and
   every stalled order was stuck for good. LayerZero actually keeps the compose queued, so the
   fixture now keeps its own pending queue that a later `deliverAll()` drains.

**Why it matters / what breaks if ignored:** Every one of these was invisible in the pass/fail
result. The only reason any of them surfaced is the `afterInvariant()` coverage assertions,
which fail the suite unless the campaign actually reached a fill, a refund *and* a stalled
compose:

```solidity
assertGt(handler.fillsObserved(), 0, "no trade ever filled - the success path was never tested");
assertGt(handler.refundsObserved(), 0, "no trade was ever refunded - the failure path was never tested");
assertGt(handler.callsStall(), 0, "the stalled-compose path was never exercised");
```

Treat those assertions as part of the invariant, not as decoration. A campaign reports 7,680
calls and zero reverts whether it is stress-testing the protocol or calling a broken venue
7,680 times.

---

### [2026-09-19] The base chain is genuinely selectable — verified by moving it
**Milestone:** M12 — base-chain portability

**What happened / what to know:** "Pick your base chain" is the product claim the infra exists
to serve, so it was checked by actually doing it rather than by reading the config schema.

`config/localnet-arb-home.json` promotes Arbitrum Sepolia to home and demotes Base Sepolia to a
mirror. Diff it against `config/localnet.json`: the only change is **which chain object sits in
`homeChain` versus `mirrorChains`** (and the `uniswap` block moving with the home role). No
module code differs.

Result — the pool was built on Arbitrum, and a user on Base Sepolia, now a mirror with no
market, bought against it:

| | Base as home (original) | Arbitrum as home |
|---|---|---|
| Pool lives on | Base Sepolia | Arbitrum Sepolia |
| User stands on | Arbitrum Sepolia | **Base Sepolia** |
| Spent | 15,000 USDC | 15,000 USDC |
| Received, on the mirror | 99.605634 tAAPL | **99.605634 tAAPL** |
| Cost vs spot | +0.3944% | +0.3959% |
| `buy()` gas | 351,514 | 351,540 |
| Peer links | 16/16 verified | 16/16 verified |

Identical to the token, with gas differing by 26 (deployment nonce ordering).

**Why it matters / what breaks if ignored:** Two real constraints sit behind the claim, and
neither is visible from the config:

1. **The home chain must be able to host the venue.** Module 4 deploys or uses Uniswap V3, so
   the home chain has to be EVM *and* have a V3 deployment (or permit deploying one). A chain
   with a different AMM needs a venue adapter behind `SwapRelay` — see `agents.md` §8.
2. **The home chain cannot be migrated after launch.** Reusing the pipeline promotes a chain
   cleanly on a *fresh* deployment, but there is no path that moves an existing pool, its
   liquidity and the relay from one chain to another. Choosing the base chain is a one-way
   decision today.

---

### [2026-09-19] Bring-your-own-token: adapting an existing ERC-20 instead of launching a new one
**Milestone:** M13 — adapter mode

**What happened / what to know:** The infra could previously only launch a *new* omnichain
token. An issuer whose tokenized stock already existed had no path in: an OFT **is** the token
contract and works by burn-and-mint, so an existing ERC-20 cannot become one.

Solved with LayerZero's `OFTAdapter`, wrapped as `OmniTokenAdapter`. Instead of replacing the
token, the adapter sits beside it, **locks** it on its home chain, and backs representations
minted on every mirror chain. Holders keep their balances and the token's address never changes.

Turned on with one config field:

```json
"token": { "name": "...", "symbol": "tAAPL", "decimals": 18, "existingToken": "0x..." }
```

`config/localnet-adapter.json` differs from `config/localnet.json` by exactly that line.

**Why it matters / what breaks if ignored:** Four things had to change, and only the first is
obvious:

1. **Module 1 gained an adapt mode.** It verifies there is code at the address and that the
   on-chain `decimals()` matches config — refusing rather than guessing, since every bridging
   calculation depends on it.
2. **Token and OFT handle are now separate everywhere.** `SwapRelay` and `SwapRequest` each
   take `(token, oft)` pairs. The pool is always traded in the *underlying*; messaging always
   goes through the *OFT*. `SwapRelay` derives trade direction from which OFT delivered, so
   that comparison had to move from the token address to the adapter address — it would
   otherwise reject every adapted delivery as an unexpected source.
3. **`approvalRequired()` is true for an adapter.** It pulls with `transferFrom` rather than
   burning, so both relay contracts now approve before `send()`. Without this the return leg
   reverts, and only on adapted deployments.
4. **Supply accounting had to be reformulated**, and this is the subtle one. An adapted token's
   `totalSupply()` on its home chain includes every coin that has never touched this system,
   while mirrors mint representations against the locked balance. Summing raw supplies
   double-counts: the first adapter-mode run failed with
   `aggregate stock supply changed 1000000 → 1000099.605634`, which was the harness being
   wrong, not the protocol.

   The fix conserves in both modes: **a chain's contribution is its `totalSupply()` minus
   anything locked in an adapter there.** Moving a token to a mirror locks it at home (home
   contribution falls) and mints it there (mirror contribution rises) by the same amount. A
   launched asset has no adapter, so the formula reduces to the plain sum it always was.

Constraints inherited from `OFTAdapter`, all documented on the contract: exactly one adapter
may ever exist per token (a second lockbox fractures supply), and transfers must be lossless —
**fee-on-transfer and rebasing tokens are explicitly out of scope** for this POC.

---

### [2026-09-19] Solana: environment verified, backend not built
**Milestone:** M14 — multi-VM foundation

**What happened / what to know:** Before writing any Rust, the environment was checked end to
end, because the cost of discovering a blocked toolchain after building a program is much
higher than the cost of checking first. Everything needed is available:

- `cargo build-sbf` 3.0.15 with platform-tools v1.51 — SBF programs can be built here.
- Solana devnet reachable.
- **LayerZero's real EndpointV2 clones onto a local validator and is executable there** —
  1,639,888 bytes under BPFLoaderUpgradeab1e. `npm run solana:up` does this reproducibly.

Two findings that would have cost real time if discovered later:

1. **`--clone-upgradeable-program` is required, not `--clone`.** A plain clone copies the
   account but not its programdata, giving something the loader refuses to execute.
2. **LayerZero's `oapp` crate is not published to crates.io.** It is vendored inside
   `LayerZero-Labs/LayerZero-v2` and pins `anchor-lang 0.29.0` / `rust 1.75.0`, against
   anchor-cli 0.30.1 and rustc 1.84.1 here. There is an `anchor-latest/` variant in the same
   repo that may reconcile this. **Settle that question before writing program code** — it
   determines the whole workspace layout.

Also worth knowing: LayerZero already ships a complete Solana OFT program, so the token side is
a deployment exercise rather than a writing one. The work that genuinely has to be written is
the `swap_request` program, and — for Solana as a base chain — a `swap_relay` that CPIs into
Orca Whirlpools or Raydium CLMM. Uniswap V3 has no Solana deployment, so that half is a new
venue integration rather than a port of the EVM relay.

**Why it matters / what breaks if ignored:** The multi-VM foundation is committed and the EVM
path is unaffected (6/6 scenarios, 39/39 Foundry tests still pass). The pipeline now detects an
SVM chain up front and says exactly what is missing instead of failing deep inside viem with a
chain-id error. `agents.md` §12 carries the dependency-ordered plan.

---

### [2026-09-19] CORRECTION: the Solana version pins are not a blocker
**Milestone:** M14 — supersedes the previous entry

**What happened / what to know:** The previous entry flagged LayerZero's anchor/rust pins as
something to settle before writing program code. That was caution based on reading version
numbers, and **testing it showed it is not an obstacle.**

LayerZero's repo has two Solana variants:

| | `programs/` | `anchor-latest/` |
|---|---|---|
| `anchor-lang` | 0.29.0 | **0.32.1** |
| Contents | full endpoint program | **interface-only** (`endpoint-interface`, `messagelib-interface`) |
| Right choice for an OApp | no | **yes** — you CPI into the deployed endpoint |

`cargo build-sbf --manifest-path anchor-latest/libs/oapp/Cargo.toml` **compiles cleanly on this
machine in 67 seconds**, pulling anchor-lang 0.32.1 and the solana 2.2.x crates. The locally
installed anchor-cli (0.30.1) is irrelevant to compilation — it matters only for IDL generation
and test scaffolding, and `cargo build-sbf` does not use it.

**Why it matters / what breaks if ignored:** The lesson is the same one that has recurred
through this build: **verify the obstacle before planning around it.** An unverified blocker in
a planning document is worse than no document, because it redirects effort away from the real
problems.

The real difficulties are architectural, and were found by reading LayerZero's Solana source:

1. **Compose is inverted.** The Solana endpoint has no `lz_compose` instruction — only
   `send_compose` and `clear_compose`. Where EVM's endpoint *calls into* the composer, on
   Solana the executor invokes the **composer program's own** instruction, which CPIs
   `clear_compose` to consume the message. The compose handling is a restructure, not a port.
2. **Accounts must be declared up front** via `lz_receive_types`, before delivery. An EVM
   contract touches whatever storage it wants. A Solana `swap_relay` would have to enumerate
   every account its DEX swap will touch — including tick arrays that depend on the price at
   execution time. This is the hardest part of putting the relay on Solana and has no EVM
   analogue.

Good news that also came out of reading the source: Solana's OFT supports composed messages
(`SendParams.compose_msg`) with a codec matching the EVM one, so the core "tokens and
instruction in one packet" mechanism holds on both VMs. And LayerZero's OFT already implements
`init_adapter_oft`, so the bring-your-own-token feature has a direct Solana counterpart.

---

### [2026-09-19] Solana: the mirror program builds against LayerZero's real OApp crate
**Milestone:** M15 — swap_request program

**What happened / what to know:** `solana/programs/swap_request` compiles to a 361 KB SBF
program against LayerZero's actual `oapp` crate, and its wire-format codec round-trips against
`SwapTypes.sol`. Five host tests cover the codec, including truncated and oversized payloads.

**The build fight, and what actually resolved it.** The SBF toolchain ships cargo 1.84.0, which
cannot parse manifests declaring Rust edition 2024 — and crates.io releases are adopting it.
Resolving from scratch failed on `block-buffer 0.12`, then `zeroize_derive 1.5`, then
`toml_datetime 1.1`, each with the same error. Pinning them one at a time was a losing race.

**What worked: seeding `Cargo.lock` from LayerZero's own `anchor-latest/Cargo.lock`.** They have
already pinned a consistent pre-edition2024 set, and reusing it resolved everything at once.
That lock is now load-bearing — if a dependency is added and the build starts failing on
`feature edition2024 is required`, pin rather than upgrade.

Also dropped `anchor-spl` entirely. It pulls `spl-associated-token-account` and
`solana-program 2.3`, which drag in precisely that crate tree. Only `TransferChecked` was needed
and that instruction is three fields wide and stable since SPL Token launched, so `src/spl.rs`
encodes it directly — fewer dependencies and no fight with the migration.

**One cross-VM correctness fix that had to land on the EVM side too.** `SwapTypes.Order.recipient`
is now `bytes32` rather than `address`. A Solana pubkey is 32 bytes, and Solidity's `abi.decode`
into `address` **reverts** when the upper 12 bytes are non-zero — so an `address` there would
have made every order originating on Solana undecodable on the home chain. The codec fuzz test
now fuzzes `recipient` over the full `bytes32` domain rather than just EVM addresses, since a
test using only left-padded values would not catch a regression. EVM suite still 39/39, live
pipeline still 6/6.

**Design points worth carrying:**

- The store PDA *is* the OApp identity. It signs the outbound OFT send, so the home-chain relay
  sees `composeFrom == store` and can authenticate it. If a user called the OFT directly,
  `composeFrom` would be their own key and the relay would correctly reject the order.
- The OFT `send` is invoked by hand-built CPI with an inlined discriminator, not through the
  OFT's generated client. The OFT crate pins an older Anchor than this workspace, and depending
  on it would couple our build to a specific OFT release for no benefit.
- A request is its own PDA keyed by request id, not an entry in a map, because
  `lz_compose_types_v2` must name every account a delivery will touch *before* delivery — so the
  account has to be derivable from the payload with no chain reads.

---

### [2026-09-19] Solana program deployed to a local validator alongside the real endpoint
**Milestone:** M16 — SVM deployment backend

**What happened / what to know:** `npm run solana:deploy` deploys `swap_request.so` to a local
validator and confirms it is executable, owned by `BPFLoaderUpgradeab1e`, sitting next to
LayerZero's genuine EndpointV2 cloned from devnet. Program id
`6cMiunhoxEcYYT29Cp4PgDT97FjtqsuqZ27ChTbr41vL`.

Three decisions worth recording:

1. **`SolanaChain` is not a subclass of, or a shared interface with, the EVM `Chain`.** The two
   VMs disagree about nearly everything a deployment touches: an EVM contract is bytecode at an
   address derived from a nonce, a Solana program is an account owned by a loader whose state
   lives in separate PDAs; addresses are 20 bytes versus 32. A single interface over both would
   have a VM-shaped hole in every method. The pipeline routes on `ChainConfig.vm` and each
   backend stays honest about its own model. What the two genuinely share is `eid` — LayerZero
   routes on it regardless of VM, which is why the messaging layer needs no abstraction at all.

2. **Deployment shells out to `solana program deploy`.** Deploying is not one transaction: the
   binary is chunked into a buffer account across many transactions, then finalised, with
   retry and recovery for partial writes. The CLI is the reference implementation; a TypeScript
   rewrite would be a lot of code whose only distinction is being less well tested.

3. **`preflight()` checks the endpoint is `executable`, not merely present.** The Solana
   equivalent of the EVM backend's chain-id assertion. `solana-test-validator --clone` (without
   `--clone-upgradeable-program`) copies the account and leaves the programdata behind, giving
   a program that looks correct in an explorer and fails at the first CPI.

The program keypair is committed under `solana/keys/` so the id is stable and matches
`declare_id!`, which is the normal Anchor convention — with a README making clear these are
throwaway localnet/devnet keys and that a real deployment generates its own and sets a separate
upgrade authority.

---

### [2026-09-19] The Solana program executes and LayerZero accepted its OApp registration
**Milestone:** M17 — init_store

**What happened / what to know:** `npm run solana:init` runs `init_store` against the deployed
program on a local validator. It succeeded, which exercises the whole stack in one call: Anchor
instruction dispatch, PDA derivation, account creation, and a CPI into the **genuine**
EndpointV2 cloned from devnet.

| Account | Result |
|---|---|
| Store PDA | 309 bytes, owned by `6cMiunhox…41vL` (our program) |
| `LzComposeTypes` PDA | created |
| OApp registry PDA | 41 bytes, **owned by `76y77prs…jEn6`** — LayerZero's endpoint |

The registry account being owned by the endpoint is the part that matters: the endpoint created
it, which means it accepted the registration. The program is now something LayerZero will
deliver to.

**The account ordering for an endpoint CPI is not obvious and is worth writing down.**
LayerZero's `cpi-helper` generates a `construct_context` that expects the **target program at
index 0**, then the instruction's declared accounts in order, then the two accounts
`#[event_cpi]` appends. So `register_oapp` wants:

```
[0] endpoint program        [4] system program
[1] payer (signer, mut)     [5] event_authority PDA  ["__event_authority"]
[2] oapp = store PDA        [6] endpoint program (again)
[3] oapp_registry PDA       ["OApp", store]
```

Getting this wrong produces `InvalidProgramId` or a seeds-constraint failure several frames
down, with nothing pointing at the ordering as the cause. The check inside
`endpoint_cpi::register_oapp` — `if oapp != accounts[2].key()` — is the clue that the program
occupies index 0.

Also: the store PDA is passed as the `oapp` **without** being a transaction signer. It signs
via `invoke_signed` with its own seeds inside the program, which is why the outer transaction
only needs the payer's signature.

---

### [2026-09-19] LayerZero has two Solana OFT programs and only one of them builds
**Milestone:** M18 — OFT deployment

**What happened / what to know:** The obvious OFT to use is the one in the LayerZero-v2
monorepo, next to the endpoint. **It cannot be compiled with the current toolchain at all.** It
pins `anchor-lang 0.29` → `solana-program 1.17.31` → `ahash 0.7.8`, and `ahash 0.7.8` uses the
`stdsimd` feature that newer rustc removed:

```
error[E0635]: unknown feature `stdsimd`
```

`ahash` cannot be bumped past it either, because `solana-program 1.17.31` pins that exact
version. The whole chain is stuck behind an old Solana SDK.

**The maintained one is in a different repository.** `LayerZero-Labs/devtools` at
`examples/oft-solana` pins `anchor-lang 0.31.1` and `rust-toolchain 1.84.1` — exactly the rustc
that platform-tools v1.51 ships. It built first time in 1m59s. That is what is vendored, at
`solana/vendor/oft-solana`, with the devtools commit recorded in `COMMIT`.

Vendored as **source, not as a `.so`**: a binary in git is unauditable and unverifiable, and
the source is only 228 KB.

**Second trap: the OFT's program id comes from an environment variable, not a keypair.**

```rust
declare_id!(Pubkey::new_from_array(program_id_from_env!(
    "OFT_ID", "9UovNrJD8pQyBLheeHNayuG1wJSEAoxkmM14vw5gcsTT"
)));
```

LayerZero expects every project to deploy its own OFT instance, so the id is a build-time
input. Build without setting `OFT_ID` and the program deploys carrying LayerZero's default id
while living at a different address — every PDA derived against it is then wrong, and nothing
about the failure points at the build step. Build with
`OFT_ID=$(solana-keygen pubkey keys/oft-keypair.json)`.

Three programs are now live on the local validator: LayerZero's EndpointV2 (cloned from
devnet), LayerZero's OFT (built from vendored source), and CrossStock's `swap_request`.

---

### [2026-09-19] Solana OFTs initialised; peers are accounts, not a mapping
**Milestone:** M19 — init_oft and peer wiring

**What happened / what to know:** `npm run solana:oft` creates an SPL mint per asset, runs
`init_oft`, hands the mint authority to the OFT store PDA, and wires the peer to the home
chain — with a read-back check, exactly as the EVM peer-wiring module does.

Three things that are genuinely different from the EVM equivalent:

1. **Peers are accounts.** An EVM OFT keeps them in `mapping(uint32 => bytes32)` and `setPeer`
   writes a slot. Solana derives a `PeerConfig` PDA per remote eid —
   `[b"Peer", oft_store, remote_eid_be]` — so wiring *is* account creation, and reading a peer
   back means fetching that account and comparing its first 32 bytes. The verification matters
   for the same reason it does on EVM: an unverified peer produces a deployment that looks
   complete and drops messages at runtime.

2. **The mint authority has to be transferred to the OFT store.** A native OFT mints on
   inbound delivery, so if the authority stays with the deployer, setup looks entirely
   successful and the *first inbound bridge* fails at the mint — a long way from the cause.

3. **Anchor's `#[account(init, ...)]` allocates the account itself.** The token escrow is
   declared `init` with no seeds, so it is a fresh keypair rather than a PDA. The instinct is
   to create it first with `SystemProgram.createAccount`; doing so makes the program's own
   allocate fail with `Allocate: account already in use`. The escrow only has to **sign**, not
   exist.

`OFTType::Native` is used rather than `Adapter`, matching the EVM side's launch mode. Solana's
OFT has an `Adapter` variant too, which is the counterpart of the `OmniTokenAdapter` work in
M13 — so bring-your-own-token has a direct Solana equivalent when it is needed.
