//! Minimal ABI codec, so Solana and EVM speak the same wire format.
//!
//! The CrossStock payloads (`Order`, `Settlement`) are defined in `src/relay/SwapTypes.sol` as
//! `abi.encode(...)` of fixed-size values. Solidity's `abi.encode` lays every one of those out
//! as a 32-byte big-endian word, so decoding on Solana is just reading words at fixed offsets.
//!
//! Implemented by hand rather than pulled from a crate: the payloads use six value types
//! between them, the layout is fully specified, and a dependency here would be a much larger
//! surface than the ~60 lines it replaces.
//!
//! **The encoding is the contract between two VMs.** If `SwapTypes.sol` changes, this changes
//! with it, and the round-trip tests in `tests/` are what catch a drift.

use anchor_lang::prelude::*;

use crate::error::SwapRequestError;

/// One `abi.encode` word.
pub const WORD: usize = 32;

/// Reads the `index`-th 32-byte word.
fn word(data: &[u8], index: usize) -> Result<&[u8]> {
    let start = index * WORD;
    let end = start + WORD;
    require!(data.len() >= end, SwapRequestError::MalformedPayload);
    Ok(&data[start..end])
}

/// Decodes a word as `uint64`, rejecting anything that would not fit.
///
/// Solidity may legitimately encode a `uint256` here; a value that overflows `u64` means the
/// two sides disagree about the type, which is worth failing loudly rather than truncating.
pub fn read_u64(data: &[u8], index: usize) -> Result<u64> {
    let w = word(data, index)?;
    require!(w[..24].iter().all(|b| *b == 0), SwapRequestError::PayloadValueTooLarge);
    Ok(u64::from_be_bytes(w[24..].try_into().unwrap()))
}

/// Decodes a word as `uint8`.
pub fn read_u8(data: &[u8], index: usize) -> Result<u8> {
    let w = word(data, index)?;
    require!(w[..31].iter().all(|b| *b == 0), SwapRequestError::PayloadValueTooLarge);
    Ok(w[31])
}

/// Decodes a word as `uint256`, narrowed to `u128`.
///
/// Token amounts on Solana are `u64`, so a `u128` here is already generous; the check exists
/// because a genuine overflow means a malformed or hostile message rather than a large trade.
pub fn read_u128(data: &[u8], index: usize) -> Result<u128> {
    let w = word(data, index)?;
    require!(w[..16].iter().all(|b| *b == 0), SwapRequestError::PayloadValueTooLarge);
    Ok(u128::from_be_bytes(w[16..].try_into().unwrap()))
}

/// Decodes a word as `bytes32` — which is how LayerZero addresses every chain, and therefore
/// how a Solana `Pubkey` crosses to an EVM chain without being truncated.
pub fn read_bytes32(data: &[u8], index: usize) -> Result<[u8; 32]> {
    Ok(word(data, index)?.try_into().unwrap())
}

/// Writes a `uint64` as a 32-byte word.
pub fn write_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&[0u8; 24]);
    out.extend_from_slice(&value.to_be_bytes());
}

/// Writes a `uint8` as a 32-byte word.
pub fn write_u8(out: &mut Vec<u8>, value: u8) {
    out.extend_from_slice(&[0u8; 31]);
    out.push(value);
}

/// Writes a `uint256` from a `u128`.
pub fn write_u128(out: &mut Vec<u8>, value: u128) {
    out.extend_from_slice(&[0u8; 16]);
    out.extend_from_slice(&value.to_be_bytes());
}

/// Writes a `bytes32` verbatim.
pub fn write_bytes32(out: &mut Vec<u8>, value: &[u8; 32]) {
    out.extend_from_slice(value);
}

// ---------------------------------------------------------------------------- payloads

/// Mirror -> home. Matches `SwapTypes.Order`.
///
/// `recipient` is a `bytes32` rather than an EVM `address` precisely so a Solana `Pubkey`
/// survives the trip. Solidity's `abi.decode` into `address` rejects a word whose upper 12
/// bytes are non-zero, so a 32-byte pubkey in an `address` slot would revert the decode on the
/// home chain — which is why the Solidity side uses `bytes32` for this field too.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub request_id: u64,
    pub direction: u8,
    pub min_amount_out: u128,
    pub recipient: [u8; 32],
}

impl Order {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 * WORD);
        write_u64(&mut out, self.request_id);
        write_u8(&mut out, self.direction);
        write_u128(&mut out, self.min_amount_out);
        write_bytes32(&mut out, &self.recipient);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        Ok(Self {
            request_id: read_u64(data, 0)?,
            direction: read_u8(data, 1)?,
            min_amount_out: read_u128(data, 2)?,
            recipient: read_bytes32(data, 3)?,
        })
    }
}

