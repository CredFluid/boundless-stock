//! # CrossStock `swap_relay` — the home-chain relay on Solana
//!
//! The Solana counterpart of `src/relay/SwapRelay.sol`. A mirror chain's SwapRequest sends the
//! user's input here as an OFT transfer with the order attached as its compose message; this
//! program executes it against the home pool — an Orca Whirlpool — and sends the result back
//! the same way, with a Settlement attached.
//!
//! ## What is genuinely different from the EVM relay
//!
//! **Refund is decided before swapping.** Solana cannot catch a failed CPI, so "try the swap,
//! refund in the catch" is impossible: a reverting swap takes the whole delivery with it. The
//! handler quotes with Orca's own swap maths over the same accounts ([`pool::quote`]) and only
//! swaps when the quote clears the user's floor, with that floor as the swap's threshold.
//!
//! **The return leg's accounts are fixed in advance.** Every account an instruction touches
//! must be named before it runs, and the return is a full OFT `send` — OFT, endpoint and message
//! library, some twenty accounts. For a given (asset, destination) they never change, so each is
//! recorded once as a [`ReturnRoute`] and checked on every delivery. Planning names both routes
//! (input and output asset) because it cannot know which the handler will need.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction as SolInstruction};
use anchor_lang::solana_program::program::invoke_signed;
use endpoint_interface::instructions::oapp::clear_compose::ClearComposeParams;
use endpoint_interface::instructions::RegisterOAppParams;
use oapp::common::{AccountMetaRef, AddressLocator, EXECUTION_CONTEXT_VERSION_1};
use oapp::endpoint_cpi;
use oapp::lz_compose_types_v2::{
    self, Instruction as PlannedIx, LzComposeTypesV2Accounts, LzComposeTypesV2Result, LZ_COMPOSE_TYPES_VERSION,
};
use oapp::{LzComposeParams, LZ_COMPOSE_TYPES_SEED};
use swap_request::abi::{ComposeFrame, Order, Settlement};
use swap_request::spl;
use whirlpool::state::Whirlpool;

pub mod error;
pub mod pool;
pub mod state;

use error::SwapRelayError;
use state::{Peer, RelayStore, ReturnRoute, RouteAccount};

declare_id!("ADjsJxDJ4zCr54P2ioDin4uWRi8AQaofvSzh9ZyMWC5b");

/// Mirrors `SwapTypes.Status`.
pub const STATUS_FILLED: u8 = 2;
pub const STATUS_REFUNDED: u8 = 3;
/// Mirrors `SwapTypes.FailureReason`.
pub const REASON_NONE: u8 = 0;
pub const REASON_SLIPPAGE: u8 = 1;
pub const REASON_POOL_ERROR: u8 = 2;
pub const REASON_UNAUTHORIZED_SOURCE: u8 = 3;
/// Mirrors `SwapTypes.Direction`.
pub const DIRECTION_BUY: u8 = 0;

/// Accounts `endpoint::clear_compose` takes; they lead `lz_compose`'s remaining accounts.
pub const CLEAR_COMPOSE_ACCOUNTS: usize = 5;

/// sha256("global:send")[..8] — LayerZero's OFT `send`.
const OFT_SEND_DISCRIMINATOR: [u8; 8] = [0x66, 0xfb, 0x14, 0xbb, 0x41, 0x4b, 0x0c, 0x45];

#[program]
pub mod swap_relay {
    use super::*;

    // ------------------------------------------------------------------ setup

    /// Creates the relay and registers it with the endpoint as an OApp.
    pub fn init_relay(ctx: Context<InitRelay>, params: InitRelayParams) -> Result<()> {
        // The pool must trade exactly this pair, or no order could ever execute against it.
        let pool = &ctx.accounts.whirlpool;
        let (base, quote) = (ctx.accounts.base_mint.key(), ctx.accounts.quote_mint.key());
        require!(
            (pool.token_mint_a == base && pool.token_mint_b == quote)
                || (pool.token_mint_a == quote && pool.token_mint_b == base),
            SwapRelayError::PoolMismatch
        );
        for mint in [&ctx.accounts.base_mint, &ctx.accounts.quote_mint] {
            require!(spl::mint_decimals(mint)? >= params.shared_decimals, SwapRelayError::UnsupportedDecimals);
        }

        let store = &mut ctx.accounts.store;
        store.admin = ctx.accounts.admin.key();
        store.eid = params.eid;
        store.endpoint_program = params.endpoint_program;
        store.oft_program = params.oft_program;
        store.whirlpool_program = ctx.accounts.whirlpool.to_account_info().owner.key();
        store.whirlpool = ctx.accounts.whirlpool.key();
        store.base_mint = base;
        store.quote_mint = quote;
        store.base_oft = params.base_oft;
        store.quote_oft = params.quote_oft;
        store.shared_decimals = params.shared_decimals;
        store.alt = Pubkey::default();
        store.bump = ctx.bumps.store;

        endpoint_cpi::register_oapp(
            params.endpoint_program,
            store.key(),
            ctx.remaining_accounts,
            &[RelayStore::SEED, &[store.bump]],
            RegisterOAppParams { delegate: params.delegate },
        )
    }

