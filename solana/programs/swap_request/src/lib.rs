//! # CrossStock `swap_request` — the mirror-chain entrypoint on Solana
//!
//! The Solana counterpart to `src/relay/SwapRequest.sol`. A user on this chain holds one of the
//! two assets and no market for them exists here: no pool, no market maker, no price. This
//! program takes their input, sends it to the home chain where the market actually is, and pays
//! out whatever comes back.
//!
//! ## What is genuinely different from the EVM version
//!
//! Two things, and neither is a translation of the Solidity — they are why this is a separate
//! implementation rather than a port.
//!
//! **1. Compose is inverted.** On EVM, `endpoint.lzCompose()` *calls into* the contract. The
//! Solana endpoint has no `lz_compose` instruction at all: it has `send_compose` and
//! `clear_compose`. The Executor invokes **this program's own** [`lz_compose`] instruction,
//! which then CPIs `clear_compose` to prove the message was really queued and to consume it.
//! So the program is the entrypoint, not the callee, and `clear_compose` — not a modifier — is
//! what makes a settlement authentic.
//!
//! **2. Every account must be declared before delivery.** Solana builds transactions from a
//! fixed account list, so the Executor asks the program which accounts a delivery will touch
//! *before* it can deliver, via [`lz_compose_types_v2`]. An EVM contract just reaches into
//! whatever storage it wants. That constraint is why a request lives in its own PDA keyed by
//! request id: the account can be named deterministically from the payload, without reading
//! chain state first.
//!
//! ## What carries over unchanged
//!
//! The mechanism. LayerZero's Solana OFT supports composed messages exactly as the EVM one
//! does, so "the tokens and the instruction travel in the same packet" holds on both VMs — and
//! with it the property that neither side can ever be asked to act on a message whose funds
//! have not arrived.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction as SolInstruction;
use anchor_lang::solana_program::program::invoke_signed;
use oapp::common::{AccountMetaRef, AddressLocator, EXECUTION_CONTEXT_VERSION_1};
use oapp::endpoint_cpi;
use oapp::lz_compose_types_v2::{
    self, Instruction as PlannedIx, LzComposeTypesV2Accounts, LzComposeTypesV2Result, LZ_COMPOSE_TYPES_VERSION,
};
use oapp::lz_receive_types_v2::{
    self, Instruction as ReceiveIx, LzReceiveTypesV2Accounts, LzReceiveTypesV2Result, LZ_RECEIVE_TYPES_VERSION,
};
use oapp::{LzComposeParams, LzReceiveParams, LZ_COMPOSE_TYPES_SEED, LZ_RECEIVE_TYPES_SEED};
use endpoint_interface::instructions::RegisterOAppParams;
use endpoint_interface::instructions::oapp::clear_compose::ClearComposeParams;
use endpoint_interface::instructions::oapp::clear::ClearParams;

pub mod abi;
pub mod error;
pub mod spl;
pub mod state;

#[cfg(test)]
mod verify_tests;
#[cfg(test)]
mod partner_tests;

use abi::{ComposeFrame, Order, Settlement};
use error::SwapRequestError;
use state::{Direction, FeeEscrow, FeeState, LzComposeTypesAccounts, NonceIndex, Partner, Request, Status, Store};

declare_id!("6cMiunhoxEcYYT29Cp4PgDT97FjtqsuqZ27ChTbr41vL");

/// Hard ceiling on any partner's fee, whatever the admin registers. Matches the EVM side.
pub const MAX_PARTNER_FEE_BPS: u16 = 300;
/// Hard ceiling on the platform fee. Matches the EVM side.
pub const MAX_PLATFORM_FEE_BPS: u16 = 100;
const BPS: u128 = 10_000;
/// Owner of the fee vault's token accounts: `[b"FeeVault"]`.
pub const FEE_VAULT_SEED: &[u8] = b"FeeVault";

#[program]
pub mod swap_request {
    use super::*;

    // ------------------------------------------------------------------ setup

    /// Creates the store and registers it with the LayerZero endpoint as an OApp.
    ///
    /// The store PDA *is* the OApp identity: it signs outbound sends, so the home-chain relay
    /// sees it as `composeFrom` and can authenticate it as a registered peer.
    pub fn init_store(ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        // A mint below shared precision cannot express what crosses the wire, so refuse it here
        // rather than on the first trade.
        for mint in [&ctx.accounts.base_mint, &ctx.accounts.quote_mint] {
            require!(
                spl::mint_decimals(mint)? >= params.shared_decimals,
                SwapRequestError::UnsupportedDecimals
            );
            // Classic SPL Token or Token-2022, without an extension that breaks a guarantee.
            spl::check_mint(mint)?;
        }
        let base_token_2022 = spl::token_program_of(&ctx.accounts.base_mint)? == spl::TOKEN_2022_PROGRAM_ID;
        let quote_token_2022 = spl::token_program_of(&ctx.accounts.quote_mint)? == spl::TOKEN_2022_PROGRAM_ID;

        let store = &mut ctx.accounts.store;
        store.admin = ctx.accounts.admin.key();
        store.home_eid = params.home_eid;
        store.home_relay = [0u8; 32];
        store.base_mint = ctx.accounts.base_mint.key();
        store.quote_mint = ctx.accounts.quote_mint.key();
        store.base_token_2022 = base_token_2022;
        store.quote_token_2022 = quote_token_2022;
        store.base_oft = params.base_oft;
        store.quote_oft = params.quote_oft;
        store.endpoint_program = params.endpoint_program;
        store.next_request_id = 1;
        store.bump = ctx.bumps.store;
        store.shared_decimals = params.shared_decimals;
        store.oft_program = params.oft_program;

        let types = &mut ctx.accounts.lz_compose_types_accounts;
        types.store = store.key();
        types.base_mint = store.base_mint;
        types.quote_mint = store.quote_mint;

        // Registering makes the endpoint recognise this PDA as an OApp it will deliver to.
        endpoint_cpi::register_oapp(
            params.endpoint_program,
            store.key(),
            ctx.remaining_accounts,
            &[Store::SEED, &[store.bump]],
            RegisterOAppParams { delegate: params.delegate },
        )
    }

    /// Points this store at the home-chain SwapRelay.
    ///
    /// Stored as `bytes32` because that is how LayerZero addresses every chain — the same field
    /// holds an EVM address (left-padded) or a Solana pubkey without either being truncated.
    pub fn set_home_relay(ctx: Context<AdminOnly>, relay: [u8; 32]) -> Result<()> {
        ctx.accounts.store.home_relay = relay;
        Ok(())
    }

    // ------------------------------------------------------------------ user entrypoint

