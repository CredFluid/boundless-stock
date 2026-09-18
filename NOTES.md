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
