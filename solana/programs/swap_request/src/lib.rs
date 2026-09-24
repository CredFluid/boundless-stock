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
use oapp::{LzComposeParams, LZ_COMPOSE_TYPES_SEED};
use endpoint_interface::instructions::RegisterOAppParams;
use endpoint_interface::instructions::oapp::clear_compose::ClearComposeParams;

pub mod abi;
pub mod error;
pub mod spl;
pub mod state;

#[cfg(test)]
mod verify_tests;

use abi::{ComposeFrame, Order, Settlement};
use error::SwapRequestError;
use state::{Direction, LzComposeTypesAccounts, Request, Status, Store};

declare_id!("6cMiunhoxEcYYT29Cp4PgDT97FjtqsuqZ27ChTbr41vL");

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
        }

        let store = &mut ctx.accounts.store;
        store.admin = ctx.accounts.admin.key();
        store.home_eid = params.home_eid;
        store.home_relay = [0u8; 32];
        store.base_mint = ctx.accounts.base_mint.key();
        store.quote_mint = ctx.accounts.quote_mint.key();
        store.base_oft = params.base_oft;
        store.quote_oft = params.quote_oft;
        store.endpoint_program = params.endpoint_program;
        store.next_request_id = 1;
        store.bump = ctx.bumps.store;
        store.shared_decimals = params.shared_decimals;

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
    pub fn open_request(ctx: Context<OpenRequest>, params: OpenRequestParams) -> Result<()> {
        require!(params.amount_in > 0, SwapRequestError::ZeroAmount);
        require!(ctx.accounts.store.home_relay != [0u8; 32], SwapRequestError::PeerNotSet);

        let store = &mut ctx.accounts.store;
        let (expected_in, expected_out) = match params.direction {
            Direction::Buy => (store.quote_mint, store.base_mint),
            Direction::Sell => (store.base_mint, store.quote_mint),
        };
        require_keys_eq!(ctx.accounts.token_in_mint.key(), expected_in, SwapRequestError::WrongMint);
        require_keys_eq!(ctx.accounts.token_out_mint.key(), expected_out, SwapRequestError::WrongMint);

        // Anything below the bridge's precision floor crosses as zero, which would leave a
        // request that can never settle. Same guard as the EVM side, and found there by the
        // invariant fuzzer. The quantum is derived from the mint, not taken from the caller.
        let decimals = spl::mint_decimals(&ctx.accounts.token_in_mint)?;
        let quantum = 10u64
            .checked_pow(u32::from(decimals.saturating_sub(store.shared_decimals)))
            .ok_or(SwapRequestError::UnsupportedDecimals)?;
        let quantised = params.amount_in - (params.amount_in % quantum);
        require!(quantised > 0, SwapRequestError::AmountBelowBridgeableMinimum);

        // The floor crosses in shared decimals, rounded up so conversion never loosens it.
        let out_decimals = spl::mint_decimals(&ctx.accounts.token_out_mint)?;
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
            &ctx.accounts.token_program,
            &ctx.accounts.user_token_account,
            &ctx.accounts.token_in_mint,
            &ctx.accounts.escrow_token_account,
            &ctx.accounts.user.to_account_info(),
            quantised,
            decimals,
        )?;

        let request = &mut ctx.accounts.request;
        request.user = ctx.accounts.user.key();
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
        request.bump = ctx.bumps.request;

        // The order rides as the OFT's composeMsg, so funds and instruction arrive together.
        let order = Order {
            request_id,
            direction: params.direction as u8,
            min_amount_out: u128::from(min_out_sd),
            recipient: ctx.accounts.user.key().to_bytes(),
        };

        let store_bump = store.bump;
        let store_key = store.key();
        dispatch_oft_send(
            &ctx.accounts.oft_program.key(),
            ctx.remaining_accounts,
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

        emit!(SwapRequested {
            request_id,
            user: ctx.accounts.user.key(),
            direction: params.direction as u8,
            amount_in: quantised,
            min_amount_out: params.min_amount_out,
        });
        Ok(())
    }

    // ------------------------------------------------------------------ LayerZero composer

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
        let user_ata = spl::associated_token_address(&user, &mint);
        let store_ata = spl::associated_token_address(&store.key(), &mint);

        let create_user_ata = PlannedIx::Standard {
            program_id: spl::ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: vec![
                AccountMetaRef { pubkey: AddressLocator::Payer, is_writable: true },
                AccountMetaRef { pubkey: user_ata.into(), is_writable: true },
                AccountMetaRef { pubkey: user.into(), is_writable: false },
                AccountMetaRef { pubkey: mint.into(), is_writable: false },
                AccountMetaRef { pubkey: System::id().into(), is_writable: false },
                AccountMetaRef { pubkey: spl::TOKEN_PROGRAM_ID.into(), is_writable: false },
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
            AccountMetaRef { pubkey: spl::TOKEN_PROGRAM_ID.into(), is_writable: false },
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

/// The accounts a delivery names for moving tokens, as the submitter supplied them.
pub struct DeliveryAccounts {
    pub mint: Pubkey,
    pub store_token_account: Pubkey,
    pub user_token_account: Pubkey,
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
    require_keys_eq!(
        accounts.store_token_account,
        spl::associated_token_address(store_key, &mint),
        SwapRequestError::WrongTokenAccount
    );
    require_keys_eq!(
        accounts.user_token_account,
        spl::associated_token_address(request_user, &mint),
        SwapRequestError::WrongTokenAccount
    );

    Ok(VerifiedSettlement { mint, frame, settlement })
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
    /// CHECK: pinned to the SPL Token program.
    #[account(address = spl::TOKEN_PROGRAM_ID)]
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