    /// Opens a trade: records it, escrows the user's input, and dispatches it to the home chain.
    ///
    /// The OFT `send` is performed by CPI **from this program**, with the store PDA signing, so
    /// the home-chain relay sees `composeFrom == store` and can authenticate it. If the user
    /// called the OFT directly instead, `composeFrom` would be the user's own key and the relay
    /// would — correctly — reject the order as coming from an unregistered source.
    ///
    /// The OFT's own account list is passed through `remaining_accounts`: this program does not
    /// depend on the OFT crate, it just forwards and signs. That keeps the two programs
    /// independently upgradeable and avoids pinning to a specific OFT build.
    pub fn open_request<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenRequest<'info>>,
        params: OpenRequestParams,
    ) -> Result<()> {
        // Closed while partners are required: the only way in is then `open_request_via_partner`.
        require!(!ctx.accounts.store.partner_required, SwapRequestError::PartnerRequired);
        let bump = ctx.bumps.request;
        open(ctx.accounts, bump, ctx.remaining_accounts, ctx.program_id, params).map(|_| ())
    }

    /// Opens a trade through a registered partner, with its fee.
    ///
    /// The partner's authoriser key must co-sign the transaction. That is the Solana form of the
    /// EVM side's EIP-712 authorisation: the partner's backend inspects the transaction the user
    /// will send — who, which direction, how much, what fee — and adds its signature only if it
    /// approves that exact order. A transaction executes at most once and its blockhash expires,
    /// so the signature cannot be replayed or held for later.
    ///
    /// Fees come off the input and are held in the fee vault until [`settle_fees`] releases
    /// them: to the partner and the platform if the request filled, back to the user otherwise.
    pub fn open_request_via_partner<'info>(
        ctx: Context<'_, '_, 'info, 'info, OpenPartnerRequest<'info>>,
        params: OpenRequestParams,
        fee_bps: u16,
    ) -> Result<()> {
        let partner = &ctx.accounts.partner;
        check_partner(partner, &ctx.accounts.partner_signer.key(), fee_bps)?;

        let store = &ctx.accounts.base.store;
        let fees = compute_fees(params.amount_in, fee_bps, store.platform_fee_bps)?;
        require!(fees.net > 0, SwapRequestError::ZeroAmount);

        let (vault, _) = Pubkey::find_program_address(&[FEE_VAULT_SEED], ctx.program_id);
        let mint_key = ctx.accounts.base.token_in_mint.key();
        // Checked before the fee moves: a stand-in token program could report a fee transfer
        // that never happened, and settle_fees would then pay it out of other orders' fees.
        let expected_in = match params.direction {
            Direction::Buy => store.quote_mint,
            Direction::Sell => store.base_mint,
        };
        require_keys_eq!(mint_key, expected_in, SwapRequestError::WrongMint);
        require_keys_eq!(
            ctx.accounts.base.token_program.key(),
            store.token_program_for(&mint_key),
            SwapRequestError::UnsupportedTokenProgram
        );
        require_keys_eq!(
            ctx.accounts.fee_vault_token_account.key(),
            spl::associated_token_address(&vault, &mint_key, &store.token_program_for(&mint_key)),
            SwapRequestError::WrongTokenAccount
        );

        let request_id = store.next_request_id;
        let escrow = &mut ctx.accounts.fee_escrow;
        escrow.request_id = request_id;
        escrow.partner_id = partner.partner_id;
        escrow.user = ctx.accounts.base.user.key();
        escrow.mint = mint_key;
        escrow.partner_recipient = partner.fee_recipient;
        escrow.platform_recipient = store.platform_fee_recipient;
        escrow.partner_fee = fees.partner;
        escrow.platform_fee = fees.platform;
        escrow.state = if fees.partner + fees.platform > 0 { FeeState::Escrowed } else { FeeState::None };
        escrow.bump = ctx.bumps.fee_escrow;

        if fees.partner + fees.platform > 0 {
            let decimals = spl::mint_decimals(&ctx.accounts.base.token_in_mint)?;
            spl::transfer_checked(
                &ctx.accounts.base.token_program,
                &ctx.accounts.base.user_token_account,
                &ctx.accounts.base.token_in_mint,
                &ctx.accounts.fee_vault_token_account,
                &ctx.accounts.base.user.to_account_info(),
                fees.partner + fees.platform,
                decimals,
            )?;
        }

        let partner_id = partner.partner_id;
        let bump = ctx.bumps.base.request;
        let net_params = OpenRequestParams { amount_in: fees.net, ..params };
        let opened = open(&mut ctx.accounts.base, bump, ctx.remaining_accounts, ctx.program_id, net_params)?;
        require!(opened == request_id, SwapRequestError::RequestMismatch);

        emit!(FeesEscrowed { request_id, partner_id, partner_fee: fees.partner, platform_fee: fees.platform });
        Ok(())
    }

    /// Releases a finished request's fees. Permissionless: anyone may pay to run it, and the
    /// destinations are fixed by the escrow record, so it can only ever pay whom it must.
    ///
    /// Filled: the partner's fee to the partner and the platform's to the platform. Refunded,
    /// cancelled or stranded: the whole fee back to the user — a strand may follow a fill whose
    /// return leg failed, and the user is not charged for an order they did not receive here.
    pub fn settle_fees(ctx: Context<SettleFees>) -> Result<()> {
        let escrow = &ctx.accounts.fee_escrow;
        require!(escrow.state == FeeState::Escrowed, SwapRequestError::FeesNotEscrowed);
        let payout = fee_payout(ctx.accounts.request.status, escrow)?;

        let a = &ctx.accounts;
        require_keys_eq!(a.mint.key(), escrow.mint, SwapRequestError::WrongMint);
        let token_program = spl::token_program_of(&a.mint)?;
        require_keys_eq!(a.token_program.key(), token_program, SwapRequestError::UnsupportedTokenProgram);
        let (vault, vault_bump) = Pubkey::find_program_address(&[FEE_VAULT_SEED], ctx.program_id);
        require_keys_eq!(a.fee_vault.key(), vault, SwapRequestError::WrongTokenAccount);
        require_keys_eq!(
            a.fee_vault_token_account.key(),
            spl::associated_token_address(&vault, &escrow.mint, &token_program),
            SwapRequestError::WrongTokenAccount
        );

        let decimals = spl::mint_decimals(&a.mint)?;
        let seeds: &[&[u8]] = &[FEE_VAULT_SEED, &[vault_bump]];
        for (amount, owner, dest) in [
            (payout.partner, escrow.partner_recipient, &a.partner_token_account),
            (payout.platform, escrow.platform_recipient, &a.platform_token_account),
            (payout.user, escrow.user, &a.user_token_account),
        ] {
            if amount == 0 {
                continue;
            }
            require_keys_eq!(
                dest.key(),
                spl::associated_token_address(&owner, &escrow.mint, &token_program),
                SwapRequestError::WrongTokenAccount
            );
            spl::transfer_checked_signed(
                &a.token_program,
                &a.fee_vault_token_account,
                &a.mint,
                dest,
                &a.fee_vault,
                amount,
                decimals,
                seeds,
            )?;
        }

        let request_id = escrow.request_id;
        let escrow = &mut ctx.accounts.fee_escrow;
        escrow.state = if payout.user > 0 { FeeState::Returned } else { FeeState::Paid };
        emit!(FeesSettled { request_id, partner: payout.partner, platform: payout.platform, user: payout.user });
        Ok(())
    }

    // ------------------------------------------------------------------ partner admin

    /// Registers a partner. Its authoriser co-signs the orders it approves; its fees are paid
    /// to `fee_recipient`'s token account for the input mint.
    pub fn register_partner(ctx: Context<RegisterPartner>, partner_id: u32, terms: PartnerTerms) -> Result<()> {
        validate_terms(partner_id, &terms)?;
        let p = &mut ctx.accounts.partner;
        p.partner_id = partner_id;
        p.bump = ctx.bumps.partner;
        apply_terms(p, &terms);
        emit!(PartnerSet { partner_id, signer: terms.signer, fee_recipient: terms.fee_recipient, max_fee_bps: terms.max_fee_bps, active: terms.active });
        Ok(())
    }

    /// Updates or deactivates a partner. Deactivating stops new orders at once; fees already
    /// escrowed are unaffected.
    pub fn update_partner(ctx: Context<UpdatePartner>, terms: PartnerTerms) -> Result<()> {
        let p = &mut ctx.accounts.partner;
        validate_terms(p.partner_id, &terms)?;
        apply_terms(p, &terms);
        emit!(PartnerSet { partner_id: p.partner_id, signer: terms.signer, fee_recipient: terms.fee_recipient, max_fee_bps: terms.max_fee_bps, active: terms.active });
        Ok(())
    }

    /// Closes (or reopens) `open_request` to orders without a partner.
    pub fn set_partner_required(ctx: Context<AdminOnly>, required: bool) -> Result<()> {
        ctx.accounts.store.partner_required = required;
        Ok(())
    }

    pub fn set_platform_fee(ctx: Context<AdminOnly>, bps: u16, recipient: Pubkey) -> Result<()> {
        require!(bps <= MAX_PLATFORM_FEE_BPS, SwapRequestError::FeeTooHigh);
        require!(bps == 0 || recipient != Pubkey::default(), SwapRequestError::InvalidPartner);
        ctx.accounts.store.platform_fee_bps = bps;
        ctx.accounts.store.platform_fee_recipient = recipient;
        Ok(())
    }

    // ------------------------------------------------------------------ LayerZero composer

    // ------------------------------------------------------------------ LayerZero receiver

    /// Version discovery for plain OApp messages — the home chain's STRANDED and CANCELLED
    /// notices, which carry no tokens and so arrive by `lz_receive`, not by compose.
    ///
    /// Also where a CANCELLED notice's lookup starts: the notice names a killed message by
    /// path and nonce, so the planning step needs the [`NonceIndex`] for it, derived here from
    /// the message and passed along.
    pub fn lz_receive_types_info(
        ctx: Context<LzReceiveTypes>,
        params: LzReceiveParams,
    ) -> Result<(u8, LzReceiveTypesV2Accounts)> {
        let mut accounts = vec![ctx.accounts.store.key(), ctx.accounts.lz_receive_types_accounts.key()];
        let notice = Settlement::decode(&params.message)?;
        if notice.status == Status::Cancelled as u8 {
            accounts.push(nonce_index_address(ctx.program_id, &notice));
        }
        Ok((LZ_RECEIVE_TYPES_VERSION, LzReceiveTypesV2Accounts { accounts }))
    }

    /// Plans a notice delivery. A CANCELLED one mints the input back to the user through the
    /// OFT's recovery path, so it names the OFT's accounts and the user's token account — the
    /// user and mint come from the [`NonceIndex`], since the request itself cannot be read here.
    pub fn lz_receive_types_v2(
        ctx: Context<LzReceiveTypes>,
        params: LzReceiveParams,
    ) -> Result<LzReceiveTypesV2Result> {
        let store = &ctx.accounts.store;
        let notice = Settlement::decode(&params.message)?;

        let mut instructions = vec![];
        let mut accounts = vec![AccountMetaRef { pubkey: store.key().into(), is_writable: true }];

        let mut extras: Vec<AccountMetaRef> = vec![];
        if notice.status == Status::Cancelled as u8 {
            let index_info = ctx.remaining_accounts.first().ok_or(SwapRequestError::RequestMismatch)?;
            require_keys_eq!(index_info.key(), nonce_index_address(ctx.program_id, &notice), SwapRequestError::RequestMismatch);
            let index = NonceIndex::try_deserialize(&mut &index_info.try_borrow_data()?[..])?;
            let (request, _) = Pubkey::find_program_address(&[Request::SEED, &index.request_id.to_be_bytes()], ctx.program_id);
            accounts.push(AccountMetaRef { pubkey: request.into(), is_writable: true });

            let oft_store = Pubkey::new_from_array(notice.cancelled_path);
            let token_program = store.token_program_for(&index.token_in);
            let user_ata = spl::associated_token_address(&index.user, &index.token_in, &token_program);
            instructions.push(ReceiveIx::Standard {
                program_id: spl::ASSOCIATED_TOKEN_PROGRAM_ID,
                accounts: vec![
                    AccountMetaRef { pubkey: AddressLocator::Payer, is_writable: true },
                    AccountMetaRef { pubkey: user_ata.into(), is_writable: true },
                    AccountMetaRef { pubkey: index.user.into(), is_writable: false },
                    AccountMetaRef { pubkey: index.token_in.into(), is_writable: false },
                    AccountMetaRef { pubkey: System::id().into(), is_writable: false },
                    AccountMetaRef { pubkey: token_program.into(), is_writable: false },
                ],
                data: vec![spl::ATA_CREATE_IDEMPOTENT_TAG],
            });
            extras = vec![
                AccountMetaRef { pubkey: index_info.key().into(), is_writable: false },
                AccountMetaRef { pubkey: store.oft_program.into(), is_writable: false },
                AccountMetaRef { pubkey: recovery_minter_address(&store.oft_program, &oft_store).into(), is_writable: false },
                // Writable: a recovery credit counts as an arrival on the OFT's flow counters.
                AccountMetaRef { pubkey: oft_store.into(), is_writable: true },
                AccountMetaRef { pubkey: index.token_in.into(), is_writable: true },
                AccountMetaRef { pubkey: user_ata.into(), is_writable: true },
                AccountMetaRef { pubkey: token_program.into(), is_writable: false },
            ];
        } else {
            let (request, _) = Pubkey::find_program_address(&[Request::SEED, &notice.request_id.to_be_bytes()], ctx.program_id);
            accounts.push(AccountMetaRef { pubkey: request.into(), is_writable: true });
        }

        // `clear`'s accounts first in `remaining_accounts`, then the recovery accounts.
        accounts.extend(lz_receive_types_v2::get_accounts_for_clear(
            store.endpoint_program,
            &store.key(),
            params.src_eid,
            &params.sender,
            params.nonce,
        ));
        accounts.extend(extras);
        instructions.push(ReceiveIx::LzReceive { accounts });

        Ok(LzReceiveTypesV2Result { context_version: EXECUTION_CONTEXT_VERSION_1, alts: vec![], instructions })
    }

    /// Applies a STRANDED or CANCELLED notice from the home chain.
    ///
    /// STRANDED: the result exists on the home chain but cannot cross; the request becomes
    /// terminal so the user knows to claim it there. CANCELLED: the outbound message was killed
    /// on the home chain — never delivered, never to be — so the input, burned when it left,
    /// is minted back to the user for exactly the amount this chain recorded.
    pub fn lz_receive<'info>(
        ctx: Context<'_, '_, 'info, 'info, LzReceive<'info>>,
        params: LzReceiveParams,
    ) -> Result<()> {
        let store = &ctx.accounts.store;
        let notice = verify_notice(store, &params)?;
        let clear_len = CLEAR_ACCOUNTS;
        require!(ctx.remaining_accounts.len() >= clear_len, SwapRequestError::MalformedPayload);

        // Every submitter-chosen account is proven before anything happens.
        let recovery = if notice.status == Status::Cancelled as u8 {
            let extra = &ctx.remaining_accounts[clear_len..];
            require!(extra.len() >= 7, SwapRequestError::MalformedPayload);
            let index = NonceIndex::try_deserialize(&mut &extra[0].try_borrow_data()?[..])?;
            verify_cancellation(
                store,
                ctx.program_id,
                &notice,
                &ctx.accounts.request.key(),
                &ctx.accounts.request.user,
                &CancellationAccounts {
                    nonce_index: extra[0].key(),
                    index: &index,
                    oft_program: extra[1].key(),
                    oft_store: extra[3].key(),
                    token_mint: extra[4].key(),
                    token_dest: extra[5].key(),
                },
            )?;
            Some((extra, index.request_id))
        } else {
            let (expected, _) = Pubkey::find_program_address(&[Request::SEED, &notice.request_id.to_be_bytes()], ctx.program_id);
            require_keys_eq!(ctx.accounts.request.key(), expected, SwapRequestError::RequestMismatch);
            None
        };

        // Consume the message: authenticates it and makes replay impossible.
        let store_bump = store.bump;
        endpoint_cpi::clear(
            store.endpoint_program,
            store.key(),
            &ctx.remaining_accounts[..clear_len],
            &[Store::SEED, &[store_bump]],
            ClearParams {
                receiver: store.key(),
                src_eid: params.src_eid,
                sender: params.sender,
                nonce: params.nonce,
                guid: params.guid,
                message: params.message.clone(),
            },
        )?;

        let store_info = ctx.accounts.store.to_account_info();
        let request = &mut ctx.accounts.request;
        if request.status != Status::Pending {
            return Ok(()); // already settled; nothing owed, and a replay pays nothing
        }
        request.settled_at = Clock::get()?.unix_timestamp;

        match recovery {
            Some((extra, request_id)) => {
                request.status = Status::Cancelled;
                let (user, amount) = (request.user, request.amount_in);
                recovery_credit(extra, &store_info, &[Store::SEED, &[store_bump]], amount)?;
                emit!(SwapCancelled { request_id, user, lz_nonce: notice.lz_nonce, amount });
            }
            None => {
                request.status = Status::Stranded;
                request.failure_reason = notice.reason;
                emit!(SwapStranded { request_id: notice.request_id, user: request.user, amount_sd: notice.amount_in as u64 });
            }
        }
        Ok(())
    }

    /// Version discovery for the Executor: which planning protocol this composer speaks, and
    /// which accounts to pass when asking it for a plan.
    ///
    /// The first call LayerZero's Executor makes before delivering a composed message. Version
    /// 2 means "call `lz_compose_types_v2` with these accounts and it will return the complete
    /// set of instructions to execute".
    ///
    /// Takes the compose params because LayerZero's Executor sends them (see the SDK's
    /// `getLzComposeTypesInfo`); this composer's answer does not depend on them.
    pub fn lz_compose_types_info(
        ctx: Context<LzComposeTypes>,
        _params: LzComposeParams,
    ) -> Result<(u8, LzComposeTypesV2Accounts)> {
        Ok((
            LZ_COMPOSE_TYPES_VERSION,
            LzComposeTypesV2Accounts {
                accounts: vec![ctx.accounts.store.key(), ctx.accounts.lz_compose_types_accounts.key()],
            },
        ))
    }

    /// Plans a settlement delivery: every instruction and every account it will touch.
    ///
    /// Called **before** delivery, because Solana builds transactions from a fixed account list.
    /// Everything here is derived from the message alone — the request PDA from the request id,
    /// the user's token account from the settlement's recipient — which is why the settlement
    /// has to carry the recipient at all: this instruction cannot read the request to find out.
    ///
    /// Two instructions: create the user's token account if they have never held this asset
    /// (idempotent, paid by the Executor), then `lz_compose` itself.
    pub fn lz_compose_types_v2(
        ctx: Context<LzComposeTypes>,
        params: LzComposeParams,
    ) -> Result<LzComposeTypesV2Result> {
        let store = &ctx.accounts.store;
        let mint = delivered_mint(store, &params.from)?;
        let frame = ComposeFrame::parse(&params.message)?;
        let settlement = Settlement::decode(&frame.compose_msg)?;
        let user = Pubkey::new_from_array(settlement.recipient);

        let (request, _) = Pubkey::find_program_address(
            &[Request::SEED, &settlement.request_id.to_be_bytes()],
            ctx.program_id,
        );
        let token_program = store.token_program_for(&mint);
        let user_ata = spl::associated_token_address(&user, &mint, &token_program);
        let store_ata = spl::associated_token_address(&store.key(), &mint, &token_program);

        let create_user_ata = PlannedIx::Standard {
            program_id: spl::ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMetaRef { pubkey: AddressLocator::Payer, is_writable: true },
                AccountMetaRef { pubkey: user_ata.into(), is_writable: true },
                AccountMetaRef { pubkey: user.into(), is_writable: false },
                AccountMetaRef { pubkey: mint.into(), is_writable: false },
                AccountMetaRef { pubkey: System::id().into(), is_writable: false },
                AccountMetaRef { pubkey: token_program.into(), is_writable: false },
            ],
            data: vec![spl::ATA_CREATE_IDEMPOTENT_TAG],
        };

        // Order matches the `LzCompose` accounts struct, then `clear_compose`'s accounts, which
        // the handler forwards as `remaining_accounts`.
        let mut compose_accounts = vec![
            AccountMetaRef { pubkey: store.key().into(), is_writable: true },
            AccountMetaRef { pubkey: request.into(), is_writable: true },
            AccountMetaRef { pubkey: mint.into(), is_writable: false },
            AccountMetaRef { pubkey: store_ata.into(), is_writable: true },
            AccountMetaRef { pubkey: user_ata.into(), is_writable: true },
            AccountMetaRef { pubkey: token_program.into(), is_writable: false },
        ];
        compose_accounts.extend(lz_compose_types_v2::get_accounts_for_clear_compose(
            store.endpoint_program,
            &params.from,
            &store.key(),
            &params.guid,
            params.index,
            &params.message,
        ));

        Ok(LzComposeTypesV2Result {
            context_version: EXECUTION_CONTEXT_VERSION_1,
            alts: vec![],
            instructions: vec![create_user_ata, PlannedIx::LzCompose { accounts: compose_accounts }],
        })
    }

    /// Receives a settlement from the home chain, pays the user, and closes out the request.
    ///
    /// One handler covers both outcomes, as on EVM: a fill delivers the output asset, a refund
    /// returns the input. Either way tokens arrived — minted by the OFT into the store's token
    /// account — and they go straight on to the user.
    ///
    /// Anyone can submit this instruction and choose its accounts, so nothing is taken on
    /// trust: see [`verify_settlement`] for every check, and `clear_compose` for the last one.
    ///
    /// STRANDED and CANCELLED notices do not arrive here — the home chain sends those as plain
    /// OApp messages, which need an `lz_receive` this program does not have yet.
    pub fn lz_compose(ctx: Context<LzCompose>, params: LzComposeParams) -> Result<()> {
        let store = &ctx.accounts.store;

        let VerifiedSettlement { mint: _, frame, settlement } = verify_settlement(
            store,
            &store.key(),
            ctx.program_id,
            &params,
            &ctx.accounts.request.key(),
            &ctx.accounts.request.user,
            &DeliveryAccounts {
                mint: ctx.accounts.mint.key(),
                store_token_account: ctx.accounts.store_token_account.key(),
                user_token_account: ctx.accounts.user_token_account.key(),
                token_program: ctx.accounts.token_program.key(),
            },
        )?;
        let user = ctx.accounts.request.user;

        // Consume the queued compose. This both authenticates the message and makes replay
        // impossible: a second attempt finds nothing to clear.
        let store_bump = store.bump;
        endpoint_cpi::clear_compose(
            store.endpoint_program,
            store.key(),
            ctx.remaining_accounts,
            &[Store::SEED, &[store_bump]],
            ClearComposeParams {
                from: params.from,
                guid: params.guid,
                index: params.index,
                message: params.message.clone(),
            },
        )?;

        // Pay out exactly what the OFT delivered — the frame's figure, not the settlement's,
        // which is informational and in shared decimals.
        let amount = frame.amount_ld;
        if amount > 0 {
            let decimals = spl::mint_decimals(&ctx.accounts.mint)?;
            spl::transfer_checked_signed(
                &ctx.accounts.token_program,
                &ctx.accounts.store_token_account,
                &ctx.accounts.mint,
                &ctx.accounts.user_token_account,
                &ctx.accounts.store.to_account_info(),
                amount,
                decimals,
                &[Store::SEED, &[store_bump]],
            )?;
        }

        let request = &mut ctx.accounts.request;

        // A settlement for a request that is no longer pending. Reverting would leave the
        // compose permanently failing with the tokens stuck in the store; they are this user's
        // whatever the sequencing, so they have been paid above and the record stays as it was.
        // Matches `SwapRequest.lzCompose` on EVM.
        if request.status != Status::Pending {
            emit!(LateSettlementPaid { request_id: settlement.request_id, user, amount });
            return Ok(());
        }

        request.settled_at = Clock::get()?.unix_timestamp;

        if settlement.status == Status::Filled as u8 {
            request.status = Status::Filled;
            request.amount_out = amount;
            emit!(SwapFilled { request_id: settlement.request_id, user, amount_out: amount });
        } else {
            // Anything else that arrives with tokens is the input coming back.
            request.status = Status::Refunded;
            request.failure_reason = settlement.reason;
            emit!(SwapRefunded {
                request_id: settlement.request_id,
                user,
                amount,
                reason: settlement.reason,
            });
        }

        Ok(())
    }
}

