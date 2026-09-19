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
use oapp::endpoint_cpi::{self, LzAccount};
use oapp::{LzComposeParams, LZ_COMPOSE_TYPES_SEED};
use endpoint_interface::instructions::RegisterOAppParams;
use endpoint_interface::instructions::oapp::clear_compose::ClearComposeParams;

pub mod abi;
pub mod error;
pub mod spl;
pub mod state;

use abi::{Order, Settlement};
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

        // Anything below the bridge's precision floor crosses as zero, which would leave a
        // request that can never settle. Same guard as the EVM side, and found there by the
        // invariant fuzzer.
        let quantised = params.amount_in - (params.amount_in % params.bridge_quantum.max(1));
        require!(quantised > 0, SwapRequestError::AmountBelowBridgeableMinimum);

        let store = &mut ctx.accounts.store;
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
        let decimals = spl::mint_decimals(&ctx.accounts.token_in_mint)?;
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
            min_amount_out: params.min_amount_out as u128,
            recipient: ctx.accounts.user.key().to_bytes(),
        };

        let store_bump = store.bump;
        dispatch_oft_send(
            &ctx.accounts.oft_program.key(),
            ctx.remaining_accounts,
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

    /// Tells the Executor which accounts a settlement delivery will touch.
    ///
    /// Called **before** delivery. The request account is derived from the id in the payload, so
    /// the plan is computable without reading chain state — which is the whole reason a request
    /// is its own PDA rather than an entry in a map.
    pub fn lz_compose_types_v2(
        ctx: Context<LzComposeTypes>,
        params: LzComposeParams,
    ) -> Result<Vec<LzAccount>> {
        let store = &ctx.accounts.store;
        let settlement = Settlement::decode(&params.message)?;

        let (request, _) = Pubkey::find_program_address(
            &[Request::SEED, &settlement.request_id.to_be_bytes()],
            ctx.program_id,
        );

        let mut accounts = vec![
            LzAccount { pubkey: store.key(), is_signer: false, is_writable: true },
            LzAccount { pubkey: request, is_signer: false, is_writable: true },
        ];

        // Consuming the queued message is a CPI into the endpoint, so its accounts belong in
        // the plan too.
        accounts.extend(endpoint_cpi::get_accounts_for_clear_compose(
            store.endpoint_program,
            &params.from,
            &ctx.accounts.store.key(),
            &params.guid,
            params.index,
            &params.message,
        ));

        Ok(accounts)
    }

    /// Receives a settlement from the home chain and closes out the request.
    ///
    /// One handler covers both outcomes, as on EVM: a fill delivers the output asset, a refund
    /// returns the input. Either way tokens arrived and a request reaches a terminal state.
    ///
    /// Authenticity comes from `clear_compose`. It is a CPI into the endpoint that succeeds only
    /// if this exact message really was queued for this composer by that sender, and it consumes
    /// the queue entry so the same settlement can never be applied twice.
    pub fn lz_compose(ctx: Context<LzCompose>, params: LzComposeParams) -> Result<()> {
        let store = &ctx.accounts.store;

        // The delivering program must be one of this store's OFTs. On EVM the equivalent check
        // is `_from == baseOft || _from == quoteOft`.
        require!(
            params.from == store.base_oft || params.from == store.quote_oft,
            SwapRequestError::UnexpectedComposeSource
        );

        let settlement = Settlement::decode(&params.message)?;
        let request = &mut ctx.accounts.request;

        require!(
            request.status == Status::Pending,
            SwapRequestError::RequestNotPending
        );

        // Consume the queued compose. This both authenticates the message and makes replay
        // impossible: a second attempt finds nothing to clear.
        let store_bump = store.bump;
        endpoint_cpi::clear_compose(
            store.endpoint_program,
            ctx.accounts.store.key(),
            ctx.remaining_accounts,
            &[Store::SEED, &[store_bump]],
            ClearComposeParams {
                from: params.from,
                guid: params.guid,
                index: params.index,
                message: params.message.clone(),
            },
        )?;

        request.settled_at = Clock::get()?.unix_timestamp;

        match settlement.status {
            s if s == Status::Filled as u8 => {
                request.status = Status::Filled;
                request.amount_out = settlement.amount_out as u64;
                emit!(SwapFilled {
                    request_id: settlement.request_id,
                    user: request.user,
                    amount_out: request.amount_out,
                });
            }
            s if s == Status::Refunded as u8 => {
                request.status = Status::Refunded;
                request.failure_reason = settlement.reason;
                emit!(SwapRefunded {
                    request_id: settlement.request_id,
                    user: request.user,
                    amount: settlement.amount_in as u64,
                    reason: settlement.reason,
                });
            }
            _ => return Err(SwapRequestError::UnknownSettlementStatus.into()),
        }

        Ok(())
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
            is_signer: a.is_signer,
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
    pub min_amount_out: u64,
    /// Smallest amount the OFT can move, i.e. one shared-decimal unit.
    pub bridge_quantum: u64,
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
    /// CHECK: validated by the SPL Token program during the checked transfer.
    pub token_in_mint: UncheckedAccount<'info>,
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
    #[account(mut)]
    pub request: Account<'info, Request>,
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

#[event]
pub struct SwapRefunded {
    pub request_id: u64,
    pub user: Pubkey,
    pub amount: u64,
    pub reason: u8,
}
