# Local changes to Orca's Whirlpool program

Vendored from `orca-so/whirlpools` at the commit in `COMMIT` (`programs/whirlpool`). CrossStock
uses it two ways: built as-is and loaded on the local validator at its canonical id, and as a
library (`default-features = false, features = ["cpi"]`) by `solana/relay/programs/swap_relay`,
which runs Orca's own swap maths read-only to quote before it swaps.

| File | Change |
|---|---|
| `src/entrypoint.rs` | `custom_heap_default!()` and `custom_panic_default!()` gated on the crate's own `whirlpool-entrypoint` feature. Unconditional, they define a global allocator even in a library build, which conflicts with the depending program's. The program build (default features) is unchanged. |
| `Cargo.toml` | `license-file` points at the copied `LICENSE`; an empty `[workspace]` table so it is its own workspace root and builds standalone from inside `solana/`. `Cargo.lock` is Orca's, copied unchanged. |

Nothing else is modified.
