//! Every way a submitted `lz_compose` can be wrong, and that each one is refused.
//!
//! The Executor is permissionless and picks the accounts it passes, so these checks are what
//! stand between a settlement and a payout to the wrong place. Each test starts from one valid
//! delivery and breaks exactly one thing, so a failure names the check that regressed.

use super::*;
use anchor_lang::error::Error;

const HOME_EID: u32 = 40245;
const HOME_RELAY: [u8; 32] = [0x11; 32];

struct Fixture {
    store: Store,
    store_key: Pubkey,
    user: Pubkey,
    request_id: u64,
}

impl Fixture {
    fn new() -> Self {
        let store = Store {
            admin: Pubkey::new_unique(),
            home_eid: HOME_EID,
            home_relay: HOME_RELAY,
            base_mint: Pubkey::new_unique(),
            quote_mint: Pubkey::new_unique(),
            base_oft: Pubkey::new_unique(),
            quote_oft: Pubkey::new_unique(),
            endpoint_program: Pubkey::new_unique(),
            next_request_id: 8,
            bump: 255,
            shared_decimals: 6,
            oft_program: Pubkey::new_unique(),
            partner_required: false,
            platform_fee_bps: 0,
            platform_fee_recipient: Pubkey::default(),
            base_token_2022: false,
            quote_token_2022: false,
        };
        Self { store, store_key: Pubkey::new_unique(), user: Pubkey::new_unique(), request_id: 7 }
    }

    fn request_key(&self, id: u64) -> Pubkey {
        Pubkey::find_program_address(&[Request::SEED, &id.to_be_bytes()], &crate::ID).0
    }

    fn settlement(&self) -> Settlement {
        Settlement {
            request_id: self.request_id,
            status: Status::Filled as u8,
            reason: 0,
            amount_in: 15_000_000_000,
            amount_out: 100_000_000,
            lz_nonce: 0,
            recipient: self.user.to_bytes(),
            cancelled_path: [0u8; 32],
        }
    }

    fn frame(&self, settlement: &Settlement) -> ComposeFrame {
        ComposeFrame {
            nonce: 1,
            src_eid: HOME_EID,
            amount_ld: 100_000_000_000,
            compose_from: HOME_RELAY,
            compose_msg: settlement.encode(),
        }
    }

    /// A buy settling: the stock OFT delivers the stock mint.
    fn params(&self, frame: &ComposeFrame) -> LzComposeParams {
        LzComposeParams {
            from: self.store.base_oft,
            to: self.store_key,
            guid: [0u8; 32],
            index: 0,
            message: frame.encode(),
            extra_data: vec![],
        }
    }

    fn accounts(&self) -> DeliveryAccounts {
        let mint = self.store.base_mint;
        DeliveryAccounts {
            mint,
            store_token_account: spl::associated_token_address(&self.store_key, &mint, &spl::TOKEN_PROGRAM_ID),
            user_token_account: spl::associated_token_address(&self.user, &mint, &spl::TOKEN_PROGRAM_ID),
            token_program: spl::TOKEN_PROGRAM_ID,
        }
    }

    fn verify(
        &self,
        params: &LzComposeParams,
        request_key: &Pubkey,
        request_user: &Pubkey,
        accounts: &DeliveryAccounts,
    ) -> Result<VerifiedSettlement> {
        verify_settlement(&self.store, &self.store_key, &crate::ID, params, request_key, request_user, accounts)
    }

    /// The untouched, valid delivery.
    fn verify_valid(&self) -> Result<VerifiedSettlement> {
        let params = self.params(&self.frame(&self.settlement()));
        self.verify(&params, &self.request_key(self.request_id), &self.user, &self.accounts())
    }
}

fn assert_code(result: Result<VerifiedSettlement>, expected: SwapRequestError) {
    match result {
        Ok(_) => panic!("expected {:?}, but the delivery was accepted", expected),
        Err(Error::AnchorError(e)) => assert_eq!(
            e.error_code_number,
            u32::from(expected.clone()),
            "expected {:?}, got {}",
            expected,
            e.error_name
        ),
        Err(other) => panic!("expected {:?}, got {:?}", expected, other),
    }
}

