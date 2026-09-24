# CrossStock on Solana

The Solana half of CrossStock. Currently: the **mirror-chain** program, which builds against
LayerZero's real Solana OApp crate.

```bash
cd solana
cargo build-sbf --manifest-path programs/swap_request/Cargo.toml   # → target/deploy/swap_request.so
cargo test -p swap-request --lib                                   # wire-format codec tests
```

## What is here

| | |
|---|---|
| `programs/swap_request` | The Solana counterpart to `src/relay/SwapRequest.sol`. Builds to a 361 KB SBF program. |
| `vendor/layerzero/` | LayerZero's Solana OApp crates, vendored. Provenance in `COMMIT`. |
| `vendor/oft-solana/` | LayerZero's Solana **OFT program**, vendored from their devtools repo and built from source rather than shipped as a binary, so it stays auditable. Builds to 566 KB. |
| `keys/` | Program keypairs, so ids are stable and match `declare_id!`. Throwaway localnet keys — see `keys/README.md`. |
| `Cargo.lock` | **Seeded from LayerZero's own lock.** Load-bearing — see below. |

## Running it

```bash
npm run solana:lz-build    # LayerZero endpoint + simple-messagelib, from the vendored commit
npm run solana:build       # swap_request.so
npm run solana:build:oft   # LayerZero's OFT, with OFT_ID baked in

npm run solana:up && npm run chains:up
npm run solana:deploy      # OFT + swap_request onto the validator
npm run deploy   -- --config config/localnet-solana.json   # EVM + Solana in one pipeline
npm run validate -- --config config/localnet-solana.json   # scenario 7 trades from Solana
```

Four LayerZero programs run on the validator: the endpoint and `simple-messagelib` (both built
from source and loaded at their canonical ids — no devnet access needed), LayerZero's OFT, and
CrossStock's `swap_request`. `infra/solana/lz-local.ts` initialises the endpoint locally and
registers `simple-messagelib` as the default library; the relayer then verifies and delivers
packets exactly as it does on EVM. Toolchain: the Agave 3.0.14 CLI.

## The two things that are genuinely different from EVM

Neither is a translation of the Solidity. They are why this is a separate implementation.

**Compose is inverted.** On EVM, `endpoint.lzCompose()` *calls into* your contract. The Solana
endpoint has no `lz_compose` instruction at all — it has `send_compose` and `clear_compose`.
The Executor invokes **the program's own** `lz_compose` instruction, which then CPIs
`clear_compose` to prove the message was really queued and to consume it. So the program is the
entrypoint rather than the callee, and `clear_compose` — not a modifier — is what makes a
settlement authentic and unreplayable.

**Every account must be declared before delivery.** Solana builds transactions from a fixed
account list, so the Executor asks the program which accounts a delivery will touch *before* it
can deliver, via `lz_compose_types_v2`. An EVM contract simply reaches into whatever storage it
likes. This is why a request lives in its own PDA keyed by request id: the account is derivable
from the payload alone, with no chain reads.

## What carries over unchanged

The mechanism. LayerZero's Solana OFT supports composed messages exactly as the EVM one does
(`SendParams.compose_msg`), so *the tokens and the instruction travel in the same packet* holds
on both VMs — and with it the property that neither side can be asked to act on a message whose
funds have not arrived.

The wire format carries over too. `src/abi.rs` encodes `Order` and `Settlement` byte-for-byte
as Solidity's `abi.encode` does, so `SwapTypes.sol` and this program read each other's messages
without a translation layer.

One field had to widen for this: **`Order.recipient` is `bytes32`, not `address`.** A Solana
pubkey is 32 bytes, and Solidity's `abi.decode` into `address` *reverts* when the upper 12 bytes
are non-zero — so an `address` there would make every order from Solana undecodable on the home
chain. The Solidity side was changed to match.

## Build notes, learned the hard way

**`Cargo.lock` is seeded from LayerZero's `anchor-latest/Cargo.lock` and must stay pinned.**
The SBF toolchain ships cargo 1.84.0, which cannot parse manifests that declare Rust edition
2024 — and a growing number of crates.io releases now do. Resolving freshly walks straight into
`block-buffer`, then `zeroize_derive`, then `toml_datetime`, each failing the same way. Pinning
them one at a time is a losing race against the ecosystem's migration; starting from the lock
LayerZero already tested resolves all of it at once.

If a dependency is added and the build starts failing on `feature edition2024 is required`,
that is the cause. Pin, do not upgrade.

**`anchor-spl` is deliberately not a dependency.** It pulls `spl-associated-token-account` and
`solana-program 2.3`, which drag in exactly that edition-2024 crate tree. Only
`TransferChecked` was needed from it, and that instruction is three fields wide and has been
stable since SPL Token launched, so `src/spl.rs` encodes it directly. Fewer dependencies and no
fight with the migration.

## Two build traps worth knowing about

**LayerZero has two Solana OFT programs, and only one of them builds.** The one in
`LayerZero-v2/packages/.../programs/programs/oft` pins `anchor-lang 0.29` → `solana-program
1.17` → `ahash 0.7.8`, which uses the `stdsimd` feature that newer rustc removed. It cannot
compile with the current platform-tools at all. The maintained one is in their **devtools** repo
at `examples/oft-solana`: `anchor-lang 0.31.1`, `rust-toolchain 1.84.1` — exactly the version
platform-tools v1.51 ships. That is the one vendored here.

**The OFT's program id comes from an `OFT_ID` environment variable at build time**, not from a
keypair file, because LayerZero expects every project to deploy its own OFT instance. Build it
with `OFT_ID=$(solana-keygen pubkey keys/oft-keypair.json)` or the deployed program will carry
the wrong id and every PDA derived against it will be wrong.

## Peers are accounts, not a mapping

An EVM OFT keeps peers in `mapping(uint32 => bytes32)` and `setPeer` writes a slot. Solana
derives a `PeerConfig` **PDA per remote eid** — `[b"Peer", oft_store, remote_eid_be]` — so
wiring is account creation and "reading the peer back" means fetching that account and
comparing its first 32 bytes. `init-oft.ts` does exactly that, for the same reason the EVM
module does: a peer that silently failed to land gives a deployment that looks complete and
drops messages at runtime.

## Not built yet

- Relayer support for the SVM delivery path.
- **Solana as the base chain**, which needs a `swap_relay` program CPI-ing into Orca Whirlpools
  or Raydium CLMM. Uniswap V3 has no Solana deployment, so that is a new venue integration
  rather than a port — and account pre-declaration makes a concentrated-liquidity swap
  materially harder to express, since the tick arrays a swap touches depend on the price at
  execution time.

See `agents.md` §12 for the dependency-ordered plan.