/// Home -> mirror. Matches `SwapTypes.Settlement`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub request_id: u64,
    pub status: u8,
    pub reason: u8,
    pub amount_in: u128,
    pub amount_out: u128,
    /// LayerZero nonce of the outbound message this settles. Carried because a CANCELLED
    /// settlement concerns a message the home chain never received: it knows the nonce it
    /// killed but not the request id, since the payload never arrived to be decoded.
    pub lz_nonce: u64,
    /// Who the returned tokens are for — copied from the order by the home chain. Needed here
    /// because a delivery must name the user's token account before it runs, from the message
    /// alone. Checked against the request's own record rather than trusted.
    pub recipient: [u8; 32],
    /// CANCELLED only: this chain's OFT store that sent the killed message. Nonces are per
    /// path — a buy and a sell routinely share one — so `lz_nonce` alone names no request.
    pub cancelled_path: [u8; 32],
}

impl Settlement {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 * WORD);
        write_u64(&mut out, self.request_id);
        write_u8(&mut out, self.status);
        write_u8(&mut out, self.reason);
        write_u128(&mut out, self.amount_in);
        write_u128(&mut out, self.amount_out);
        write_u64(&mut out, self.lz_nonce);
        write_bytes32(&mut out, &self.recipient);
        write_bytes32(&mut out, &self.cancelled_path);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        Ok(Self {
            request_id: read_u64(data, 0)?,
            status: read_u8(data, 1)?,
            reason: read_u8(data, 2)?,
            amount_in: read_u128(data, 3)?,
            amount_out: read_u128(data, 4)?,
            lz_nonce: read_u64(data, 5)?,
            recipient: read_bytes32(data, 6)?,
            cancelled_path: read_bytes32(data, 7)?,
        })
    }
}

// ---------------------------------------------------------------------------- OFT compose frame

/// The envelope LayerZero's Solana OFT wraps around a composed message.
///
/// `lz_compose` does not receive the Settlement directly. The OFT queues
/// `nonce (8) | src_eid (4) | amount_ld (8) | compose_from (32) | compose_msg`, all big-endian —
/// see `compose_msg_codec.rs` in the vendored OFT. Two of those fields are load-bearing here:
/// `amount_ld` is what the OFT actually minted into the store, which is the figure to pay out,
/// and `compose_from` is who sent the order, which is how a settlement is authenticated.
///
/// Note `amount_ld` is 8 bytes here, where the EVM OFT's frame uses 32.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComposeFrame {
    pub nonce: u64,
    pub src_eid: u32,
    pub amount_ld: u64,
    pub compose_from: [u8; 32],
    pub compose_msg: Vec<u8>,
}

impl ComposeFrame {
    pub const HEADER: usize = 8 + 4 + 8 + 32;

    pub fn parse(message: &[u8]) -> Result<Self> {
        require!(message.len() >= Self::HEADER, SwapRequestError::MalformedPayload);
        Ok(Self {
            nonce: u64::from_be_bytes(message[0..8].try_into().unwrap()),
            src_eid: u32::from_be_bytes(message[8..12].try_into().unwrap()),
            amount_ld: u64::from_be_bytes(message[12..20].try_into().unwrap()),
            compose_from: message[20..52].try_into().unwrap(),
            compose_msg: message[52..].to_vec(),
        })
    }

    /// The inverse of [`ComposeFrame::parse`], matching the OFT's own encoder. Used by tests
    /// and by off-chain tooling that has to predict the composed-message hash.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(Self::HEADER + self.compose_msg.len());
        out.extend_from_slice(&self.nonce.to_be_bytes());
        out.extend_from_slice(&self.src_eid.to_be_bytes());
        out.extend_from_slice(&self.amount_ld.to_be_bytes());
        out.extend_from_slice(&self.compose_from);
        out.extend_from_slice(&self.compose_msg);
        out
    }
}

// ---------------------------------------------------------------------------- decimals

