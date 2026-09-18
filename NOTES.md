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