/// The body of `open_request`, shared with `open_request_via_partner`: validate, escrow the
/// input, record the request, dispatch it to the home chain, and index its nonce.
/// Returns the request id.
fn open<'info>(
    a: &mut OpenRequest<'info>,
    request_bump: u8,
    remaining: &[AccountInfo<'info>],
    program_id: &Pubkey,
    params: OpenRequestParams,
) -> Result<u64> {
    require!(params.amount_in > 0, SwapRequestError::ZeroAmount);
    require!(a.store.home_relay != [0u8; 32], SwapRequestError::PeerNotSet);
    // The OFT send below is signed as the store. A caller-chosen program would receive that
    // signature — and with it the power to send as this OApp and to mint by recovery.
    require_keys_eq!(
        a.oft_program.key(),
        a.store.oft_program,
        SwapRequestError::WrongOftProgram
    );

    let store = &mut a.store;
    let (expected_in, expected_out) = match params.direction {
        Direction::Buy => (store.quote_mint, store.base_mint),
        Direction::Sell => (store.base_mint, store.quote_mint),
    };
    require_keys_eq!(a.token_in_mint.key(), expected_in, SwapRequestError::WrongMint);
    require_keys_eq!(a.token_out_mint.key(), expected_out, SwapRequestError::WrongMint);
    // The input's own token program, never a caller's choice: a stand-in program could report
    // a transfer that never happened.
    require_keys_eq!(
        a.token_program.key(),
        store.token_program_for(&expected_in),
        SwapRequestError::UnsupportedTokenProgram
    );

    // Anything below the bridge's precision floor crosses as zero, which would leave a
    // request that can never settle. Same guard as the EVM side, and found there by the
    // invariant fuzzer. The quantum is derived from the mint, not taken from the caller.
    let decimals = spl::mint_decimals(&a.token_in_mint)?;
    let quantum = 10u64
        .checked_pow(u32::from(decimals.saturating_sub(store.shared_decimals)))
        .ok_or(SwapRequestError::UnsupportedDecimals)?;
    let quantised = params.amount_in - (params.amount_in % quantum);
    require!(quantised > 0, SwapRequestError::AmountBelowBridgeableMinimum);

    // The floor crosses in shared decimals, rounded up so conversion never loosens it.
    let out_decimals = spl::mint_decimals(&a.token_out_mint)?;
    let min_out_sd = abi::ld_to_sd_ceil(params.min_amount_out, out_decimals, store.shared_decimals)?;

    let request_id = store.next_request_id;
    store.next_request_id = request_id
        .checked_add(1)
        .ok_or(SwapRequestError::PayloadValueTooLarge)?;

    let (token_in, token_out) = match params.direction {
        Direction::Buy => (store.quote_mint, store.base_mint),
        Direction::Sell => (store.base_mint, store.quote_mint),
    };

    // Move the user's input into the program's escrow. Only the quantised part travels;
    // the remainder stays with the user rather than being stranded here.
    spl::transfer_checked(
        &a.token_program,
        &a.user_token_account,
        &a.token_in_mint,
        &a.escrow_token_account,
        &a.user.to_account_info(),
        quantised,
        decimals,
    )?;

    let request = &mut a.request;
    request.user = a.user.key();
    request.direction = params.direction;
    request.token_in = token_in;
    request.token_out = token_out;
    request.amount_in = quantised;
    request.min_amount_out = params.min_amount_out;
    request.amount_out = 0;
    request.created_at = Clock::get()?.unix_timestamp;
    request.settled_at = 0;
    request.status = Status::Pending;
    request.failure_reason = 0;
    request.bump = request_bump;

    // The order rides as the OFT's composeMsg, so funds and instruction arrive together.
    let order = Order {
        request_id,
        direction: params.direction as u8,
        min_amount_out: u128::from(min_out_sd),
        recipient: a.user.key().to_bytes(),
    };

    let store_bump = store.bump;
    let store_key = store.key();
    let oft_store = match params.direction {
        Direction::Buy => store.quote_oft,
        Direction::Sell => store.base_oft,
    };
    dispatch_oft_send(
        &a.oft_program.key(),
        remaining,
        &store_key,
        &[Store::SEED, &[store_bump]],
        OftSendArgs {
            dst_eid: store.home_eid,
            to: store.home_relay,
            amount_ld: quantised,
            min_amount_ld: quantised,
            options: params.options,
            compose_msg: Some(order.encode()),
            native_fee: params.native_fee,
            lz_token_fee: params.lz_token_fee,
        },
    )?;

    // Record the message's nonce against the request. Without it a message that never
    // arrives cannot even be named, so it could never be cancelled; it is also the only
    // moment it can be learned — `send` returns it and nothing stores it.
    let lz_nonce = sent_nonce(&a.oft_program.key())?;
    a.request.lz_nonce = lz_nonce;
    create_nonce_index(
        &a.nonce_index,
        &a.user,
        &a.system_program,
        program_id,
        &oft_store,
        lz_nonce,
        NonceIndex { request_id, user: a.user.key(), token_in },
    )?;

    emit!(SwapRequested {
        request_id,
        user: a.user.key(),
        direction: params.direction as u8,
        amount_in: quantised,
        min_amount_out: params.min_amount_out,
    });
        Ok(request_id)
}