/// Local-decimal amount to shared decimals, rounded UP.
///
/// Used for the slippage floor, which must never loosen in conversion: rounding down would let
/// the home chain accept up to one quantum less than the user asked for. Wire amounts are in
/// shared decimals because the two ends of a trade need not agree on local decimals — this
/// mint may be 9 decimals against an 18-decimal ERC-20 on the home chain.
pub fn ld_to_sd_ceil(amount_ld: u64, local_decimals: u8, shared_decimals: u8) -> Result<u64> {
    require!(local_decimals >= shared_decimals, SwapRequestError::UnsupportedDecimals);
    let rate = 10u64
        .checked_pow(u32::from(local_decimals - shared_decimals))
        .ok_or(SwapRequestError::UnsupportedDecimals)?;
    Ok(amount_ld / rate + u64::from(amount_ld % rate != 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_round_trips() {
        let o = Order {
            request_id: 42,
            direction: 1,
            min_amount_out: 1_500_000,
            recipient: [7u8; 32],
        };
        assert_eq!(Order::decode(&o.encode()).unwrap(), o);
        assert_eq!(o.encode().len(), 4 * WORD, "must match abi.encode of four value types");
    }

    #[test]
    fn settlement_round_trips() {
        let s = Settlement {
            request_id: 9,
            status: 2,
            reason: 0,
            amount_in: 15_000_000_000,
            amount_out: 99_605_634,
            lz_nonce: 17,
            recipient: [3u8; 32],
            cancelled_path: [0u8; 32],
        };
        assert_eq!(Settlement::decode(&s.encode()).unwrap(), s);
        assert_eq!(s.encode().len(), 8 * WORD, "must match abi.encode of eight value types");
    }

    #[test]
    fn truncated_payload_is_rejected() {
        let s = Settlement {
            request_id: 1,
            status: 2,
            reason: 0,
            amount_in: 1,
            amount_out: 1,
            lz_nonce: 1,
            recipient: [0u8; 32],
            cancelled_path: [0u8; 32],
        };
        let encoded = s.encode();
        assert!(Settlement::decode(&encoded[..encoded.len() - 1]).is_err());
    }

    #[test]
    fn oversized_value_is_rejected_not_truncated() {
        // A uint256 that does not fit u64 means the two sides disagree about the type.
        let mut data = vec![0u8; 8 * WORD];
        data[0] = 1; // high byte of the first word
        assert!(Settlement::decode(&data).is_err());
    }

    /// Byte-for-byte what `SwapTypes.encodeSettlement` produces in Solidity for these values,
    /// generated with `cast abi-encode`. Pins the cross-VM layout, not just self-consistency:
    /// a round-trip test passes happily if both directions drift together.
    #[test]
    fn settlement_matches_solidity_encoding() {
        let s = Settlement {
            request_id: 7,
            status: 2,
            reason: 0,
            amount_in: 15_000_000_000,
            amount_out: 100_000_000,
            lz_nonce: 0,
            recipient: [0xAB; 32],
            cancelled_path: [0u8; 32],
        };
        let expected = hex_words(&[
            "0000000000000000000000000000000000000000000000000000000000000007",
            "0000000000000000000000000000000000000000000000000000000000000002",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "000000000000000000000000000000000000000000000000000000037e11d600",
            "0000000000000000000000000000000000000000000000000000000005f5e100",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "abababababababababababababababababababababababababababababababab",
            "0000000000000000000000000000000000000000000000000000000000000000",
        ]);
        assert_eq!(s.encode(), expected);
    }

    fn hex_words(words: &[&str]) -> Vec<u8> {
        words
            .iter()
            .flat_map(|w| (0..32).map(move |i| u8::from_str_radix(&w[i * 2..i * 2 + 2], 16).unwrap()))
            .collect()
    }

    #[test]
    fn compose_frame_round_trips_and_exposes_the_settlement() {
        let settlement = Settlement {
            request_id: 5,
            status: 2,
            reason: 0,
            amount_in: 1,
            amount_out: 100_000_000,
            lz_nonce: 0,
            recipient: [9u8; 32],
            cancelled_path: [0u8; 32],
        };
        let frame = ComposeFrame {
            nonce: 3,
            src_eid: 40245,
            amount_ld: 100_000_000_000,
            compose_from: [4u8; 32],
            compose_msg: settlement.encode(),
        };
        let parsed = ComposeFrame::parse(&frame.encode()).unwrap();
        assert_eq!(parsed, frame);
        assert_eq!(Settlement::decode(&parsed.compose_msg).unwrap(), settlement);
    }

    /// The bug this parser fixes: the frame was decoded as though it WERE the settlement.
    /// The nonce and eid in the first word make that decode fail, so every settlement delivered
    /// to Solana would have been rejected.
    #[test]
    fn a_raw_frame_is_not_a_settlement() {
        let frame = ComposeFrame {
            nonce: 1,
            src_eid: 40245,
            amount_ld: 1,
            compose_from: [4u8; 32],
            compose_msg: vec![0u8; 8 * WORD],
        };
        assert!(Settlement::decode(&frame.encode()).is_err());
    }

    #[test]
    fn short_frame_is_rejected() {
        assert!(ComposeFrame::parse(&[0u8; ComposeFrame::HEADER - 1]).is_err());
    }

    #[test]
    fn floor_rounds_up_to_shared_decimals() {
        // 9 local decimals, 6 shared: one shared unit is 1,000 local units.
        assert_eq!(ld_to_sd_ceil(95_000_000_000, 9, 6).unwrap(), 95_000_000);
        assert_eq!(ld_to_sd_ceil(95_000_000_001, 9, 6).unwrap(), 95_000_001, "never rounds a floor down");
        assert_eq!(ld_to_sd_ceil(0, 9, 6).unwrap(), 0);
        assert_eq!(ld_to_sd_ceil(1_234, 6, 6).unwrap(), 1_234, "equal decimals is the identity");
        assert!(ld_to_sd_ceil(1, 5, 6).is_err(), "local below shared cannot be represented");
    }
}
