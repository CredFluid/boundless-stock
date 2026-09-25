//! On-chain state. The Solana counterpart to `SwapRequest.sol`'s storage.

use anchor_lang::prelude::*;

/// Lifecycle of a request. Mirrors `SwapTypes.Status` so both VMs agree on the numbers.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    None = 0,
    Pending = 1,
    Filled = 2,
    Refunded = 3,
    /// The value exists on the home chain but is below the bridge's precision floor, so it can
    /// never cross. Terminal, and paired with a claim on the home chain — see
    /// `SwapRelay.claimStranded`. Numbered to match `SwapTypes.Status` exactly; the two VMs
    /// read each other's settlements, so a divergence here is a silent misinterpretation.
    Stranded = 4,
    /// The outbound message was never delivered and has been permanently killed on the
    /// destination, so the input is restored here rather than bridged back.
    Cancelled = 5,
}

/// Direction, from the mirror-chain user's point of view. Mirrors `SwapTypes.Direction`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    /// Pay the quote asset, receive the stock.
    Buy = 0,
    /// Pay the stock, receive the quote asset.
    Sell = 1,
}

/// Program-wide configuration and the OApp identity.
///
/// This PDA *is* the OApp as far as LayerZero is concerned: it is what gets registered with the
/// endpoint, what signs outbound sends, and what the home-chain relay authenticates against.
#[account]
pub struct Store {
    pub admin: Pubkey,
    /// LayerZero eid of the home chain, where the market lives.
    pub home_eid: u32,
    /// The home-chain SwapRelay, as LayerZero addresses it. Zero until wired.
    pub home_relay: [u8; 32],
    /// The stock mint on this chain.
    pub base_mint: Pubkey,
    /// The quote-asset mint on this chain.
    pub quote_mint: Pubkey,
    /// The OFT programs that move each asset. Deliveries are authenticated against these.
    pub base_oft: Pubkey,
    pub quote_oft: Pubkey,
    /// LayerZero EndpointV2 program.
    pub endpoint_program: Pubkey,
    /// Monotonic, so a request id is never reused.
    pub next_request_id: u64,
    pub bump: u8,
    /// The OFTs' cross-chain precision. Wire amounts are in these units, so a floor typed in
    /// this chain's local decimals is converted before it leaves. See `SwapTypes.sol`.
    pub shared_decimals: u8,
    /// LayerZero's OFT program. `open_request` CPIs into it signed as this store, so it must
    /// be pinned: a caller-supplied program would receive the store's signature, and with it
    /// the power to send as this OApp and to mint through the OFT's recovery path.
    pub oft_program: Pubkey,
    /// When set, `open_request` is closed and orders need a partner's co-signature.
    ///
    /// These three fields were appended within the size headroom: a store created before them
    /// reads them as zero — partners not required, no platform fee — which is how it behaved.
    pub partner_required: bool,
    /// The platform's fee on partner orders, in basis points of the input.
    pub platform_fee_bps: u16,
    /// Wallet whose token account receives the platform fee.
    pub platform_fee_recipient: Pubkey,
    /// Whether each mint is a Token-2022 mint. Recorded at initialisation because delivery
    /// planning must name token accounts before it can read the mints; a store created before
    /// these fields reads them as false — classic SPL Token, which is what it used.
    pub base_token_2022: bool,
    pub quote_token_2022: bool,
}

impl Store {
    /// The token program of one of this store's mints.
    pub fn token_program_for(&self, mint: &Pubkey) -> Pubkey {
        let t22 = if *mint == self.base_mint { self.base_token_2022 } else { self.quote_token_2022 };
        if t22 { crate::spl::TOKEN_2022_PROGRAM_ID } else { crate::spl::TOKEN_PROGRAM_ID }
    }
}

impl Store {
    pub const SEED: &'static [u8] = b"Store";
    /// discriminator + 4 pubkeys + 3 × [u8;32]/pubkey + eid + id + bump + shared decimals,
    /// plus headroom. The partner fields (35 bytes) and the Token-2022 flags (2) came out of that
    /// headroom, so the size — and every store already created at it — is unchanged.
    pub const SIZE: usize = 8 + 32 + 4 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 1 + 1 + 32 + 64;
}