/// The accounts a delivery names for moving tokens, as the submitter supplied them.
pub struct DeliveryAccounts {
    pub mint: Pubkey,
    pub store_token_account: Pubkey,
    pub user_token_account: Pubkey,
    pub token_program: Pubkey,
}

/// What `lz_compose` may act on once every check has passed.
pub struct VerifiedSettlement {
    pub mint: Pubkey,
    pub frame: ComposeFrame,
    pub settlement: Settlement,
}

/// Every check `lz_compose` makes before touching state or tokens, as a pure function.
///
/// **Anyone can submit `lz_compose` and choose its accounts**, so each one is proven rather
/// than trusted. Kept free of `Context` so the rejections can be unit-tested without a Solana
/// runtime — they are the security-relevant part of the instruction.
///
/// `clear_compose` is the remaining check, and the one only the endpoint can make: that this
/// exact message really was queued for this store by `params.from`.
pub fn verify_settlement(
    store: &Store,
    store_key: &Pubkey,
    program_id: &Pubkey,
    params: &LzComposeParams,
    request_key: &Pubkey,
    request_user: &Pubkey,
    accounts: &DeliveryAccounts,
) -> Result<VerifiedSettlement> {
    // The delivering program must be one of this store's OFTs. On EVM the equivalent check
    // is `_from == baseOft || _from == quoteOft`.
    let mint = delivered_mint(store, &params.from)?;

    // The OFT wraps the settlement in its own frame. Decoding the frame as though it were the
    // settlement — as an earlier version did — rejects every delivery.
    let frame = ComposeFrame::parse(&params.message)?;
    require!(frame.src_eid == store.home_eid, SwapRequestError::UnexpectedOrigin);
    require!(
        store.home_relay != [0u8; 32] && frame.compose_from == store.home_relay,
        SwapRequestError::UnauthorizedSource
    );
    let settlement = Settlement::decode(&frame.compose_msg)?;

    // Bind the request to the settlement: without this, one settlement could close out a
    // different user's pending request.
    let (expected_request, _) =
        Pubkey::find_program_address(&[Request::SEED, &settlement.request_id.to_be_bytes()], program_id);
    require_keys_eq!(*request_key, expected_request, SwapRequestError::RequestMismatch);
    require!(settlement.recipient == request_user.to_bytes(), SwapRequestError::RecipientMismatch);

    // Token accounts are derived, not accepted: a submitter who could name the destination
    // could take the payout.
    require_keys_eq!(accounts.mint, mint, SwapRequestError::WrongMint);
    let token_program = store.token_program_for(&mint);
    require_keys_eq!(accounts.token_program, token_program, SwapRequestError::UnsupportedTokenProgram);
    require_keys_eq!(
        accounts.store_token_account,
        spl::associated_token_address(store_key, &mint, &token_program),
        SwapRequestError::WrongTokenAccount
    );
    require_keys_eq!(
        accounts.user_token_account,
        spl::associated_token_address(request_user, &mint, &token_program),
        SwapRequestError::WrongTokenAccount
    );

    Ok(VerifiedSettlement { mint, frame, settlement })
}