    /// Records the SwapRequest on a mirror chain, and the executor options for returns to it.
    pub fn set_peer(ctx: Context<SetPeer>, eid: u32, address: [u8; 32], return_options: Vec<u8>) -> Result<()> {
        require!(return_options.len() <= Peer::MAX_OPTIONS, SwapRelayError::OptionsTooLong);
        let peer = &mut ctx.accounts.peer;
        peer.address = address;
        peer.return_options = return_options;
        peer.bump = ctx.bumps.peer;
        let _ = eid;
        Ok(())
    }

    /// Records the full account list of the OFT `send` that returns `mint` to `eid`.
    pub fn set_return_route(
        ctx: Context<SetReturnRoute>,
        mint: Pubkey,
        eid: u32,
        accounts: Vec<RouteAccount>,
    ) -> Result<()> {
        require!(accounts.len() <= ReturnRoute::MAX_ACCOUNTS, SwapRelayError::RouteTooLong);
        let store = &ctx.accounts.store;
        require!(mint == store.base_mint || mint == store.quote_mint, SwapRelayError::WrongMint);
        // Index 0 is the OFT's signer and token authority: always this relay.
        require!(
            accounts.first().map(|a| a.pubkey) == Some(store.key()),
            SwapRelayError::RouteMismatch
        );
        let route = &mut ctx.accounts.route;
        route.mint = mint;
        route.eid = eid;
        route.accounts = accounts;
        route.bump = ctx.bumps.route;
        Ok(())
    }

    /// Points planning at the address lookup table holding the relay's static accounts.
    pub fn set_alt(ctx: Context<AdminOnly>, alt: Pubkey) -> Result<()> {
        ctx.accounts.store.alt = alt;
        Ok(())
    }

    // ------------------------------------------------------------------ planning

    /// Version discovery for the Executor, and the accounts planning needs: the pool (for the
    /// tick arrays in reach), the sending chain's peer, and both return routes to it.
    pub fn lz_compose_types_info(
        ctx: Context<LzComposeTypes>,
        params: LzComposeParams,
    ) -> Result<(u8, LzComposeTypesV2Accounts)> {
        let store = &ctx.accounts.store;
        let src_eid = ComposeFrame::parse(&params.message)?.src_eid;
        let mut accounts = vec![
            store.key(),
            ctx.accounts.lz_compose_types_accounts.key(),
            store.whirlpool,
            peer_address(ctx.program_id, src_eid),
            route_address(ctx.program_id, &store.base_mint, src_eid),
            route_address(ctx.program_id, &store.quote_mint, src_eid),
        ];
        // Planning reads the lookup table to refer to accounts by index: a plan naming every
        // account in full would exceed Solana's 1 KB limit on return data.
        if store.alt != Pubkey::default() {
            accounts.push(store.alt);
        }
        Ok((LZ_COMPOSE_TYPES_VERSION, LzComposeTypesV2Accounts { accounts }))
    }