#[test]
fn a_valid_delivery_is_accepted_with_the_frames_amount() {
    let f = Fixture::new();
    let v = f.verify_valid().expect("the baseline delivery must pass, or every other test is vacuous");
    assert_eq!(v.mint, f.store.base_mint);
    assert_eq!(v.frame.amount_ld, 100_000_000_000, "the payout figure is what the OFT minted");
    assert_eq!(v.settlement.request_id, f.request_id);
}

#[test]
fn quote_oft_delivers_the_quote_mint() {
    let f = Fixture::new();
    let mut params = f.params(&f.frame(&f.settlement()));
    params.from = f.store.quote_oft;
    let mint = f.store.quote_mint;
    let accounts = DeliveryAccounts {
        mint,
        store_token_account: spl::associated_token_address(&f.store_key, &mint, &spl::TOKEN_PROGRAM_ID),
        user_token_account: spl::associated_token_address(&f.user, &mint, &spl::TOKEN_PROGRAM_ID),
        token_program: spl::TOKEN_PROGRAM_ID,
    };
    let v = f.verify(&params, &f.request_key(f.request_id), &f.user, &accounts).unwrap();
    assert_eq!(v.mint, mint);
}

#[test]
fn an_unknown_oft_is_refused() {
    let f = Fixture::new();
    let mut params = f.params(&f.frame(&f.settlement()));
    params.from = Pubkey::new_unique();
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &f.accounts()),
        SwapRequestError::UnexpectedComposeSource,
    );
}

#[test]
fn a_settlement_from_another_chain_is_refused() {
    let f = Fixture::new();
    let mut frame = f.frame(&f.settlement());
    frame.src_eid = 40231;
    assert_code(
        f.verify(&f.params(&frame), &f.request_key(f.request_id), &f.user, &f.accounts()),
        SwapRequestError::UnexpectedOrigin,
    );
}

/// Anyone can bridge the stock to this store with a compose message attached. Only the home
/// relay's messages are settlements.
#[test]
fn a_settlement_not_sent_by_the_home_relay_is_refused() {
    let f = Fixture::new();
    let mut frame = f.frame(&f.settlement());
    frame.compose_from = [0x22; 32];
    assert_code(
        f.verify(&f.params(&frame), &f.request_key(f.request_id), &f.user, &f.accounts()),
        SwapRequestError::UnauthorizedSource,
    );
}

#[test]
fn nothing_is_accepted_before_the_home_relay_is_wired() {
    let mut f = Fixture::new();
    f.store.home_relay = [0u8; 32];
    let mut frame = f.frame(&f.settlement());
    frame.compose_from = [0u8; 32];
    assert_code(
        f.verify(&f.params(&frame), &f.request_key(f.request_id), &f.user, &f.accounts()),
        SwapRequestError::UnauthorizedSource,
    );
}

/// The submitter picks the request account. A settlement for request 7 must not close request 8.
#[test]
fn a_settlement_cannot_close_a_different_request() {
    let f = Fixture::new();
    let params = f.params(&f.frame(&f.settlement()));
    assert_code(
        f.verify(&params, &f.request_key(f.request_id + 1), &f.user, &f.accounts()),
        SwapRequestError::RequestMismatch,
    );
}

#[test]
fn a_settlement_naming_someone_else_is_refused() {
    let f = Fixture::new();
    let mut settlement = f.settlement();
    settlement.recipient = Pubkey::new_unique().to_bytes();
    assert_code(
        f.verify(&f.params(&f.frame(&settlement)), &f.request_key(f.request_id), &f.user, &f.accounts()),
        SwapRequestError::RecipientMismatch,
    );
}

#[test]
fn the_wrong_mint_is_refused() {
    let f = Fixture::new();
    let mut accounts = f.accounts();
    accounts.mint = f.store.quote_mint;
    let params = f.params(&f.frame(&f.settlement()));
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &accounts),
        SwapRequestError::WrongMint,
    );
}

/// The theft case: pay the settlement into an account the submitter controls.
#[test]
fn the_payout_cannot_be_redirected() {
    let f = Fixture::new();
    let mut accounts = f.accounts();
    accounts.user_token_account = spl::associated_token_address(&Pubkey::new_unique(), &f.store.base_mint, &spl::TOKEN_PROGRAM_ID);
    let params = f.params(&f.frame(&f.settlement()));
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &accounts),
        SwapRequestError::WrongTokenAccount,
    );
}