/// Accounts `endpoint::clear` takes, which lead `lz_receive`'s `remaining_accounts`.
pub const CLEAR_ACCOUNTS: usize = 8;

/// Anchor discriminator of the OFT's `recovery_credit` — a CrossStock addition to the vendored
/// OFT (`solana/vendor/oft-solana/LOCAL_CHANGES.md`). sha256("global:recovery_credit")[..8].
const OFT_RECOVERY_CREDIT_DISCRIMINATOR: [u8; 8] = [0x89, 0x84, 0xe7, 0xcd, 0x39, 0x4d, 0x2b, 0x3d];

/// The [`NonceIndex`] a CANCELLED notice points at: `[b"Nonce", oft_store, nonce]`.
pub fn nonce_index_address(program_id: &Pubkey, notice: &Settlement) -> Pubkey {
    Pubkey::find_program_address(
        &[NonceIndex::SEED, &notice.cancelled_path, &notice.lz_nonce.to_be_bytes()],
        program_id,
    )
    .0
}

/// The OFT's record of who may mint by recovery: `[b"RecoveryMinter", oft_store]`.
pub fn recovery_minter_address(oft_program: &Pubkey, oft_store: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"RecoveryMinter", oft_store.as_ref()], oft_program).0
}

/// The nonce of the message the OFT `send` just dispatched, from its return data:
/// `(MessagingReceipt { guid: [u8; 32], nonce: u64, fee }, OFTReceipt)`, Borsh-encoded.
fn sent_nonce(oft_program: &Pubkey) -> Result<u64> {
    let (program, data) = anchor_lang::solana_program::program::get_return_data()
        .ok_or(SwapRequestError::MalformedPayload)?;
    require_keys_eq!(program, *oft_program, SwapRequestError::WrongOftProgram);
    require!(data.len() >= 40, SwapRequestError::MalformedPayload);
    Ok(u64::from_le_bytes(data[32..40].try_into().unwrap()))
}

