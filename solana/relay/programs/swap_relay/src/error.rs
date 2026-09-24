use anchor_lang::prelude::*;

#[error_code]
pub enum SwapRelayError {
    #[msg("Only the relay admin may do this")]
    Unauthorized,
    #[msg("The pool does not trade this relay's pair, or an account is not the pool's")]
    PoolMismatch,
    #[msg("A mint's local decimals are below the shared decimals")]
    UnsupportedDecimals,
    #[msg("Delivering program is neither of this relay's OFTs")]
    UnexpectedComposeSource,
    #[msg("Mint is neither of this relay's assets")]
    WrongMint,
    #[msg("Accounts do not match the recorded return route or peer")]
    RouteMismatch,
    #[msg("Return route has more accounts than a route can record")]
    RouteTooLong,
    #[msg("Executor options are longer than a peer can record")]
    OptionsTooLong,
    #[msg("No SwapRequest is recorded for that mirror chain")]
    NoPeer,
    #[msg("The request or chain named does not match the compose message")]
    ComposeMismatch,
    #[msg("Not one of this relay's OFT stores")]
    WrongOft,
}
