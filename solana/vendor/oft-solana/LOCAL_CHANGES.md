# Local changes to LayerZero's Solana OFT

Vendored from LayerZero's devtools at the commit in `COMMIT`. Everything here is upstream
except the following, which CrossStock adds:

| File | Change |
|---|---|
| `programs/oft/src/instructions/recovery.rs` | **New.** `set_recovery_minter` (admin names one account) and `recovery_credit` (only that account may mint to a user). |
| `programs/oft/src/instructions/mod.rs`, `lib.rs` | Wire the two instructions in. |
| `programs/oft/src/events.rs` | `RecoveryCredited` event. |

**Why.** A native OFT burns what it sends. When a message is permanently killed on the
destination (`skip`, then `burn` if it was verified — see `SwapRelay.cancelStuckInbound`), the
user's input exists on no chain and has to be minted again. Only the OFT store can mint, so the
OFT needs a gated entry point for it — the Solana counterpart of `OmniToken.recoveryCredit`. On
CrossStock the recovery minter is the `swap_request` store PDA, which calls this only on an
authenticated CANCELLED notice, for the amount in its own request record.

Nothing upstream is modified, so re-vendoring means re-applying these three edits.
