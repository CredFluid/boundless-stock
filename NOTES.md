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
