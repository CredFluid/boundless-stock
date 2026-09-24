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
use anchor_lang::solana_program::program::{invoke, invoke_signed};

/// The classic SPL Token program. The mints CrossStock creates live here; Token-2022 would need
/// its own id threaded through, and nothing in the deployment uses it.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// The Associated Token Account program.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// `CreateIdempotent` in the ATA program's instruction enum: creates the account if it is
/// missing and succeeds silently if it already exists.
pub const ATA_CREATE_IDEMPOTENT_TAG: u8 = 1;

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
    let ix = transfer_checked_ix(token_program, source, mint, destination, authority, amount, decimals);
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

/// [`transfer_checked`] with a PDA as the authority, signing with its seeds.
///
/// How the program pays out of its own token accounts: the store PDA owns them and has no
/// private key, so the runtime accepts its signature only through `invoke_signed`.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_signed<'info>(
    token_program: &AccountInfo<'info>,
    source: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let ix = transfer_checked_ix(token_program, source, mint, destination, authority, amount, decimals);
    invoke_signed(
        &ix,
        &[
            source.clone(),
            mint.clone(),
            destination.clone(),
            authority.clone(),
            token_program.clone(),
        ],
        &[signer_seeds],
    )
    .map_err(Into::into)
}

fn transfer_checked_ix(
    token_program: &AccountInfo,
    source: &AccountInfo,
    mint: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    decimals: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.push(TRANSFER_CHECKED_TAG);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);

    Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    }
}

/// The associated token account for `wallet` and `mint`.
///
/// Derived rather than accepted: whoever submits a delivery chooses the accounts it passes,
/// so a payout destination must be checked against this address or it could be redirected to
/// any account holding the same mint.
pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-checked against `@solana/web3.js`:
    ///   PublicKey.findProgramAddressSync([wallet, TOKEN_PROGRAM, mint], ATA_PROGRAM)
    /// using the swap_request program id as the wallet and the OFT program id as the mint —
    /// arbitrary but fixed keys, chosen only so the vector is reproducible from this repo.
    #[test]
    fn ata_matches_the_canonical_derivation() {
        let wallet = pubkey!("6cMiunhoxEcYYT29Cp4PgDT97FjtqsuqZ27ChTbr41vL");
        let mint = pubkey!("9xcb9TquFyK9wELi4TpghRVfMxu12NzcgQYMPqG4cFLA");
        assert_eq!(associated_token_address(&wallet, &mint).to_string(), ATA_VECTOR);
    }

    const ATA_VECTOR: &str = "EgTfXYJvEe77uCC6kzS4dx1QtLzxn9B3bigLvdSe8ccs";
}
