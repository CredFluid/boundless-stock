//! CrossStock addition — NOT part of LayerZero's OFT. See `LOCAL_CHANGES.md` at the vendor root.
//!
//! Restores a user's input when their outbound message was permanently killed on the
//! destination. The Solana counterpart of `OmniToken.setRecoveryMinter` / `recoveryCredit`.
//!
//! A native OFT burns what it sends, so an input whose message will never arrive exists on no
//! chain at all; making the user whole means minting it again. That is only safe AFTER the
//! destination has proved the message can never execute (`skip`, and `burn` if verified), and
//! only the program that holds the request record can know which amount belongs to whom — so
//! exactly one account, named by the admin, may call this. On CrossStock that is the
//! `swap_request` store PDA, acting on an authenticated CANCELLED notice from the home relay.

use crate::*;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface};

pub const RECOVERY_MINTER_SEED: &[u8] = b"RecoveryMinter";

#[account]
#[derive(InitSpace)]
pub struct RecoveryMinter {
    pub minter: Pubkey,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct SetRecoveryMinter<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [OFT_SEED, oft_store.token_escrow.as_ref()],
        bump = oft_store.bump,
        has_one = admin @OFTError::Unauthorized
    )]
    pub oft_store: Account<'info, OFTStore>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + RecoveryMinter::INIT_SPACE,
        seeds = [RECOVERY_MINTER_SEED, oft_store.key().as_ref()],
        bump
    )]
    pub recovery_minter: Account<'info, RecoveryMinter>,
    pub system_program: Program<'info, System>,
}

impl SetRecoveryMinter<'_> {
    pub fn apply(ctx: &mut Context<SetRecoveryMinter>, minter: Pubkey) -> Result<()> {
        ctx.accounts.recovery_minter.minter = minter;
        ctx.accounts.recovery_minter.bump = ctx.bumps.recovery_minter;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RecoveryCredit<'info> {
    /// The designated recovery minter — a PDA of the calling program, signing by CPI.
    pub minter: Signer<'info>,
    #[account(
        seeds = [RECOVERY_MINTER_SEED, oft_store.key().as_ref()],
        bump = recovery_minter.bump,
        constraint = recovery_minter.minter == minter.key() @OFTError::Unauthorized
    )]
    pub recovery_minter: Account<'info, RecoveryMinter>,
    #[account(
        seeds = [OFT_SEED, oft_store.token_escrow.as_ref()],
        bump = oft_store.bump,
    )]
    pub oft_store: Account<'info, OFTStore>,
    #[account(
        mut,
        address = oft_store.token_mint,
        mint::token_program = token_program
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = token_mint, token::token_program = token_program)]
    pub token_dest: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

impl RecoveryCredit<'_> {
    pub fn apply(ctx: &mut Context<RecoveryCredit>, amount_ld: u64) -> Result<()> {
        // An adapter locks rather than burns, so its input is still in escrow and would be
        // restored by transfer, not mint. CrossStock's Solana mirrors are native; refuse rather
        // than guess.
        require!(ctx.accounts.oft_store.oft_type == OFTType::Native, OFTError::InvalidMintAuthority);
        // Minting is signed by the store, so the store must be the mint authority — which is
        // how CrossStock's setup leaves it.
        require!(
            ctx.accounts.token_mint.mint_authority == Some(ctx.accounts.oft_store.key()).into(),
            OFTError::InvalidMintAuthority
        );

        let escrow = ctx.accounts.oft_store.token_escrow;
        let seeds: &[&[u8]] = &[OFT_SEED, escrow.as_ref(), &[ctx.accounts.oft_store.bump]];
        token_interface::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    to: ctx.accounts.token_dest.to_account_info(),
                    authority: ctx.accounts.oft_store.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
            amount_ld,
        )?;

        emit!(RecoveryCredited {
            oft_store: ctx.accounts.oft_store.key(),
            to: ctx.accounts.token_dest.key(),
            amount_ld,
        });
        Ok(())
    }
}
