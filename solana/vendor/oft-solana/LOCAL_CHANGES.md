# Local changes to LayerZero's Solana OFT

Vendored from LayerZero's devtools at the commit in `COMMIT`. Everything here is upstream
except the following, which CrossStock adds:

| File | Change |
|---|---|
| `programs/oft/src/instructions/recovery.rs` | **New.** `set_recovery_minter` (admin names one account) and `recovery_credit` (only that account may mint to a user). |
| `programs/oft/src/instructions/mod.rs`, `lib.rs` | Wire the two instructions in. |
| `programs/oft/src/events.rs` | `RecoveryCredited` event. |
| `programs/oft/src/state/oft.rs` | **Two fields appended to `OFTStore`**: `bridged_out`, `bridged_in` (u128, local decimals). |
| `programs/oft/src/instructions/send.rs`, `lz_receive.rs`, `recovery.rs` | Update them: `send` counts what goes on the wire, `lz_receive` what comes off it, `recovery_credit` counts as an arrival (its `oft_store` is now `mut`). |

**Why.** A native OFT burns what it sends. When a message is permanently killed on the
destination (`skip`, then `burn` if it was verified — see `SwapRelay.cancelStuckInbound`), the
user's input exists on no chain and has to be minted again. Only the OFT store can mint, so the
OFT needs a gated entry point for it — the Solana counterpart of `OmniToken.recoveryCredit`. On
CrossStock the recovery minter is the `swap_request` store PDA, which calls this only on an
authenticated CANCELLED notice, for the amount in its own request record.

**Why the counters.** They are `OmniToken.bridgedOut`/`bridgedIn` on SPL. Summed over every
chain of every VM, `Σ bridged_out − Σ bridged_in` is exactly what is in flight, so
`Σ supply + in flight == genesis` is checkable from chain state alone (`npm run supply`). The
fields are appended, so upstream tooling that deserialises an `OFTStore` still reads every field
it knows; a store created by an unmodified build is shorter and will not load here — deploy
fresh.

Re-vendoring means re-applying these edits.
