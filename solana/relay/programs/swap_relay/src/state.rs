use anchor_lang::prelude::*;

/// The relay's configuration and its OApp identity.
///
/// Like `swap_request::Store`, this PDA *is* the OApp as far as LayerZero is concerned: it is
/// what the mirrors' SwapRequests peer with, what receives composes from the OFTs, and what
/// signs the return legs.
#[account]
pub struct RelayStore {
    pub admin: Pubkey,
    /// This chain's LayerZero eid.
    pub eid: u32,
    pub endpoint_program: Pubkey,
    /// LayerZero's OFT program. Pinned: every CPI that carries this store's signature goes
    /// only here or to the pinned Whirlpool program.
    pub oft_program: Pubkey,
    pub whirlpool_program: Pubkey,
    /// The one pool orders execute against.
    pub whirlpool: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// OFT store PDAs — the addresses the endpoint reports as a compose's `from`.
    pub base_oft: Pubkey,
    pub quote_oft: Pubkey,
    pub shared_decimals: u8,
    /// Address lookup table holding this relay's static accounts, or default if none. Planning
    /// returns it so a delivery — swap, clear, and a full OFT send — fits in one transaction.
    pub alt: Pubkey,
    pub bump: u8,
}

impl RelayStore {
    pub const SEED: &'static [u8] = b"Relay";
    pub const SIZE: usize = 8 + 32 + 4 + 32 * 9 + 1 + 32 + 1 + 64;
}

/// The SwapRequest on one mirror chain, and how to reach it.
#[account]
pub struct Peer {
    /// The mirror's SwapRequest, as LayerZero addresses it.
    pub address: [u8; 32],
    /// The most one return leg to that chain may cost in messaging fees, in lamports. Paid by
    /// the executor's fee payer, which the mirror's compose value reimburses; the cap bounds
    /// what a mis-set library fee can take from it.
    pub max_return_fee: u64,
    /// Executor options for the return leg to that chain — EVM gas for an EVM mirror.
    pub return_options: Vec<u8>,
    pub bump: u8,
}

impl Peer {
    pub const SEED: &'static [u8] = b"Peer";
    pub const MAX_OPTIONS: usize = 128;
    pub const SIZE: usize = 8 + 32 + 8 + 4 + Self::MAX_OPTIONS + 1;
}

/// One account of an OFT `send`, as recorded in a [`ReturnRoute`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RouteAccount {
    pub pubkey: Pubkey,
    pub is_writable: bool,
    /// The fee payer the message library names. Supplied by whoever executes the delivery
    /// (LayerZero's `Payer` locator), so it is not pinned; every other account is.
    pub is_payer: bool,
}

/// Every account of the OFT `send` that returns one asset to one mirror chain.
///
/// That list is static for a given (asset, destination): the OFT store, its peer and escrow,
/// the endpoint's path accounts, and the message library's. Recorded once at setup — derived
/// off chain with LayerZero's own SDK — and then checked on every delivery, so the submitter of
/// a compose can neither omit nor substitute any of them. Index 0 is the OFT's `signer`, which
/// is this relay's store.
#[account]
pub struct ReturnRoute {
    pub mint: Pubkey,
    pub eid: u32,
    pub accounts: Vec<RouteAccount>,
    pub bump: u8,
}

impl ReturnRoute {
    pub const SEED: &'static [u8] = b"Route";
    pub const MAX_ACCOUNTS: usize = 40;
    pub const SIZE: usize = 8 + 32 + 4 + 4 + Self::MAX_ACCOUNTS * (32 + 1 + 1) + 1;
}

/// The notice route to a mirror: the accounts of the endpoint `send` that carries a plain
/// message — a STRANDED or CANCELLED notice, no tokens — from this relay to that mirror's
/// SwapRequest. Stored as a [`ReturnRoute`] under the default mint, so it is checked exactly
/// like a return route. Index 0 is the endpoint program, index 1 this relay (the sender).
pub const NOTICE_MINT: Pubkey = Pubkey::new_from_array([0u8; 32]);

/// A result that could not be returned, held here until someone retries it.
///
/// Solana cannot catch a failed return the way `SwapRelay.sol` does, so a compose whose return
/// cannot be sent simply reverts and stays queued — safe, but the mirror hears nothing. When the
/// operator judges it will not clear soon, `strand_compose` consumes it, records it here, and
/// tells the mirror; `retry_return` sends it back later, to the same peer, by anyone.
#[account]
pub struct Stranded {
    pub eid: u32,
    pub request_id: u64,
    /// The asset held: the order's input, untraded.
    pub mint: Pubkey,
    /// In the mint's local decimals; a multiple of the bridge quantum, since it arrived by OFT.
    pub amount: u64,
    /// The same amount in shared decimals, as the settlement will carry it.
    pub amount_sd: u64,
    /// The user on the mirror chain, from the order.
    pub recipient: [u8; 32],
    /// Who paid this account's rent, and receives it back when it is closed.
    pub rent_payer: Pubkey,
    pub bump: u8,
}

impl Stranded {
    pub const SEED: &'static [u8] = b"Stranded";
    pub const SIZE: usize = 8 + 4 + 8 + 32 + 8 + 8 + 32 + 32 + 1;
}