/// One user's trade. The Solana counterpart to `SwapRequest.Request`.
///
/// Stored as its own PDA keyed by request id rather than in a map on the store, because Solana
/// accounts are sized up front: a growing map would need reallocation on every trade, and a
/// per-request PDA also lets the executor name the exact account a settlement will touch, which
/// `lz_compose_types_v2` is required to do.
#[account]
pub struct Request {
    pub user: Pubkey,
    pub direction: Direction,
    /// Mint the user paid with, on this chain.
    pub token_in: Pubkey,
    /// Mint they expect back, on this chain.
    pub token_out: Pubkey,
    /// Input actually bridged, after the OFT's precision floor is applied.
    pub amount_in: u64,
    pub min_amount_out: u64,
    /// Filled in on settlement.
    pub amount_out: u64,
    pub created_at: i64,
    pub settled_at: i64,
    pub status: Status,
    /// `SwapTypes.FailureReason`, zero unless refunded.
    pub failure_reason: u8,
    pub bump: u8,
    /// LayerZero nonce of the outbound message, on the path of the input asset's OFT. The
    /// only handle by which a message that never arrives can later be named and cancelled.
    pub lz_nonce: u64,
}

impl Request {
    pub const SEED: &'static [u8] = b"Request";
    pub const SIZE: usize = 8 + 32 + 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 32;

    pub fn seeds(request_id: u64) -> [Vec<u8>; 2] {
        [Self::SEED.to_vec(), request_id.to_be_bytes().to_vec()]
    }
}

/// Accounts the executor needs in order to call `lz_compose_types_v2`.
///
/// LayerZero reads this PDA to learn which accounts to pass when asking the program to plan a
/// delivery. It exists because Solana requires every touched account to be known before the
/// transaction is built — the single largest structural difference from the EVM design, where a
/// contract simply reaches into whatever storage it likes.
#[account]
pub struct LzComposeTypesAccounts {
    pub store: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
}

impl LzComposeTypesAccounts {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32;
}

/// Finds a request from the LayerZero message it sent: `[b"Nonce", oft_store, nonce]`.
///
/// A CANCELLED notice names a killed message by path and nonce — the home chain never saw the
/// payload, so it cannot name the request. Delivering that notice also has to name the user's
/// token account BEFORE it runs, from the message alone, so the index carries the user and the
/// input mint as well as the request id; planning reads this account, not the request.
#[account]
pub struct NonceIndex {
    pub request_id: u64,
    pub user: Pubkey,
    pub token_in: Pubkey,
}

impl NonceIndex {
    pub const SEED: &'static [u8] = b"Nonce";
    pub const SIZE: usize = 8 + 8 + 32 + 32;
}

/// A partner — a wallet, exchange or app that owns its users and their KYC — allowed to route
/// orders here. `[b"Partner", partner_id (big-endian)]`.
#[account]
pub struct Partner {
    pub partner_id: u32,
    /// Co-signs every order the partner approves.
    pub signer: Pubkey,
    /// Wallet whose token account receives this partner's fees.
    pub fee_recipient: Pubkey,
    /// The most this partner may charge on one order, in basis points.
    pub max_fee_bps: u16,
    pub active: bool,
    pub bump: u8,
}

impl Partner {
    pub const SEED: &'static [u8] = b"Partner";
    pub const SIZE: usize = 8 + 4 + 32 + 32 + 2 + 1 + 1 + 32;
}

/// Where a request's fees stand. Numbered as `SwapRequest.FeeState` on EVM.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum FeeState {
    None = 0,
    /// Held in the fee vault until the request settles.
    Escrowed = 1,
    /// The request filled; paid to the partner and the platform.
    Paid = 2,
    /// The request did not fill; returned to the user.
    Returned = 3,
}

/// A partner order's fees, held until the request settles. `[b"Fee", request_id (big-endian)]`.
///
/// Separate from [`Request`] so a request's layout — which clients read at fixed offsets — is
/// the same whether or not it came through a partner.
#[account]
pub struct FeeEscrow {
    pub request_id: u64,
    pub partner_id: u32,
    pub user: Pubkey,
    /// The input mint, which the fees are in.
    pub mint: Pubkey,
    /// Snapshotted at submission: the terms the user agreed to.
    pub partner_recipient: Pubkey,
    pub platform_recipient: Pubkey,
    pub partner_fee: u64,
    pub platform_fee: u64,
    pub state: FeeState,
    pub bump: u8,
}

impl FeeEscrow {
    pub const SEED: &'static [u8] = b"Fee";
    pub const SIZE: usize = 8 + 8 + 4 + 32 * 4 + 8 + 8 + 1 + 1 + 32;
}
