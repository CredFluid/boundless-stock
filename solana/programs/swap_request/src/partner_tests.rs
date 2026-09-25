//! Host tests for partner orders and their fees: the rules `open_request_via_partner` and
//! `settle_fees` apply, which match `SwapRequest.sol` on EVM.

use super::*;

fn partner(active: bool) -> Partner {
    Partner {
        partner_id: 7,
        signer: Pubkey::new_unique(),
        fee_recipient: Pubkey::new_unique(),
        max_fee_bps: 100,
        active,
        bump: 255,
    }
}

fn escrow(partner_fee: u64, platform_fee: u64) -> FeeEscrow {
    FeeEscrow {
        request_id: 1,
        partner_id: 7,
        user: Pubkey::new_unique(),
        mint: Pubkey::new_unique(),
        partner_recipient: Pubkey::new_unique(),
        platform_recipient: Pubkey::new_unique(),
        partner_fee,
        platform_fee,
        state: FeeState::Escrowed,
        bump: 255,
    }
}

fn is_err<T: std::fmt::Debug>(r: Result<T>, e: SwapRequestError) -> bool {
    match r {
        Err(anchor_lang::error::Error::AnchorError(a)) => a.error_code_number == u32::from(e),
        other => panic!("expected {e:?}, got {other:?}"),
    }
}

#[test]
fn fees_match_the_evm_arithmetic() {
    // 15,000 USDC at 0.5% + 0.1%: the figures the Foundry test asserts.
    let f = compute_fees(15_000_000_000, 50, 10).unwrap();
    assert_eq!(f, Fees { partner: 75_000_000, platform: 15_000_000, net: 14_910_000_000 });
}

#[test]
fn fees_round_down_and_never_exceed_the_input() {
    let f = compute_fees(199, 50, 10).unwrap(); // 0.995 and 0.199 units
    assert_eq!(f, Fees { partner: 0, platform: 0, net: 199 });
    let f = compute_fees(u64::MAX, MAX_PARTNER_FEE_BPS, MAX_PLATFORM_FEE_BPS).unwrap();
    assert_eq!(f.partner + f.platform + f.net, u64::MAX, "no overflow at the extreme, and nothing lost");
}

#[test]
fn a_fee_is_kept_only_for_a_fill() {
    let e = escrow(75, 15);
    assert_eq!(fee_payout(Status::Filled, &e).unwrap(), Payout { partner: 75, platform: 15, user: 0 });
    for status in [Status::Refunded, Status::Cancelled, Status::Stranded] {
        assert_eq!(fee_payout(status, &e).unwrap(), Payout { partner: 0, platform: 0, user: 90 }, "{status:?}");
    }
}

#[test]
fn fees_cannot_be_released_before_the_request_settles() {
    assert!(is_err(fee_payout(Status::Pending, &escrow(75, 15)), SwapRequestError::RequestNotSettled));
}

#[test]
fn only_the_registered_authoriser_can_approve_within_the_ceiling() {
    let p = partner(true);
    check_partner(&p, &p.signer, 100).unwrap();
    assert!(is_err(check_partner(&p, &Pubkey::new_unique(), 50), SwapRequestError::InvalidPartnerSigner));
    assert!(is_err(check_partner(&p, &p.signer, 101), SwapRequestError::FeeTooHigh));
    assert!(is_err(check_partner(&partner(false), &p.signer, 50), SwapRequestError::UnknownPartner));
}

#[test]
fn partner_terms_are_validated() {
    let ok = PartnerTerms {
        signer: Pubkey::new_unique(),
        fee_recipient: Pubkey::new_unique(),
        max_fee_bps: MAX_PARTNER_FEE_BPS,
        active: true,
    };
    validate_terms(1, &ok).unwrap();
    assert!(is_err(validate_terms(0, &ok), SwapRequestError::InvalidPartner));
    let over = PartnerTerms { max_fee_bps: MAX_PARTNER_FEE_BPS + 1, ..ok.clone() };
    assert!(is_err(validate_terms(1, &over), SwapRequestError::FeeTooHigh));
    let no_signer = PartnerTerms { signer: Pubkey::default(), ..ok };
    assert!(is_err(validate_terms(1, &no_signer), SwapRequestError::InvalidPartner));
}