    /// Plans an order delivery: the swap's accounts for the direction the delivering OFT
    /// implies, `clear_compose`'s, and both return routes. The relay's lookup table carries the
    /// static ones so the whole thing fits in one transaction.
    pub fn lz_compose_types_v2<'info>(
        ctx: Context<'_, '_, 'info, 'info, LzComposeTypes<'info>>,
        params: LzComposeParams,
    ) -> Result<LzComposeTypesV2Result> {
        let store = &ctx.accounts.store;
        let (pool_info, peer_info, route_base_info, route_quote_info, alt_info) = match ctx.remaining_accounts {
            [a, b, c, d] => (a, b, c, d, None),
            [a, b, c, d, e] => (a, b, c, d, Some(e)),
            _ => return err!(SwapRelayError::RouteMismatch),
        };
        let table = match alt_info {
            Some(info) => {
                require_keys_eq!(info.key(), store.alt, SwapRelayError::RouteMismatch);
                lookup_table_addresses(info)?
            }
            None => vec![],
        };
        require_keys_eq!(pool_info.key(), store.whirlpool, SwapRelayError::PoolMismatch);
        let pool = Account::<Whirlpool>::try_from(pool_info)?;
        let route_base = Account::<ReturnRoute>::try_from(route_base_info)?;
        let route_quote = Account::<ReturnRoute>::try_from(route_quote_info)?;

        let (token_in, _) = direction(store, &params.from)?;
        let a_to_b = token_in == pool.token_mint_a;
        let ticks = pool::tick_arrays_for(
            &store.whirlpool_program,
            &store.whirlpool,
            pool.tick_current_index,
            pool.tick_spacing,
            a_to_b,
        );
        let meta = |k: Pubkey, w: bool| account_ref(&table, k, w);

        // Order matches the `LzCompose` accounts struct.
        let mut accounts = vec![
            meta(store.key(), true),
            meta(peer_info.key(), false),
            meta(store.whirlpool, true),
            meta(pool.token_vault_a, true),
            meta(pool.token_vault_b, true),
            meta(ticks[0], true),
            meta(ticks[1], true),
            meta(ticks[2], true),
            meta(pool::oracle_address(&store.whirlpool_program, &store.whirlpool), false),
            meta(spl::associated_token_address(&store.key(), &pool.token_mint_a), true),
            meta(spl::associated_token_address(&store.key(), &pool.token_mint_b), true),
            meta(route_base_info.key(), false),
            meta(route_quote_info.key(), false),
            meta(store.whirlpool_program, false),
            meta(store.oft_program, false),
            meta(spl::TOKEN_PROGRAM_ID, false),
            meta(store.base_mint, false),
            meta(store.quote_mint, false),
        ];
        let named = accounts.len();
        accounts.extend(lz_compose_types_v2::get_accounts_for_clear_compose(
            store.endpoint_program,
            &params.from,
            &store.key(),
            &params.guid,
            params.index,
            &params.message,
        ));
        // `clear_compose`'s accounts, as the endpoint derives them, then indexed where possible.
        let clear = accounts.split_off(named);
        accounts.extend(clear.into_iter().map(|r| match r.pubkey {
            AddressLocator::Address(k) => account_ref(&table, k, r.is_writable),
            _ => r,
        }));
        for route in [&route_base, &route_quote] {
            accounts.extend(route.accounts.iter().map(|a| {
                if a.is_payer {
                    AccountMetaRef { pubkey: AddressLocator::Payer, is_writable: a.is_writable }
                } else {
                    account_ref(&table, a.pubkey, a.is_writable)
                }
            }));
        }

        Ok(LzComposeTypesV2Result {
            context_version: EXECUTION_CONTEXT_VERSION_1,
            alts: if store.alt == Pubkey::default() { vec![] } else { vec![store.alt] },
            instructions: vec![PlannedIx::LzCompose { accounts }],
        })
    }

    // ------------------------------------------------------------------ the order

    /// Executes a cross-chain order and returns the result to the mirror chain it came from.
    ///
    /// Arrives after the OFT has credited this relay with the input. The input's fate is
    /// decided here, before anything irreversible: filled if the pool clears the user's floor
    /// now, otherwise returned in full. Either way tokens go back with a Settlement, exactly as
    /// on EVM — a fill and a refund are the same event to the mirror chain.
    pub fn lz_compose<'info>(
        ctx: Context<'_, '_, 'info, 'info, LzCompose<'info>>,
        params: LzComposeParams,
    ) -> Result<()> {
        let store = &ctx.accounts.store;
        let (token_in, token_out) = direction(store, &params.from)?;
        let is_buy = token_in == store.quote_mint;
        let frame = ComposeFrame::parse(&params.message)?;
        let order = Order::decode(&frame.compose_msg)?;

        // Every submitter-chosen account is proven before anything moves.
        verify_accounts(&ctx, &frame, token_in)?;

        let store_bump = store.bump;
        let seeds: &[&[u8]] = &[RelayStore::SEED, &[store_bump]];

        // Consume the compose: authenticates it, and makes replay impossible.
        let remaining = ctx.remaining_accounts;
        require!(remaining.len() >= CLEAR_COMPOSE_ACCOUNTS, SwapRelayError::RouteMismatch);
        endpoint_cpi::clear_compose(
            store.endpoint_program,
            store.key(),
            &remaining[..CLEAR_COMPOSE_ACCOUNTS],
            seeds,
            ClearComposeParams {
                from: params.from,
                guid: params.guid,
                index: params.index,
                message: params.message.clone(),
            },
        )?;

        let amount_in = frame.amount_ld;
        let peer = &ctx.accounts.peer;
        let authorized = peer.address != [0u8; 32] && frame.compose_from == peer.address;
        let direction_ok = (order.direction == DIRECTION_BUY) == is_buy;

        // ---- decide: fill or refund, before touching the pool
        let (in_decimals, out_decimals) = (
            spl::mint_decimals(mint_account(&ctx, &token_in))?,
            spl::mint_decimals(mint_account(&ctx, &token_out))?,
        );
        let (q_in, q_out) = (quantum(in_decimals, store.shared_decimals)?, quantum(out_decimals, store.shared_decimals)?);
        let pool = &ctx.accounts.whirlpool;
        let a_to_b = token_in == pool.token_mint_a;

        let decision = if !authorized {
            Decision::Refund(REASON_UNAUTHORIZED_SOURCE)
        } else if !direction_ok {
            Decision::Refund(REASON_POOL_ERROR)
        } else {
            // The floor arrives in shared decimals. Saturate rather than overflow, and never
            // accept less than one bridgeable unit — a result that cannot cross is no result.
            let min_out = (order.min_amount_out.min(u64::MAX as u128) as u64).saturating_mul(q_out).max(q_out);
            let quoted = pool::quote(
                pool,
                [&ctx.accounts.tick_array_0, &ctx.accounts.tick_array_1, &ctx.accounts.tick_array_2],
                &ctx.accounts.oracle,
                amount_in,
                a_to_b,
            )?;
            match quoted {
                Some(out) if out >= min_out => Decision::Fill(min_out),
                _ => Decision::Refund(REASON_SLIPPAGE),
            }
        };

        // ---- execute
        let (return_mint, return_amount, settlement) = match decision {
            Decision::Fill(min_out) => {
                let out_account = if a_to_b { &ctx.accounts.relay_token_b } else { &ctx.accounts.relay_token_a };
                let before = token_amount(out_account)?;
                whirlpool::cpi::swap(
                    CpiContext::new_with_signer(
                        ctx.accounts.whirlpool_program.to_account_info(),
                        whirlpool::cpi::accounts::Swap {
                            token_program: ctx.accounts.token_program.to_account_info(),
                            token_authority: ctx.accounts.store.to_account_info(),
                            whirlpool: ctx.accounts.whirlpool.to_account_info(),
                            token_owner_account_a: ctx.accounts.relay_token_a.to_account_info(),
                            token_vault_a: ctx.accounts.token_vault_a.to_account_info(),
                            token_owner_account_b: ctx.accounts.relay_token_b.to_account_info(),
                            token_vault_b: ctx.accounts.token_vault_b.to_account_info(),
                            tick_array_0: ctx.accounts.tick_array_0.to_account_info(),
                            tick_array_1: ctx.accounts.tick_array_1.to_account_info(),
                            tick_array_2: ctx.accounts.tick_array_2.to_account_info(),
                            oracle: ctx.accounts.oracle.to_account_info(),
                        },
                        &[seeds],
                    ),
                    amount_in,
                    min_out, // the user's floor, enforced by the pool itself as well
                    0,       // no explicit price limit
                    true,
                    a_to_b,
                )?;
                let out = token_amount(out_account)?.checked_sub(before).ok_or(SwapRelayError::PoolMismatch)?;
                let delivered = out - out % q_out; // what the OFT will actually move
                emit!(OrderFilled { src_eid: frame.src_eid, request_id: order.request_id, amount_in, amount_out: out });
                (token_out, out, settlement_for(&order, STATUS_FILLED, REASON_NONE, amount_in / q_in, delivered / q_out))
            }
            Decision::Refund(reason) => {
                emit!(OrderFailed { src_eid: frame.src_eid, request_id: order.request_id, reason, amount_in });
                (token_in, amount_in, settlement_for(&order, STATUS_REFUNDED, reason, amount_in / q_in, 0))
            }
        };

        // ---- return it, through the pinned route
        let route = if return_mint == store.base_mint { &ctx.accounts.route_base } else { &ctx.accounts.route_quote };
        let offset = CLEAR_COMPOSE_ACCOUNTS
            + if return_mint == store.base_mint { 0 } else { ctx.accounts.route_base.accounts.len() };
        let route_accounts = remaining
            .get(offset..offset + route.accounts.len())
            .ok_or(SwapRelayError::RouteMismatch)?;
        verify_route(route, route_accounts)?;

        oft_send(
            &store.oft_program,
            route_accounts,
            &store.key(),
            seeds,
            frame.src_eid,
            peer.address,
            return_amount,
            peer.return_options.clone(),
            settlement.encode(),
        )?;
        Ok(())
    }
}

