# Proof of reserves — parked idea

Status: **not started.** Written down so we can pick it up later. Nothing here is built.

## The short answer

Partly. Proof of reserves compares two numbers:

1. **What has been issued on chain** (the liability). CrossStock can already produce this with
   no outside help.
2. **What backs it off chain**: the real shares held by a custodian, broker or transfer agent.
   Only someone who can see those holdings can supply this number.

So we need a **reserve data source** for half 2. That can be an issuer's API, but it doesn't have
to be. See "Where the reserve figure could come from" below.

## Half 1 — the on-chain liability is already done

`infra/lib/omnisupply.ts` (M31) measures, for each asset, across every chain of every VM:

    Σ supply on each chain  +  in flight  ==  what exists

In-flight amounts come from the OFT flow counters: `bridgedOut`/`bridgedIn` on EVM, and
`bridged_out`/`bridged_in` on Solana. So this figure comes entirely from chain state, including
messages that are mid-transfer. `npm run supply` prints it for any topology.

That leads to a useful simplification. Bridging conserves supply, and the checks above prove
that it does. So **the total liability is fixed on the home chain**. It is set by the genesis
mint, or, in adapt mode, by the issuer's own token. A mirror chain can never create supply.
Proof of reserves therefore needs **one comparison per asset**, not one per chain:

    reserves (shares held for the token)  ≥  omnichain supply (+ in flight)

## Half 2 — where the reserve figure could come from

| Source | What it is | Trade-off |
|---|---|---|
| **The token issuer's API** | The tokenization platform reports shares held per token | Easiest to get, but it is the issuer vouching for itself |
| **The custodian or broker directly** | The firm actually holding the shares reports balances | Better independence; needs a commercial relationship and API access |
| **Transfer agent records** | Register of record for the shares | Authoritative; slower, and often not machine-readable |
| **An oracle network's reserve feed** | A decentralised oracle publishes a reserve figure on chain (Chainlink's Proof of Reserve is the best-known) | Already on chain and easy to consume. It only exists where someone has set up a feed for that asset, and it is only as good as the data the oracle pulls from |
| **Periodic auditor attestation** | Signed statement (e.g. monthly) from an accounting firm | Strong assurance, but slow — not suitable for a live check |

A realistic setup combines them: a live feed (issuer, custodian or oracle) for continuous
checks, plus periodic auditor attestations to keep the live feed honest.

**Open question for us:** who the issuer is for each asset we would list, and which of these
sources each one already provides. That decides how much of this we build and how much we just
consume.

## What we would build

- **A reserve source interface** in the infra, one implementation per source above. Each returns
  `{ asset, reservesInShares, asOf, source, signature? }`.
- **A units bridge.** Reserves are in shares. On-chain supply is in token units, and a token may
  not be one share each (fractional tokens, splits, dividends paid in kind). This needs a
  per-asset ratio in config, and corporate actions must update it.
- **A PoR report**, alongside `npm run supply`: liability, reserves, ratio, data age, source, and
  pass/fail.
- **A staleness rule.** A reserve figure older than N hours counts as unknown, not as fine.
- **Optionally, on-chain enforcement**, on the home chain only, since that is where supply
  originates:
  - consume an oracle feed and refuse new minting or issuance while reserves fall short, or
    while the data is stale;
  - it would not need to pause bridging. Bridging cannot change the total, and pausing it would
    strand users' in-flight funds.
- **A validation scenario** with a mock reserve source: pass when fully backed, fail on a
  shortfall, fail on stale data.

## Things to decide before starting

- Which assets and issuers are in scope first, and what each already publishes.
- Reporting only, or also on-chain enforcement? Reporting only is far less work and risk.
- Whether reserve data is public, or restricted to operators. Custodians often restrict it.
- Legal and regulatory review. Publishing reserve figures for securities may carry obligations,
  and so may failing to publish them.
