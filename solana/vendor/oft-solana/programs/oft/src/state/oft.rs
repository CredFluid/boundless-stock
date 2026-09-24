use crate::*;

#[account]
#[derive(InitSpace)]
pub struct OFTStore {
    // immutable
    pub oft_type: OFTType,
    pub ld2sd_rate: u64,
    pub token_mint: Pubkey,
    pub token_escrow: Pubkey, // this account is used to hold TVL and fees
    pub endpoint_program: Pubkey,
    pub bump: u8,
    // mutable
    pub tvl_ld: u64, // total value locked. if oft_type is Native, it is always 0.
    // configurable
    pub admin: Pubkey,
    pub default_fee_bps: u16,
    pub paused: bool,
    pub pauser: Option<Pubkey>,
    pub unpauser: Option<Pubkey>,
    // CrossStock: flow counters, in local decimals, as `OmniToken.bridgedOut`/`bridgedIn` on
    // EVM. Across every chain, Σ bridged_out − Σ bridged_in is exactly what is in flight, so
    // the omnichain supply invariant is checkable from chain state alone.
    /// Everything that has left this chain on the wire, cumulative.
    pub bridged_out: u128,
    /// Everything that has arrived from the wire — and every recovery credit, which restores
    /// something that left and never arrived — cumulative.
    pub bridged_in: u128,
}

#[derive(InitSpace, Clone, AnchorSerialize, AnchorDeserialize, PartialEq, Eq)]
pub enum OFTType {
    Native,
    Adapter,
}

impl OFTStore {
    pub fn ld2sd(&self, amount_ld: u64) -> u64 {
        amount_ld / self.ld2sd_rate
    }

    pub fn sd2ld(&self, amount_sd: u64) -> u64 {
        amount_sd * self.ld2sd_rate
    }

    pub fn remove_dust(&self, amount_ld: u64) -> u64 {
        amount_ld - amount_ld % self.ld2sd_rate
    }
}

/// LzReceiveTypesAccounts includes accounts that are used in the LzReceiveTypes
/// instruction.
#[account]
#[derive(InitSpace)]
pub struct LzReceiveTypesAccounts {
    pub oft_store: Pubkey,
    pub token_mint: Pubkey,
}