enum Decision {
    /// Swap, with this floor in the output's local decimals.
    Fill(u64),
    /// Return the input untraded, for this `SwapTypes.FailureReason`.
    Refund(u8),
}

/// An account as a plan names it: by its index in the relay's lookup table where it has one
/// (a few bytes), in full otherwise (thirty-odd).
fn account_ref(table: &[Pubkey], key: Pubkey, is_writable: bool) -> AccountMetaRef {
    match table.iter().position(|k| *k == key) {
        Some(i) if i <= u8::MAX as usize => AccountMetaRef { pubkey: AddressLocator::AltIndex(0, i as u8), is_writable },
        _ => AccountMetaRef { pubkey: key.into(), is_writable },
    }
}

/// The addresses in an address lookup table: after its 56-byte header, 32 bytes each.
fn lookup_table_addresses(info: &AccountInfo) -> Result<Vec<Pubkey>> {
    const META: usize = 56;
    let data = info.try_borrow_data()?;
    require!(data.len() >= META, SwapRelayError::RouteMismatch);
    Ok(data[META..].chunks_exact(32).map(|c| Pubkey::new_from_array(c.try_into().unwrap())).collect())
}

/// (input mint, output mint), from the OFT that delivered. Derived, never declared: a sender
/// cannot choose which OFT credited the relay.
pub fn direction(store: &RelayStore, from: &Pubkey) -> Result<(Pubkey, Pubkey)> {
    if *from == store.quote_oft {
        Ok((store.quote_mint, store.base_mint))
    } else if *from == store.base_oft {
        Ok((store.base_mint, store.quote_mint))
    } else {
        err!(SwapRelayError::UnexpectedComposeSource)
    }
}

