//! Orca Whirlpool: which tick arrays a swap touches, the quote, and the swap itself.
//!
//! The quote runs Orca's own swap maths (`swap_manager::swap`) — the function the Whirlpool
//! program's `swap` instruction runs — over the same accounts, read only. So "would this fill at
//! or above the user's floor?" is answered by the code that will execute the fill.
//!
//! That question has to be answered before swapping because Solana cannot catch a failed CPI:
//! a swap that reverts takes the whole delivery with it. On EVM, `SwapRelay` tries the swap and
//! refunds in the `catch`; here the refund decision has to come first.

use anchor_lang::prelude::*;
use whirlpool::manager::swap_manager::swap;
use whirlpool::math::{floor_division, NO_EXPLICIT_SQRT_PRICE_LIMIT};
use whirlpool::state::{OracleAccessor, Tick, Whirlpool, TICK_ARRAY_SIZE};
use whirlpool::util::{to_timestamp_u64, SparseSwapTickSequenceBuilder};

/// Start ticks of the (up to) three arrays a swap from the current price can cross.
///
/// A port of Orca's private `get_start_tick_indexes` in `util/sparse_swap.rs`: the swap
/// instruction derives the same three and rejects anything else, so planning and the handler
/// must agree with it exactly.
pub fn start_tick_indexes(tick_current_index: i32, tick_spacing: u16, a_to_b: bool) -> Vec<i32> {
    let spacing = tick_spacing as i32;
    let ticks_in_array = TICK_ARRAY_SIZE * spacing;
    let base = floor_division(tick_current_index, ticks_in_array) * ticks_in_array;
    let offsets: [i32; 3] = if a_to_b {
        [0, -1, -2]
    } else if tick_current_index + spacing >= base + ticks_in_array {
        [1, 2, 3]
    } else {
        [0, 1, 2]
    };
    offsets
        .iter()
        .map(|o| base + o * ticks_in_array)
        .filter(|s| Tick::check_is_valid_start_tick(*s, tick_spacing))
        .collect()
}

/// The tick-array PDA for a start tick. Orca seeds it with the index as a decimal string.
pub fn tick_array_address(whirlpool_program: &Pubkey, whirlpool: &Pubkey, start_tick_index: i32) -> Pubkey {
    Pubkey::find_program_address(
        &[b"tick_array", whirlpool.as_ref(), start_tick_index.to_string().as_bytes()],
        whirlpool_program,
    )
    .0
}

/// The three tick arrays to pass, in order. Short sequences near the price limits are padded
/// with the last one — Orca accepts a repeated account.
pub fn tick_arrays_for(
    whirlpool_program: &Pubkey,
    whirlpool: &Pubkey,
    tick_current_index: i32,
    tick_spacing: u16,
    a_to_b: bool,
) -> [Pubkey; 3] {
    let starts = start_tick_indexes(tick_current_index, tick_spacing, a_to_b);
    let at = |i: usize| tick_array_address(whirlpool_program, whirlpool, starts[i.min(starts.len() - 1)]);
    [at(0), at(1), at(2)]
}

pub fn oracle_address(whirlpool_program: &Pubkey, whirlpool: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"oracle", whirlpool.as_ref()], whirlpool_program).0
}

/// Output of an exact-input swap of `amount`, as Orca would execute it now. `None` when the
/// pool cannot execute it at all — trading disabled, or not enough initialised ticks in reach —
/// which is as much a reason to refund as a price below the floor.
pub fn quote<'info>(
    pool: &Account<'info, Whirlpool>,
    tick_arrays: [&AccountInfo<'info>; 3],
    oracle: &AccountInfo<'info>,
    amount: u64,
    a_to_b: bool,
) -> Result<Option<u64>> {
    let builder = SparseSwapTickSequenceBuilder::new(
        tick_arrays.iter().map(|a| (*a).clone()).collect(),
        None,
    );
    let Ok(mut sequence) = builder.try_build(pool, a_to_b) else { return Ok(None) };

    let timestamp = to_timestamp_u64(Clock::get()?.unix_timestamp)?;
    let oracle = OracleAccessor::new(pool, oracle.clone())?;
    if !oracle.is_trade_enabled(timestamp)? {
        return Ok(None);
    }
    let adaptive_fee = oracle.get_adaptive_fee_info()?;

    match swap(pool, &mut sequence, amount, NO_EXPLICIT_SQRT_PRICE_LIMIT, true, a_to_b, timestamp, &adaptive_fee) {
        Ok(update) => Ok(Some(if a_to_b { update.amount_b } else { update.amount_a })),
        Err(_) => Ok(None),
    }
}
