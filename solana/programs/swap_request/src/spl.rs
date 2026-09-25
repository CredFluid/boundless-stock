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

/// The classic SPL Token program.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Token-2022. A mint lives under one program or the other; every transfer, and every
/// associated token account address, is specific to the mint's program.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
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

/// The associated token account for `wallet` and `mint`, under the mint's token program.
///
/// Derived rather than accepted: whoever submits a delivery chooses the accounts it passes,
/// so a payout destination must be checked against this address or it could be redirected to
/// any account holding the same mint. The program is part of the derivation: the same wallet
/// and mint have a different associated account under Token-2022.
pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// The token program that owns `mint`: classic SPL Token or Token-2022, nothing else.
pub fn token_program_of(mint: &AccountInfo) -> Result<Pubkey> {
    let owner = *mint.owner;
    require!(
        owner == TOKEN_PROGRAM_ID || owner == TOKEN_2022_PROGRAM_ID,
        crate::error::SwapRequestError::UnsupportedTokenProgram
    );
    Ok(owner)
}

/// Token-2022 mint extensions that would break a CrossStock guarantee, by extension type:
///
/// - `TransferFeeConfig` (1), `ConfidentialTransferFeeConfig` (16): a transfer delivers less
///   than was sent, so escrowed amounts, refunds and the supply check stop adding up;
/// - `DefaultAccountState` (6): new accounts can start frozen, including the ones a delivery
///   creates for the user;
/// - `NonTransferable` (9): the token cannot move at all;
/// - `PermanentDelegate` (12): someone other than the holder can move tokens out of the
///   program's escrow, so funds in flight are no longer the program's to guarantee;
/// - `TransferHook` (14): every transfer calls a program chosen by the issuer, which can refuse
///   it or need accounts the delivery cannot name in advance.
///
/// Each can be supported, but only after a product decision about who bears the effect. Until
/// then a mint carrying one is refused at initialisation, rather than failing later mid-trade.
pub const REFUSED_EXTENSIONS: [(u16, &str); 6] = [
    (1, "transfer fee"),
    (6, "default account state"),
    (9, "non-transferable"),
    (12, "permanent delegate"),
    (14, "transfer hook"),
    (16, "confidential transfer fee"),
];

/// Base mint length; Token-2022 pads mints with extensions to an account's length, then
/// writes an account-type byte and the TLV extension list.
const MINT_LEN: usize = 82;
const ACCOUNT_LEN: usize = 165;

/// The extension types a Token-2022 mint carries, read from its TLV data.
pub fn mint_extensions(data: &[u8]) -> Vec<u16> {
    let mut out = vec![];
    if data.len() <= ACCOUNT_LEN + 1 {
        return out; // a plain mint (82 bytes), or one with no extensions
    }
    let mut o = ACCOUNT_LEN + 1; // skip the padding and the account-type byte
    while o + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[o], data[o + 1]]);
        let len = u16::from_le_bytes([data[o + 2], data[o + 3]]) as usize;
        if kind == 0 {
            break; // uninitialised: the end of the list
        }
        out.push(kind);
        o += 4 + len;
    }
    out
}

/// Refuses a mint this program cannot carry safely: the wrong owner, or a Token-2022
/// extension from [`REFUSED_EXTENSIONS`].
pub fn check_mint(mint: &AccountInfo) -> Result<()> {
    let program = token_program_of(mint)?;
    if program == TOKEN_2022_PROGRAM_ID {
        let data = mint.try_borrow_data()?;
        require!(data.len() >= MINT_LEN, crate::error::SwapRequestError::MalformedPayload);
        for kind in mint_extensions(&data) {
            if let Some((_, name)) = REFUSED_EXTENSIONS.iter().find(|(k, _)| *k == kind) {
                msg!("Token-2022 extension not supported: {}", name);
                return err!(crate::error::SwapRequestError::UnsupportedMintExtension);
            }
        }
    }
    Ok(())
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
        assert_eq!(associated_token_address(&wallet, &mint, &TOKEN_PROGRAM_ID).to_string(), ATA_VECTOR);
    }

    const ATA_VECTOR: &str = "EgTfXYJvEe77uCC6kzS4dx1QtLzxn9B3bigLvdSe8ccs";
}