#[test]
fn the_payout_source_must_be_the_stores_own_account() {
    let f = Fixture::new();
    let mut accounts = f.accounts();
    accounts.store_token_account = Pubkey::new_unique();
    let params = f.params(&f.frame(&f.settlement()));
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &accounts),
        SwapRequestError::WrongTokenAccount,
    );
}

#[test]
fn a_truncated_message_is_refused() {
    let f = Fixture::new();
    let mut params = f.params(&f.frame(&f.settlement()));
    params.message.truncate(ComposeFrame::HEADER - 1);
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &f.accounts()),
        SwapRequestError::MalformedPayload,
    );
}

// ---------------------------------------------------------------------------- notices

/// A plain OApp message from the home relay, as `lz_receive` receives it.
fn notice_params(_f: &Fixture, notice: &Settlement) -> LzReceiveParams {
    LzReceiveParams {
        src_eid: HOME_EID,
        sender: HOME_RELAY,
        nonce: 1,
        guid: [0u8; 32],
        message: notice.encode(),
        extra_data: vec![],
    }
}

fn cancelled(f: &Fixture, lz_nonce: u64) -> Settlement {
    Settlement {
        request_id: 0,
        status: Status::Cancelled as u8,
        reason: 0,
        amount_in: 0,
        amount_out: 0,
        lz_nonce,
        recipient: [0u8; 32],
        cancelled_path: f.store.quote_oft.to_bytes(),
    }
}

fn assert_err<T>(result: Result<T>, expected: SwapRequestError) {
    match result {
        Ok(_) => panic!("expected {:?}, but it was accepted", expected),
        Err(Error::AnchorError(e)) => assert_eq!(e.error_code_number, u32::from(expected.clone()), "got {}", e.error_name),
        Err(other) => panic!("expected {:?}, got {:?}", expected, other),
    }
}

#[test]
fn a_stranded_notice_from_the_home_relay_is_accepted() {
    let f = Fixture::new();
    let mut n = f.settlement();
    n.status = Status::Stranded as u8;
    assert_eq!(verify_notice(&f.store, &notice_params(&f, &n)).unwrap().request_id, f.request_id);
}

#[test]
fn a_notice_from_anyone_but_the_home_relay_is_refused() {
    let f = Fixture::new();
    let mut p = notice_params(&f, &cancelled(&f, 1));
    p.sender = [0x22; 32];
    assert_err(verify_notice(&f.store, &p), SwapRequestError::UnauthorizedSource);
}

#[test]
fn a_notice_from_another_chain_is_refused() {
    let f = Fixture::new();
    let mut p = notice_params(&f, &cancelled(&f, 1));
    p.src_eid = 40231;
    assert_err(verify_notice(&f.store, &p), SwapRequestError::UnexpectedOrigin);
}

/// Fills and refunds carry tokens and arrive by compose; one arriving here is not ours to apply.
#[test]
fn a_fill_is_not_a_notice() {
    let f = Fixture::new();
    assert_err(verify_notice(&f.store, &notice_params(&f, &f.settlement())), SwapRequestError::UnknownSettlementStatus);
}

/// One valid cancellation, and every way its accounts can be wrong.
struct Cancellation {
    f: Fixture,
    notice: Settlement,
    index: NonceIndex,
}

impl Cancellation {
    fn new() -> Self {
        let f = Fixture::new();
        let notice = cancelled(&f, 5);
        let index = NonceIndex { request_id: f.request_id, user: f.user, token_in: f.store.quote_mint };
        Self { f, notice, index }
    }

    fn accounts(&self) -> (Pubkey, CancellationAccounts<'_>) {
        let mint = self.f.store.quote_mint;
        (
            self.f.request_key(self.f.request_id),
            CancellationAccounts {
                nonce_index: nonce_index_address(&crate::ID, &self.notice),
                index: &self.index,
                oft_program: self.f.store.oft_program,
                oft_store: self.f.store.quote_oft,
                token_mint: mint,
                token_dest: spl::associated_token_address(&self.f.user, &mint, &spl::TOKEN_PROGRAM_ID),
            },
        )
    }