/// Creates the [`NonceIndex`] PDA for a just-sent message. The address depends on the nonce,
/// which is only known after the send, so it is created here rather than by an Anchor `init`.
fn create_nonce_index<'info>(
    account: &AccountInfo<'info>,
    payer: &Signer<'info>,
    system_program: &Program<'info, System>,
    program_id: &Pubkey,
    oft_store: &Pubkey,
    nonce: u64,
    index: NonceIndex,
) -> Result<()> {
    let nonce_be = nonce.to_be_bytes();
    let (expected, bump) =
        Pubkey::find_program_address(&[NonceIndex::SEED, oft_store.as_ref(), &nonce_be], program_id);
    require_keys_eq!(account.key(), expected, SwapRequestError::RequestMismatch);

    let rent = Rent::get()?.minimum_balance(NonceIndex::SIZE);
    anchor_lang::system_program::create_account(
        CpiContext::new(
            system_program.to_account_info(),
            anchor_lang::system_program::CreateAccount { from: payer.to_account_info(), to: account.clone() },
        )
        .with_signer(&[&[NonceIndex::SEED, oft_store.as_ref(), &nonce_be, &[bump]]]),
        rent,
        NonceIndex::SIZE as u64,
        program_id,
    )?;
    index.try_serialize(&mut &mut account.try_borrow_mut_data()?[..])
}

/// Every check `lz_receive` makes on the message itself: it came from the home relay, on the
/// home chain, and is a notice this program handles.
pub fn verify_notice(store: &Store, params: &LzReceiveParams) -> Result<Settlement> {
    require!(params.src_eid == store.home_eid, SwapRequestError::UnexpectedOrigin);
    require!(
        store.home_relay != [0u8; 32] && params.sender == store.home_relay,
        SwapRequestError::UnauthorizedSource
    );
    let notice = Settlement::decode(&params.message)?;
    require!(
        notice.status == Status::Stranded as u8 || notice.status == Status::Cancelled as u8,
        SwapRequestError::UnknownSettlementStatus
    );
    Ok(notice)
}

/// The accounts a CANCELLED delivery names, as the submitter supplied them.
pub struct CancellationAccounts<'a> {
    pub nonce_index: Pubkey,
    pub index: &'a NonceIndex,
    pub oft_program: Pubkey,
    pub oft_store: Pubkey,
    pub token_mint: Pubkey,
    pub token_dest: Pubkey,
}

/// Every check before a cancellation mints anything. The mint is real supply, so each account
/// the submitter chose is proven: the index is the one the notice names, the request is the
/// one the index names, and the mint goes to that request's user, of the asset they paid in,
/// through this store's own OFT.
pub fn verify_cancellation(
    store: &Store,
    program_id: &Pubkey,
    notice: &Settlement,
    request_key: &Pubkey,
    request_user: &Pubkey,
    a: &CancellationAccounts,
) -> Result<()> {
    require_keys_eq!(a.nonce_index, nonce_index_address(program_id, notice), SwapRequestError::RequestMismatch);
    let (request, _) =
        Pubkey::find_program_address(&[Request::SEED, &a.index.request_id.to_be_bytes()], program_id);
    require_keys_eq!(*request_key, request, SwapRequestError::RequestMismatch);
    require_keys_eq!(*request_user, a.index.user, SwapRequestError::RecipientMismatch);

    require_keys_eq!(a.oft_program, store.oft_program, SwapRequestError::WrongOftProgram);
    let path = Pubkey::new_from_array(notice.cancelled_path);
    require_keys_eq!(a.oft_store, path, SwapRequestError::UnexpectedComposeSource);
    require_keys_eq!(a.token_mint, delivered_mint(store, &path)?, SwapRequestError::WrongMint);
    require_keys_eq!(a.token_mint, a.index.token_in, SwapRequestError::WrongMint);
    require_keys_eq!(
        a.token_dest,
        spl::associated_token_address(&a.index.user, &a.token_mint, &store.token_program_for(&a.token_mint)),
        SwapRequestError::WrongTokenAccount
    );
    Ok(())
}