pub fn peer_address(program_id: &Pubkey, eid: u32) -> Pubkey {
    Pubkey::find_program_address(&[Peer::SEED, &eid.to_be_bytes()], program_id).0
}

pub fn route_address(program_id: &Pubkey, mint: &Pubkey, eid: u32) -> Pubkey {
    Pubkey::find_program_address(&[ReturnRoute::SEED, mint.as_ref(), &eid.to_be_bytes()], program_id).0
}

/// One shared-decimal unit in local decimals: the smallest amount the OFT can move.
fn quantum(local: u8, shared: u8) -> Result<u64> {
    10u64
        .checked_pow(u32::from(local.checked_sub(shared).ok_or(SwapRelayError::UnsupportedDecimals)?))
        .ok_or(SwapRelayError::UnsupportedDecimals.into())
}

fn settlement_for(order: &Order, status: u8, reason: u8, amount_in_sd: u64, amount_out_sd: u64) -> Settlement {
    Settlement {
        request_id: order.request_id,
        status,
        reason,
        amount_in: amount_in_sd.into(),
        amount_out: amount_out_sd.into(),
        lz_nonce: 0,
        recipient: order.recipient,
        cancelled_path: [0u8; 32],
    }
}

/// SPL token account `amount`: bytes 64..72.
fn token_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, SwapRelayError::PoolMismatch);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

fn mint_account<'a, 'info>(ctx: &'a Context<'_, '_, 'info, 'info, LzCompose<'info>>, mint: &Pubkey) -> &'a AccountInfo<'info> {
    if *mint == ctx.accounts.base_mint.key() {
        &ctx.accounts.base_mint
    } else {
        &ctx.accounts.quote_mint
    }
}

