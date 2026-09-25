use anchor_lang::prelude::*;

#[error_code]
pub enum SwapRequestError {
    #[msg("Payload is shorter than the wire format requires")]
    MalformedPayload,
    #[msg("Encoded value does not fit the expected type; the two chains disagree about it")]
    PayloadValueTooLarge,
    #[msg("Settlement did not come from the registered home-chain relay")]
    UnauthorizedSource,
    #[msg("Settlement arrived from an endpoint id that is not the home chain")]
    UnexpectedOrigin,
    #[msg("Delivering program is neither of this store's OFTs")]
    UnexpectedComposeSource,
    #[msg("Request is not pending, so it cannot be settled again")]
    RequestNotPending,
    #[msg("Settlement references a different request than the account supplied")]
    RequestMismatch,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Entire input is below the bridge's precision floor, so nothing could cross")]
    AmountBelowBridgeableMinimum,
    #[msg("Home-chain relay peer has not been set")]
    PeerNotSet,
    #[msg("Only the store admin may do this")]
    Unauthorized,
    #[msg("Settlement status is not a recognised terminal state")]
    UnknownSettlementStatus,
    #[msg("A mint's local decimals are below the shared decimals, so its amounts cannot cross")]
    UnsupportedDecimals,
    #[msg("Mint does not match the one this store uses for that side of the trade")]
    WrongMint,
    #[msg("Settlement names a different recipient than the request records")]
    RecipientMismatch,
    #[msg("Token account is not the expected associated token account")]
    WrongTokenAccount,
    #[msg("Only the OFT program recorded at initialisation may be called")]
    WrongOftProgram,
    #[msg("Orders must come through a partner")]
    PartnerRequired,
    #[msg("Partner is not registered or not active")]
    UnknownPartner,
    #[msg("Transaction was not co-signed by the partner's authoriser")]
    InvalidPartnerSigner,
    #[msg("Fee is above the allowed ceiling")]
    FeeTooHigh,
    #[msg("Partner id, signer and fee recipient must all be set")]
    InvalidPartner,
    #[msg("This request has no fees in escrow")]
    FeesNotEscrowed,
    #[msg("The request has not settled yet, so its fees cannot be released")]
    RequestNotSettled,
    #[msg("Mint is owned by neither SPL Token nor Token-2022")]
    UnsupportedTokenProgram,
    #[msg("Mint carries a Token-2022 extension CrossStock does not support")]
    UnsupportedMintExtension,
}
