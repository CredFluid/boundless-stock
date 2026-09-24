use crate::*;

#[event]
pub struct OFTSent {
    pub guid: [u8; 32],
    pub dst_eid: u32,
    pub from: Pubkey,
    pub amount_sent_ld: u64,
    pub amount_received_ld: u64,
}

#[event]
pub struct OFTReceived {
    pub guid: [u8; 32],
    pub src_eid: u32,
    pub to: Pubkey,
    pub amount_received_ld: u64,
}

/// CrossStock addition: a cancelled input restored by the designated recovery minter.
#[event]
pub struct RecoveryCredited {
    pub oft_store: Pubkey,
    pub to: Pubkey,
    pub amount_ld: u64,
}
