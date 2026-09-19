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
}