    fn verify(&self, request: &Pubkey, user: &Pubkey, a: &CancellationAccounts) -> Result<()> {
        verify_cancellation(&self.f.store, &crate::ID, &self.notice, request, user, a)
    }
}

#[test]
fn a_valid_cancellation_is_accepted() {
    let c = Cancellation::new();
    let (request, a) = c.accounts();
    c.verify(&request, &c.f.user, &a).expect("the baseline must pass, or every rejection below is vacuous");
}

/// The nonce-collision case on Solana: the same nonce on the OTHER asset's path is another index.
#[test]
fn an_index_for_the_other_path_is_refused() {
    let c = Cancellation::new();
    let (request, mut a) = c.accounts();
    let mut other = c.notice.clone();
    other.cancelled_path = c.f.store.base_oft.to_bytes();
    a.nonce_index = nonce_index_address(&crate::ID, &other);
    assert_err(c.verify(&request, &c.f.user, &a), SwapRequestError::RequestMismatch);
}

#[test]
fn a_different_request_is_refused() {
    let c = Cancellation::new();
    let (_, a) = c.accounts();
    assert_err(c.verify(&c.f.request_key(c.f.request_id + 1), &c.f.user, &a), SwapRequestError::RequestMismatch);
}

#[test]
fn an_index_naming_another_user_is_refused() {
    let c = Cancellation::new();
    let (request, a) = c.accounts();
    assert_err(c.verify(&request, &Pubkey::new_unique(), &a), SwapRequestError::RecipientMismatch);
}

/// The mint authority case: only this store's own OFT program may be asked to mint.
#[test]
fn a_foreign_oft_program_is_refused() {
    let c = Cancellation::new();
    let (request, mut a) = c.accounts();
    a.oft_program = Pubkey::new_unique();
    assert_err(c.verify(&request, &c.f.user, &a), SwapRequestError::WrongOftProgram);
}

#[test]
fn minting_the_other_asset_is_refused() {
    let c = Cancellation::new();
    let (request, mut a) = c.accounts();
    a.token_mint = c.f.store.base_mint;
    assert_err(c.verify(&request, &c.f.user, &a), SwapRequestError::WrongMint);
}

/// The theft case: restore the input into an account the submitter controls.
#[test]
fn the_restored_input_cannot_be_redirected() {
    let c = Cancellation::new();
    let (request, mut a) = c.accounts();
    a.token_dest = spl::associated_token_address(&Pubkey::new_unique(), &c.f.store.quote_mint, &spl::TOKEN_PROGRAM_ID);
    assert_err(c.verify(&request, &c.f.user, &a), SwapRequestError::WrongTokenAccount);
}

// ---------------------------------------------------------------------------- Token-2022

/// A Token-2022 store: deliveries must name Token-2022 accounts and the Token-2022 program.
#[test]
fn a_token_2022_delivery_uses_token_2022_accounts_and_program() {
    let mut f = Fixture::new();
    f.store.base_token_2022 = true;
    let params = f.params(&f.frame(&f.settlement()));
    let mint = f.store.base_mint;
    let t22 = spl::TOKEN_2022_PROGRAM_ID;
    let good = DeliveryAccounts {
        mint,
        store_token_account: spl::associated_token_address(&f.store_key, &mint, &t22),
        user_token_account: spl::associated_token_address(&f.user, &mint, &t22),
        token_program: t22,
    };
    assert!(f.verify(&params, &f.request_key(f.request_id), &f.user, &good).is_ok());

    // The classic program, or classic-derived accounts, are refused for a Token-2022 mint.
    let wrong_program = DeliveryAccounts { token_program: spl::TOKEN_PROGRAM_ID, ..good };
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &wrong_program),
        SwapRequestError::UnsupportedTokenProgram,
    );
    let classic_accounts = f.accounts(); // derived under the classic program
    let with_t22 = DeliveryAccounts { token_program: t22, ..classic_accounts };
    assert_code(
        f.verify(&params, &f.request_key(f.request_id), &f.user, &with_t22),
        SwapRequestError::WrongTokenAccount,
    );
}
