//! A minimal SPL Token CPI, in place of `anchor-spl`.
//!
//! Only `TransferChecked` is needed, and pulling `anchor-spl` in for it costs more than it
//! gives: it drags `spl-associated-token-account` and `solana-program 2.3` behind it, which in
//! turn pull a crate tree that has begun adopting Rust edition 2024 — an edition the stock SBF
//! toolchain's cargo (1.84.0) cannot even parse the manifests of. Chasing that with version
//! pins is a losing game against the ecosystem's migration.
//!
//! The instruction is three fields wide and stable since SPL Token launched, so encoding it by
//! hand is both smaller and more durable than the dependency it replaces.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

/// `TransferChecked` in the SPL Token instruction enum.
const TRANSFER_CHECKED_TAG: u8 = 12;

/// Moves `amount` of `mint` from `source` to `destination`, authorised by `authority`.
///
/// "Checked" because it verifies the mint and decimals on chain: a transfer that names the
/// wrong mint, or the right mint with the wrong decimals, fails rather than moving a
/// surprising quantity of the wrong asset.
pub fn transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    let mut data = Vec::with_capacity(10);
    data.push(TRANSFER_CHECKED_TAG);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };

    invoke(
        &ix,
        &[
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
    )
    .map_err(Into::into)
}

/// Reads `decimals` from a packed SPL Mint account.
///
/// Mint layout: `mint_authority` (36) ‖ `supply` (8) ‖ `decimals` (1) ‖ …
/// Read directly rather than through a typed account so this program needs no SPL types at all.
pub fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    require!(data.len() >= 45, crate::error::SwapRequestError::MalformedPayload);
    Ok(data[44])
}