/// Every account of the delivery that the submitter chose, checked against what it must be.
fn verify_accounts(ctx: &Context<'_, '_, '_, '_, LzCompose>, frame: &ComposeFrame, token_in: Pubkey) -> Result<()> {
    let a = &ctx.accounts;
    let store = &a.store;
    let id = ctx.program_id;
    require_keys_eq!(a.peer.key(), peer_address(id, frame.src_eid), SwapRelayError::RouteMismatch);
    require_keys_eq!(a.whirlpool.key(), store.whirlpool, SwapRelayError::PoolMismatch);
    require_keys_eq!(a.token_vault_a.key(), a.whirlpool.token_vault_a, SwapRelayError::PoolMismatch);
    require_keys_eq!(a.token_vault_b.key(), a.whirlpool.token_vault_b, SwapRelayError::PoolMismatch);
    require_keys_eq!(
        a.relay_token_a.key(),
        spl::associated_token_address(&store.key(), &a.whirlpool.token_mint_a),
        SwapRelayError::PoolMismatch
    );
    require_keys_eq!(
        a.relay_token_b.key(),
        spl::associated_token_address(&store.key(), &a.whirlpool.token_mint_b),
        SwapRelayError::PoolMismatch
    );
    // The tick arrays decide both the quote and the swap. A submitter who could pass others
    // could make a fillable order look unfillable and force a refund.
    let a_to_b = token_in == a.whirlpool.token_mint_a;
    let expected = pool::tick_arrays_for(
        &store.whirlpool_program,
        &store.whirlpool,
        a.whirlpool.tick_current_index,
        a.whirlpool.tick_spacing,
        a_to_b,
    );
    for (got, want) in [&a.tick_array_0, &a.tick_array_1, &a.tick_array_2].iter().zip(expected.iter()) {
        require_keys_eq!(got.key(), *want, SwapRelayError::PoolMismatch);
    }
    require_keys_eq!(
        a.oracle.key(),
        pool::oracle_address(&store.whirlpool_program, &store.whirlpool),
        SwapRelayError::PoolMismatch
    );
    require_keys_eq!(a.route_base.key(), route_address(id, &store.base_mint, frame.src_eid), SwapRelayError::RouteMismatch);
    require_keys_eq!(a.route_quote.key(), route_address(id, &store.quote_mint, frame.src_eid), SwapRelayError::RouteMismatch);
    Ok(())
}

/// The supplied accounts are exactly the recorded route, apart from the fee payer, which must
/// at least be a signer.
pub fn verify_route(route: &ReturnRoute, supplied: &[AccountInfo]) -> Result<()> {
    require!(supplied.len() == route.accounts.len(), SwapRelayError::RouteMismatch);
    for (want, got) in route.accounts.iter().zip(supplied) {
        if want.is_payer {
            require!(got.is_signer, SwapRelayError::RouteMismatch);
        } else {
            require_keys_eq!(got.key(), want.pubkey, SwapRelayError::RouteMismatch);
        }
    }
    Ok(())
}

/// LayerZero's OFT `send`, signed as this relay.
#[allow(clippy::too_many_arguments)]
fn oft_send<'info>(
    oft_program: &Pubkey,
    accounts: &[AccountInfo<'info>],
    signer: &Pubkey,
    seeds: &[&[u8]],
    dst_eid: u32,
    to: [u8; 32],
    amount_ld: u64,
    options: Vec<u8>,
    compose_msg: Vec<u8>,
) -> Result<()> {
    let mut data = OFT_SEND_DISCRIMINATOR.to_vec();
    dst_eid.serialize(&mut data)?;
    to.serialize(&mut data)?;
    amount_ld.serialize(&mut data)?;
    0u64.serialize(&mut data)?; // min_amount_ld: a return must never fail on dust
    options.serialize(&mut data)?;
    Some(compose_msg).serialize(&mut data)?;
    0u64.serialize(&mut data)?; // native_fee: the local message library charges none
    0u64.serialize(&mut data)?; // lz_token_fee

    let metas = accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            // The relay PDA signs this call through invoke_signed; its incoming flag is false.
            is_signer: a.is_signer || a.key == signer,
            is_writable: a.is_writable,
        })
        .collect();
    invoke_signed(&SolInstruction { program_id: *oft_program, accounts: metas, data }, accounts, &[seeds])
        .map_err(Into::into)
}

// ---------------------------------------------------------------------------- contexts

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitRelayParams {
    pub eid: u32,
    pub endpoint_program: Pubkey,
    pub oft_program: Pubkey,
    pub base_oft: Pubkey,
    pub quote_oft: Pubkey,
    pub shared_decimals: u8,
    pub delegate: Pubkey,
}

#[derive(Accounts)]
pub struct InitRelay<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = RelayStore::SIZE, seeds = [RelayStore::SEED], bump)]
    pub store: Account<'info, RelayStore>,
    pub whirlpool: Box<Account<'info, Whirlpool>>,
    /// CHECK: read as a packed SPL Mint; checked against the pool.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: read as a packed SPL Mint; checked against the pool.
    pub quote_mint: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(constraint = admin.key() == store.admin @ SwapRelayError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [RelayStore::SEED], bump = store.bump)]
    pub store: Account<'info, RelayStore>,
}