/// Mints `amount` back to the user through the OFT's recovery path, signed as the store.
///
/// `extra` is the recovery tail of `lz_receive`'s accounts: index, OFT program, recovery-minter
/// record, OFT store, mint, destination, token program — already verified by the caller.
fn recovery_credit<'info>(
    extra: &[AccountInfo<'info>],
    store: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    amount: u64,
) -> Result<()> {
    let mut data = OFT_RECOVERY_CREDIT_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = SolInstruction {
        program_id: *extra[1].key,
        accounts: vec![
            AccountMeta::new_readonly(*store.key, true),
            AccountMeta::new_readonly(*extra[2].key, false),
            AccountMeta::new(*extra[3].key, false),
            AccountMeta::new(*extra[4].key, false),
            AccountMeta::new(*extra[5].key, false),
            AccountMeta::new_readonly(*extra[6].key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            store.clone(),
            extra[2].clone(),
            extra[3].clone(),
            extra[4].clone(),
            extra[5].clone(),
            extra[6].clone(),
            extra[1].clone(),
        ],
        &[signer_seeds],
    )
    .map_err(Into::into)
}

/// The mint an OFT delivers, identified by its store PDA as the endpoint reports it.
fn delivered_mint(store: &Store, from: &Pubkey) -> Result<Pubkey> {
    if *from == store.base_oft {
        Ok(store.base_mint)
    } else if *from == store.quote_oft {
        Ok(store.quote_mint)
    } else {
        err!(SwapRequestError::UnexpectedComposeSource)
    }
}

// ---------------------------------------------------------------------------- partners and fees

/// A partner's terms as the admin sets them.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PartnerTerms {
    pub signer: Pubkey,
    pub fee_recipient: Pubkey,
    pub max_fee_bps: u16,
    pub active: bool,
}

pub fn validate_terms(partner_id: u32, t: &PartnerTerms) -> Result<()> {
    require!(
        partner_id != 0 && t.signer != Pubkey::default() && t.fee_recipient != Pubkey::default(),
        SwapRequestError::InvalidPartner
    );
    require!(t.max_fee_bps <= MAX_PARTNER_FEE_BPS, SwapRequestError::FeeTooHigh);
    Ok(())
}

fn apply_terms(p: &mut Partner, t: &PartnerTerms) {
    p.signer = t.signer;
    p.fee_recipient = t.fee_recipient;
    p.max_fee_bps = t.max_fee_bps;
    p.active = t.active;
}

/// Whether `partner` may authorise an order at `fee_bps`, co-signed by `signer`.
pub fn check_partner(partner: &Partner, signer: &Pubkey, fee_bps: u16) -> Result<()> {
    require!(partner.active, SwapRequestError::UnknownPartner);
    require_keys_eq!(*signer, partner.signer, SwapRequestError::InvalidPartnerSigner);
    require!(fee_bps <= partner.max_fee_bps, SwapRequestError::FeeTooHigh);
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub struct Fees {
    pub partner: u64,
    pub platform: u64,
    /// What is left to trade.
    pub net: u64,
}

/// Fees on a `gross` input, rounded down, as on EVM: `gross × bps / 10 000` for each.
pub fn compute_fees(gross: u64, partner_bps: u16, platform_bps: u16) -> Result<Fees> {
    let of = |bps: u16| -> u64 { (u128::from(gross) * u128::from(bps) / BPS) as u64 };
    let (partner, platform) = (of(partner_bps), of(platform_bps));
    let net = gross
        .checked_sub(partner + platform)
        .ok_or(SwapRequestError::FeeTooHigh)?;
    Ok(Fees { partner, platform, net })
}

#[derive(Debug, PartialEq, Eq)]
pub struct Payout {
    pub partner: u64,
    pub platform: u64,
    pub user: u64,
}

/// Who a settled request's fees go to. The whole rule, in one place: kept only for a fill.
pub fn fee_payout(status: Status, escrow: &FeeEscrow) -> Result<Payout> {
    match status {
        Status::Filled => Ok(Payout { partner: escrow.partner_fee, platform: escrow.platform_fee, user: 0 }),
        Status::Refunded | Status::Cancelled | Status::Stranded => {
            Ok(Payout { partner: 0, platform: 0, user: escrow.partner_fee + escrow.platform_fee })
        }
        Status::Pending | Status::None => err!(SwapRequestError::RequestNotSettled),
    }
}

// ---------------------------------------------------------------------------- OFT CPI

/// Arguments for LayerZero's OFT `send`, matching its `SendParams`.
pub struct OftSendArgs {
    pub dst_eid: u32,
    pub to: [u8; 32],
    pub amount_ld: u64,
    pub min_amount_ld: u64,
    pub options: Vec<u8>,
    pub compose_msg: Option<Vec<u8>>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

/// Anchor's discriminator for LayerZero's OFT `send` instruction.
///
/// Anchor derives this as the first eight bytes of `sha256("global:send")`. It is a constant of
/// the instruction's *name*, so it is written out here rather than hashed at runtime: the
/// program carries no hashing dependency, and the value cannot drift unless LayerZero renames
/// the instruction — which would be a breaking change to their program either way.
///
///   python3 -c "import hashlib; print(hashlib.sha256(b'global:send').hexdigest()[:16])"
///   => 66fb14bb414b0c45
const OFT_SEND_DISCRIMINATOR: [u8; 8] = [0x66, 0xfb, 0x14, 0xbb, 0x41, 0x4b, 0x0c, 0x45];

/// Invokes LayerZero's OFT `send` with the store PDA as the signing sender.
///
/// Built by hand rather than through the OFT's generated CPI client, deliberately: the OFT crate
/// pins an older Anchor than this workspace, and depending on it would couple this program's
/// build to a specific OFT release for no benefit. The instruction's shape is stable and the
/// accounts are supplied by the caller, so a manual invoke is both simpler and looser-coupled.
fn dispatch_oft_send(
    oft_program: &Pubkey,
    accounts: &[AccountInfo],
    signer: &Pubkey,
    signer_seeds: &[&[u8]],
    args: OftSendArgs,
) -> Result<()> {
    let mut data = Vec::with_capacity(160 + args.options.len());
    data.extend_from_slice(&OFT_SEND_DISCRIMINATOR);
    args.dst_eid.serialize(&mut data)?;
    args.to.serialize(&mut data)?;
    args.amount_ld.serialize(&mut data)?;
    args.min_amount_ld.serialize(&mut data)?;
    args.options.serialize(&mut data)?;
    args.compose_msg.serialize(&mut data)?;
    args.native_fee.serialize(&mut data)?;
    args.lz_token_fee.serialize(&mut data)?;

    let metas: Vec<AccountMeta> = accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            // The store PDA never signs the outer transaction — it has no key — so its flag
            // arrives false. It signs THIS call through `invoke_signed`, but only if the meta
            // says so; copying the incoming flag made the OFT reject every send.
            is_signer: a.is_signer || a.key == signer,
            is_writable: a.is_writable,
        })
        .collect();

    invoke_signed(
        &SolInstruction { program_id: *oft_program, accounts: metas, data },
        accounts,
        &[signer_seeds],
    )
    .map_err(Into::into)
}

// ---------------------------------------------------------------------------- contexts

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitStoreParams {
    pub home_eid: u32,
    pub base_oft: Pubkey,
    pub quote_oft: Pubkey,
    pub endpoint_program: Pubkey,
    pub delegate: Pubkey,
    /// The OFTs' cross-chain precision — 6 for every CrossStock asset.
    pub shared_decimals: u8,
    /// LayerZero's OFT program, pinned so `open_request` can never CPI anywhere else.
    pub oft_program: Pubkey,
}

