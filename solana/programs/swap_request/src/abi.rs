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
}

impl Settlement {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(5 * WORD);
        write_u64(&mut out, self.request_id);
        write_u8(&mut out, self.status);
        write_u8(&mut out, self.reason);
        write_u128(&mut out, self.amount_in);
        write_u128(&mut out, self.amount_out);
        out
    }

    pub fn decode(data: &[u8]) -> Result<Self> {
        Ok(Self {
            request_id: read_u64(data, 0)?,
            status: read_u8(data, 1)?,
            reason: read_u8(data, 2)?,
            amount_in: read_u128(data, 3)?,
            amount_out: read_u128(data, 4)?,
        })
    }
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
        };
        assert_eq!(Settlement::decode(&s.encode()).unwrap(), s);
        assert_eq!(s.encode().len(), 5 * WORD, "must match abi.encode of five value types");
    }

    #[test]
    fn truncated_payload_is_rejected() {
        let s = Settlement { request_id: 1, status: 2, reason: 0, amount_in: 1, amount_out: 1 };
        let encoded = s.encode();
        assert!(Settlement::decode(&encoded[..encoded.len() - 1]).is_err());
    }

    #[test]
    fn oversized_value_is_rejected_not_truncated() {
        // A uint256 that does not fit u64 means the two sides disagree about the type.
        let mut data = vec![0u8; 5 * WORD];
        data[0] = 1; // high byte of the first word
        assert!(Settlement::decode(&data).is_err());
    }
}