#[derive(Accounts)]
#[instruction(eid: u32)]
pub struct SetPeer<'info> {
    #[account(mut, constraint = admin.key() == store.admin @ SwapRelayError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [RelayStore::SEED], bump = store.bump)]
    pub store: Account<'info, RelayStore>,
    #[account(init_if_needed, payer = admin, space = Peer::SIZE, seeds = [Peer::SEED, &eid.to_be_bytes()], bump)]
    pub peer: Account<'info, Peer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(mint: Pubkey, eid: u32)]
pub struct SetReturnRoute<'info> {
    #[account(mut, constraint = admin.key() == store.admin @ SwapRelayError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(seeds = [RelayStore::SEED], bump = store.bump)]
    pub store: Account<'info, RelayStore>,
    #[account(
        init_if_needed,
        payer = admin,
        space = ReturnRoute::SIZE,
        seeds = [ReturnRoute::SEED, mint.as_ref(), &eid.to_be_bytes()],
        bump
    )]
    pub route: Account<'info, ReturnRoute>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LzComposeTypes<'info> {
    #[account(seeds = [RelayStore::SEED], bump = store.bump)]
    pub store: Account<'info, RelayStore>,
    /// CHECK: address only; LayerZero's Executor passes it by convention.
    #[account(seeds = [LZ_COMPOSE_TYPES_SEED, store.key().as_ref()], bump)]
    pub lz_compose_types_accounts: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct LzCompose<'info> {
    #[account(mut, seeds = [RelayStore::SEED], bump = store.bump)]
    pub store: Box<Account<'info, RelayStore>>,
    /// Bound to the compose's source eid in the handler.
    pub peer: Box<Account<'info, Peer>>,
    #[account(mut)]
    pub whirlpool: Box<Account<'info, Whirlpool>>,
    /// CHECK: must be the pool's vault A; checked in the handler and by Orca.
    #[account(mut)]
    pub token_vault_a: UncheckedAccount<'info>,
    /// CHECK: must be the pool's vault B; checked in the handler and by Orca.
    #[account(mut)]
    pub token_vault_b: UncheckedAccount<'info>,
    /// CHECK: must be the tick arrays in reach of the current price; checked in the handler.
    #[account(mut)]
    pub tick_array_0: UncheckedAccount<'info>,
    /// CHECK: as above.
    #[account(mut)]
    pub tick_array_1: UncheckedAccount<'info>,
    /// CHECK: as above.
    #[account(mut)]
    pub tick_array_2: UncheckedAccount<'info>,
    /// CHECK: the pool's oracle PDA; checked in the handler.
    pub oracle: UncheckedAccount<'info>,
    /// CHECK: the relay's token account for the pool's mint A; checked in the handler.
    #[account(mut)]
    pub relay_token_a: UncheckedAccount<'info>,
    /// CHECK: the relay's token account for the pool's mint B; checked in the handler.
    #[account(mut)]
    pub relay_token_b: UncheckedAccount<'info>,
    pub route_base: Box<Account<'info, ReturnRoute>>,
    pub route_quote: Box<Account<'info, ReturnRoute>>,
    /// CHECK: pinned to the Whirlpool program recorded at init.
    #[account(address = store.whirlpool_program)]
    pub whirlpool_program: UncheckedAccount<'info>,
    /// CHECK: pinned to the OFT program recorded at init.
    #[account(address = store.oft_program)]
    pub oft_program: UncheckedAccount<'info>,
    /// CHECK: pinned to the SPL Token program.
    #[account(address = spl::TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: the base mint, read for decimals.
    #[account(address = store.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the quote mint, read for decimals.
    #[account(address = store.quote_mint)]
    pub quote_mint: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------- events

#[event]
pub struct OrderFilled {
    pub src_eid: u32,
    pub request_id: u64,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct OrderFailed {
    pub src_eid: u32,
    pub request_id: u64,
    pub reason: u8,
    pub amount_in: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use whirlpool::state::TICK_ARRAY_SIZE;

    const SPACING: u16 = 64;
    const SPAN: i32 = TICK_ARRAY_SIZE * SPACING as i32; // 5,632 ticks per array

    /// Selling token A walks the price down: the current array, then the two below.
    #[test]
    fn a_to_b_walks_down_from_the_current_array() {
        assert_eq!(pool::start_tick_indexes(100, SPACING, true), vec![0, -SPAN, -2 * SPAN]);
        assert_eq!(pool::start_tick_indexes(-100, SPACING, true), vec![-SPAN, -2 * SPAN, -3 * SPAN]);
    }

    /// Buying token A walks it up — and within one spacing of the next array, Orca starts there.
    #[test]
    fn b_to_a_walks_up_and_shifts_at_the_boundary() {
        assert_eq!(pool::start_tick_indexes(100, SPACING, false), vec![0, SPAN, 2 * SPAN]);
        assert_eq!(pool::start_tick_indexes(SPAN - 1, SPACING, false), vec![SPAN, 2 * SPAN, 3 * SPAN]);
    }

    /// Near the price limit fewer than three arrays exist; the last is repeated, as Orca allows.
    #[test]
    fn short_sequences_are_padded() {
        let pool_key = Pubkey::new_unique();
        let program = Pubkey::new_unique();
        let near_max = 443_636 - 10;
        let arrays = pool::tick_arrays_for(&program, &pool_key, near_max, SPACING, false);
        assert_eq!(arrays[1], arrays[2], "past the limit the last valid array stands in");
    }

    fn route(n: usize, payer_at: Option<usize>) -> ReturnRoute {
        ReturnRoute {
            mint: Pubkey::new_unique(),
            eid: 40231,
            accounts: (0..n)
                .map(|i| RouteAccount { pubkey: Pubkey::new_unique(), is_writable: i % 2 == 0, is_payer: Some(i) == payer_at })
                .collect(),
            bump: 255,
        }
    }

    fn infos<'a>(keys: &'a [Pubkey], signer: &'a [bool], lamports: &'a mut [u64], data: &'a mut [Vec<u8>], owner: &'a Pubkey) -> Vec<AccountInfo<'a>> {
        let mut out = vec![];
        for (((k, s), l), d) in keys.iter().zip(signer).zip(lamports.iter_mut()).zip(data.iter_mut()) {
            out.push(AccountInfo::new(k, *s, true, l, d, owner, false, 0));
        }
        out
    }

    #[test]
    fn a_route_is_accepted_exactly_and_the_payer_only_as_a_signer() {
        let r = route(4, Some(2));
        let payer = Pubkey::new_unique();
        let mut keys: Vec<Pubkey> = r.accounts.iter().map(|a| a.pubkey).collect();
        keys[2] = payer; // the executor's own key stands in for the payer
        let owner = Pubkey::default();
        let (mut l, mut d) = (vec![0u64; 4], vec![vec![]; 4]);
        let signed = [false, false, true, false];
        assert!(verify_route(&r, &infos(&keys, &signed, &mut l, &mut d, &owner)).is_ok());

        let unsigned = [false, false, false, false];
        assert!(verify_route(&r, &infos(&keys, &unsigned, &mut l, &mut d, &owner)).is_err(), "payer must sign");
    }

    /// The theft case: any substituted account — say, a destination — is refused.
    #[test]
    fn a_substituted_route_account_is_refused() {
        let r = route(4, None);
        let mut keys: Vec<Pubkey> = r.accounts.iter().map(|a| a.pubkey).collect();
        keys[3] = Pubkey::new_unique();
        let owner = Pubkey::default();
        let (mut l, mut d) = (vec![0u64; 4], vec![vec![]; 4]);
        assert!(verify_route(&r, &infos(&keys, &[false; 4], &mut l, &mut d, &owner)).is_err());
    }

    #[test]
    fn a_short_route_is_refused() {
        let r = route(4, None);
        let keys: Vec<Pubkey> = r.accounts.iter().take(3).map(|a| a.pubkey).collect();
        let owner = Pubkey::default();
        let (mut l, mut d) = (vec![0u64; 3], vec![vec![]; 3]);
        assert!(verify_route(&r, &infos(&keys, &[false; 3], &mut l, &mut d, &owner)).is_err());
    }

    #[test]
    fn accounts_in_the_table_are_named_by_index() {
        let table: Vec<Pubkey> = (0..5).map(|_| Pubkey::new_unique()).collect();
        match account_ref(&table, table[3], true).pubkey {
            AddressLocator::AltIndex(0, 3) => {}
            _ => panic!("an account in the table must be referenced by index"),
        }
        match account_ref(&table, Pubkey::new_unique(), false).pubkey {
            AddressLocator::Address(_) => {}
            _ => panic!("an account outside the table must be named in full"),
        }
    }

    #[test]
    fn the_bridge_quantum_follows_local_decimals() {
        assert_eq!(quantum(9, 6).unwrap(), 1_000);
        assert_eq!(quantum(6, 6).unwrap(), 1);
        assert!(quantum(5, 6).is_err());
    }
}