#[derive(Accounts)]
pub struct InitStore<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = Store::SIZE,
        seeds = [Store::SEED],
        bump
    )]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = admin,
        space = LzComposeTypesAccounts::SIZE,
        seeds = [LZ_COMPOSE_TYPES_SEED, store.key().as_ref()],
        bump
    )]
    pub lz_compose_types_accounts: Account<'info, LzComposeTypesAccounts>,
    /// CHECK: read as a packed SPL Mint; only its key and decimals are used.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: read as a packed SPL Mint; only its key and decimals are used.
    pub quote_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = admin.key() == store.admin @ SwapRequestError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenRequestParams {
    pub direction: Direction,
    pub amount_in: u64,
    /// In this chain's local decimals of the output mint; converted before it crosses.
    pub min_amount_out: u64,
    /// LayerZero executor options for the outbound leg.
    pub options: Vec<u8>,
    pub native_fee: u64,
    pub lz_token_fee: u64,
}

#[derive(Accounts)]
pub struct OpenRequest<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = user,
        space = Request::SIZE,
        seeds = [Request::SEED, &store.next_request_id.to_be_bytes()],
        bump
    )]
    pub request: Account<'info, Request>,
    /// CHECK: the [`NonceIndex`] PDA for the message this request sends. Its address depends on
    /// the nonce, known only after the send, so it is verified and created in the handler.
    #[account(mut)]
    pub nonce_index: UncheckedAccount<'info>,
    /// CHECK: checked against the store's mint for this direction, then by the SPL Token
    /// program during the checked transfer.
    pub token_in_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the store's mint for this direction; read for its decimals.
    pub token_out_mint: UncheckedAccount<'info>,
    /// CHECK: validated by the SPL Token program during the checked transfer.
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,
    /// CHECK: validated by the SPL Token program during the checked transfer.
    #[account(mut)]
    pub escrow_token_account: UncheckedAccount<'info>,
    /// CHECK: forwarded to, and validated by, the OFT program itself.
    pub oft_program: UncheckedAccount<'info>,
    /// CHECK: the SPL Token program; it validates every account passed to it.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: OpenRequestParams, fee_bps: u16)]
pub struct OpenPartnerRequest<'info> {
    /// Every account `open_request` takes, in the same order.
    pub base: OpenRequest<'info>,
    /// The partner's authoriser, co-signing this exact order.
    pub partner_signer: Signer<'info>,
    #[account(seeds = [Partner::SEED, &partner.partner_id.to_be_bytes()], bump = partner.bump)]
    pub partner: Account<'info, Partner>,
    #[account(
        init,
        payer = base.user,
        space = FeeEscrow::SIZE,
        seeds = [FeeEscrow::SEED, &base.store.next_request_id.to_be_bytes()],
        bump
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: the fee vault's token account for the input mint; checked in the handler and by
    /// the SPL Token program. Created beforehand, idempotently, by the client.
    #[account(mut)]
    pub fee_vault_token_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleFees<'info> {
    #[account(seeds = [Request::SEED, &fee_escrow.request_id.to_be_bytes()], bump = request.bump)]
    pub request: Account<'info, Request>,
    #[account(mut, seeds = [FeeEscrow::SEED, &fee_escrow.request_id.to_be_bytes()], bump = fee_escrow.bump)]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: the fee vault PDA; checked in the handler. Signs the payouts.
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: the escrowed fees' mint; checked against the escrow record.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault's token account for `mint`; checked in the handler.
    #[account(mut)]
    pub fee_vault_token_account: UncheckedAccount<'info>,
    /// CHECK: the partner recipient's token account; checked when anything is paid to it.
    #[account(mut)]
    pub partner_token_account: UncheckedAccount<'info>,
    /// CHECK: the platform recipient's token account; checked when anything is paid to it.
    #[account(mut)]
    pub platform_token_account: UncheckedAccount<'info>,
    /// CHECK: the user's token account; checked when anything is paid to it.
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,
    /// CHECK: the mint's token program — SPL Token or Token-2022 — checked in the handler.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(partner_id: u32)]
pub struct RegisterPartner<'info> {
    #[account(mut, constraint = admin.key() == store.admin @ SwapRequestError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(
        init,
        payer = admin,
        space = Partner::SIZE,
        seeds = [Partner::SEED, &partner_id.to_be_bytes()],
        bump
    )]
    pub partner: Account<'info, Partner>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePartner<'info> {
    #[account(constraint = admin.key() == store.admin @ SwapRequestError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(mut, seeds = [Partner::SEED, &partner.partner_id.to_be_bytes()], bump = partner.bump)]
    pub partner: Account<'info, Partner>,
}

#[derive(Accounts)]
pub struct LzReceiveTypes<'info> {
    #[account(seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// CHECK: address only. LayerZero's Executor passes this PDA by convention; nothing is
    /// stored in it, because planning derives everything from the message.
    #[account(seeds = [LZ_RECEIVE_TYPES_SEED, store.key().as_ref()], bump)]
    pub lz_receive_types_accounts: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct LzReceive<'info> {
    #[account(mut, seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// Bound to the notice in the handler: by request id (STRANDED) or via the nonce index
    /// (CANCELLED).
    #[account(mut)]
    pub request: Account<'info, Request>,
}

#[derive(Accounts)]
pub struct LzComposeTypes<'info> {
    #[account(seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(seeds = [LZ_COMPOSE_TYPES_SEED, store.key().as_ref()], bump)]
    pub lz_compose_types_accounts: Account<'info, LzComposeTypesAccounts>,
}

#[derive(Accounts)]
#[instruction(params: LzComposeParams)]
pub struct LzCompose<'info> {
    #[account(mut, seeds = [Store::SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    /// Bound to the settlement's request id in the handler.
    #[account(mut)]
    pub request: Account<'info, Request>,
    /// CHECK: must be the mint the delivering OFT moves; checked in the handler.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: must be the store's associated token account for `mint`; checked in the handler.
    #[account(mut)]
    pub store_token_account: UncheckedAccount<'info>,
    /// CHECK: must be the request user's associated token account for `mint`; checked in the
    /// handler. Created beforehand by the planned `CreateIdempotent` instruction.
    #[account(mut)]
    pub user_token_account: UncheckedAccount<'info>,
    /// CHECK: the mint's token program — SPL Token or Token-2022 — checked in the handler.
    pub token_program: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------- events

#[event]
pub struct SwapRequested {
    pub request_id: u64,
    pub user: Pubkey,
    pub direction: u8,
    pub amount_in: u64,
    pub min_amount_out: u64,
}

#[event]
pub struct SwapFilled {
    pub request_id: u64,
    pub user: Pubkey,
    pub amount_out: u64,
}

/// The outbound message was killed on the home chain; the input was minted back here.
#[event]
pub struct SwapCancelled {
    pub request_id: u64,
    pub user: Pubkey,
    pub lz_nonce: u64,
    pub amount: u64,
}

/// The result exists on the home chain but cannot be bridged back; claim it there.
#[event]
pub struct SwapStranded {
    pub request_id: u64,
    pub user: Pubkey,
    /// In shared decimals, as the notice carries it; the exact figure is on the home chain.
    pub amount_sd: u64,
}

/// A settlement arrived for a request that was already closed; its tokens went to the user.
#[event]
pub struct LateSettlementPaid {
    pub request_id: u64,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SwapRefunded {
    pub request_id: u64,
    pub user: Pubkey,
    pub amount: u64,
    pub reason: u8,
}

#[event]
pub struct PartnerSet {
    pub partner_id: u32,
    pub signer: Pubkey,
    pub fee_recipient: Pubkey,
    pub max_fee_bps: u16,
    pub active: bool,
}

#[event]
pub struct FeesEscrowed {
    pub request_id: u64,
    pub partner_id: u32,
    pub partner_fee: u64,
    pub platform_fee: u64,
}

#[event]
pub struct FeesSettled {
    pub request_id: u64,
    pub partner: u64,
    pub platform: u64,
    pub user: u64,
}