/// The partner fields were appended to `Store` inside its headroom, so stores created before
/// them — at the same size — still load, and read the new fields as zero.
#[test]
fn accounts_fit_their_declared_sizes() {
    let store = Store {
        admin: Pubkey::default(),
        home_eid: 0,
        home_relay: [0; 32],
        base_mint: Pubkey::default(),
        quote_mint: Pubkey::default(),
        base_oft: Pubkey::default(),
        quote_oft: Pubkey::default(),
        endpoint_program: Pubkey::default(),
        next_request_id: 0,
        bump: 0,
        shared_decimals: 0,
        oft_program: Pubkey::default(),
        partner_required: false,
        platform_fee_bps: 0,
        platform_fee_recipient: Pubkey::default(),
        base_token_2022: false,
        quote_token_2022: false,
    };
    let len = |v: &dyn Fn(&mut Vec<u8>)| {
        let mut b = Vec::new();
        v(&mut b);
        8 + b.len()
    };
    assert!(len(&|b| store.serialize(b).unwrap()) <= Store::SIZE);
    assert!(len(&|b| partner(true).serialize(b).unwrap()) <= Partner::SIZE);
    assert!(len(&|b| escrow(1, 1).serialize(b).unwrap()) <= FeeEscrow::SIZE);

    // A store written before the partner fields: the same bytes, the tail left zero.
    let mut old = Vec::new();
    store.serialize(&mut old).unwrap();
    old.truncate(old.len() - 37); // before the partner fields (35) and Token-2022 flags (2)
    old.resize(Store::SIZE - 8, 0);
    let read = Store::deserialize(&mut &old[..]).unwrap();
    assert!(!read.partner_required);
    assert_eq!(read.platform_fee_bps, 0);
}

// ---------------------------------------------------------------------------- Token-2022

fn t22_mint(extensions: &[(u16, usize)]) -> Vec<u8> {
    // base mint (82) padded to an account's length (165), the account-type byte, then TLV
    let mut d = vec![0u8; 165];
    d[44] = 9; // decimals
    d[45] = 1; // is_initialized
    d.push(1); // AccountType::Mint
    for (kind, len) in extensions {
        d.extend_from_slice(&kind.to_le_bytes());
        d.extend_from_slice(&(*len as u16).to_le_bytes());
        d.extend(std::iter::repeat(0u8).take(*len));
    }
    d
}

#[test]
fn token_2022_extensions_are_read_from_the_tlv_list() {
    assert!(crate::spl::mint_extensions(&[0u8; 82]).is_empty(), "a classic mint has none");
    assert_eq!(crate::spl::mint_extensions(&t22_mint(&[(18, 64), (19, 90)])), vec![18, 19]);
}

#[test]
fn only_the_refused_extensions_are_refused() {
    let refused: Vec<u16> = crate::spl::REFUSED_EXTENSIONS.iter().map(|(k, _)| *k).collect();
    // Metadata pointer and token metadata (what most stock tokens carry) are fine.
    for k in [3u16, 4, 18, 19, 25] {
        assert!(!refused.contains(&k), "extension {k} should be allowed");
    }
    for k in [1u16, 6, 9, 12, 14, 16] {
        assert!(refused.contains(&k), "extension {k} should be refused");
    }
}

#[test]
fn a_token_2022_store_derives_token_2022_accounts() {
    let mut store = store_fixture();
    store.base_token_2022 = true;
    assert_eq!(store.token_program_for(&store.base_mint), crate::spl::TOKEN_2022_PROGRAM_ID);
    assert_eq!(store.token_program_for(&store.quote_mint), crate::spl::TOKEN_PROGRAM_ID);
    let wallet = Pubkey::new_unique();
    assert_ne!(
        crate::spl::associated_token_address(&wallet, &store.base_mint, &crate::spl::TOKEN_2022_PROGRAM_ID),
        crate::spl::associated_token_address(&wallet, &store.base_mint, &crate::spl::TOKEN_PROGRAM_ID),
        "the same wallet and mint have a different account under each program"
    );
}

fn store_fixture() -> Store {
    Store {
        admin: Pubkey::default(),
        home_eid: 0,
        home_relay: [0; 32],
        base_mint: Pubkey::new_unique(),
        quote_mint: Pubkey::new_unique(),
        base_oft: Pubkey::default(),
        quote_oft: Pubkey::default(),
        endpoint_program: Pubkey::default(),
        next_request_id: 0,
        bump: 0,
        shared_decimals: 6,
        oft_program: Pubkey::default(),
        partner_required: false,
        platform_fee_bps: 0,
        platform_fee_recipient: Pubkey::default(),
        base_token_2022: false,
        quote_token_2022: false,
    }
}
