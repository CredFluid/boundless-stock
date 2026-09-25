# Partner orders: access and fees

Partners (wallets, exchanges and apps) are how users on a mirror chain buy and sell. A partner
owns its users, including their KYC, and approves each order it sends. CrossStock provides the
buy and sell endpoints, and the contracts check that approval on chain.

- **Partners handle KYC.** With `partnerRequired` set, the plain `buy` / `sell` entrypoints are
  closed. Every order then carries the approval of a registered partner, so an unverified user
  cannot skip the partner by calling the contract directly.
- **Fees are only kept for a fill.** A partner fee (set per order, up to the partner's ceiling)
  and a platform fee come off the input and are held in escrow. They are paid out if the order
  fills and returned to the user if it doesn't (refund, cancellation or strand).
- **Only the mirror chain changes.** The message that crosses chains, the home relay and the
  relayer are unchanged. With no partners or fees configured, a deployment behaves exactly as
  before.

## How a partner approves an order

| | EVM mirror (`SwapRequest`) | Solana mirror (`swap_request`) |
|---|---|---|
| Approval | EIP-712 signature by the partner's signer | Co-signature of the transaction by the partner's authoriser key |
| User submits | `buyVia` / `sellVia(amountIn, minAmountOut, auth)` | `open_request_via_partner(params, fee_bps)` |
| Bound to | user, direction, amount, floor, fee, nonce, deadline, chain, contract | The exact transaction |
| Replay protection | One-time nonce per partner, plus a deadline | A transaction runs once, and its blockhash expires |
| Contract signers | Yes, via ERC-1271 (multisigs, smart accounts) | No: the authoriser must be a key that can co-sign |
| Withdrawing an approval | `invalidateNonce(partnerId, nonce)` | Don't co-sign, or let the blockhash expire |

### EVM: signing an order

The digest is standard EIP-712 with this domain:

- `name`: "CrossStock SwapRequest"
- `version`: "1"
- `chainId`: the mirror's chain
- `verifyingContract`: its `SwapRequest`

```
PartnerOrder(address user,uint8 direction,uint256 amountIn,uint256 minAmountOut,
             uint32 partnerId,uint16 feeBps,uint256 nonce,uint256 deadline)
```

`direction` is 0 for a buy and 1 for a sell. `amountIn` is what the user pays: the fees come off
it, and the rest is traded. `infra/lib/partners.ts` has `signPartnerOrder` (viem). Validation
scenario 10 checks its digest against the contract's own `hashPartnerOrder`.

The contract refuses the order if any of these hold:

- the signature doesn't match the order and the submitting account;
- the partner is inactive;
- the fee is above the partner's ceiling;
- the nonce was already used;
- the deadline has passed.

A custodial partner that signs with its own wallet is simply both the `user` and the signer.

### Solana: co-signing an order

The user's transaction calls `open_request_via_partner`, and it must also be signed by the
partner's registered authoriser key:

1. The partner's backend builds the transaction, or receives it from the user's wallet.
2. It checks the transaction is the order it approves.
3. It adds its signature.

The program refuses a transaction that isn't co-signed by the registered key
(`InvalidPartnerSigner`), or whose fee is above the partner's ceiling.

**Send it as a v0 transaction with an address lookup table.** A partner order carries a second
signature plus the partner's and escrow accounts. Together with the OFT send's LayerZero
accounts, that is about 1,370 bytes as a legacy transaction, above Solana's 1,232-byte limit.
A lookup table holding the static accounts brings it well under: programs, mints, store,
escrows, and the endpoint and library accounts. `infra/solana/client.ts` has
`openRequestViaPartner`, which builds one. A production deployment would publish its table
next to its program ids.

## Fees

| | EVM | Solana |
|---|---|---|
| Taken | From `amountIn`, at submission | From `amount_in`, at submission |
| Held in | `SwapRequest` (`feesReserved`) | The fee vault PDA (`[b"FeeVault"]`), recorded per request in `FeeEscrow` |
| Released | Automatically at settlement | `settle_fees`, permissionless, once the request is terminal |
| On a fill | Accrued to partner and platform; each withdraws with `claimFees(token, to)` | Paid to the partner's and platform's token accounts |
| Otherwise | Returned to the user with the refund | Returned to the user's token account |
| Ceilings | Partner 3% (300 bps), platform 1% (100 bps), hard-coded | Same |

Fees round down, and the arithmetic is identical on both VMs. A stranded order returns the fee
too: the mirror can't tell whether a strand followed a fill, so the user is never charged for an
order they didn't receive. On EVM, the owner's `sweep` can never reach fee tokens that are owed
to anyone.

On Solana, fees apply to partner orders only. The plain `open_request` carries no fee. On EVM,
the platform fee applies to plain orders too while they are open.

## Configuring a deployment

Add a `partners` section to the deployment config:

```jsonc
"partners": {
  "required": true,                       // close the plain entrypoints
  "platformFee": { "bps": 10, "recipient": { "evm": "0x…", "svm": "<pubkey>" } },
  "partners": [
    {
      "id": 1, "name": "Acme Wallet", "maxFeeBps": 50,
      "evm": { "signer": "0x…", "feeRecipient": "0x…" },
      "svm": { "signer": "<pubkey>", "feeRecipient": "<pubkey>" }
    }
  ]
}
```

`npm run deploy` applies it at the end. To onboard, re-key or switch off a partner on a running
deployment, edit the config and run:

```bash
npm run partners -- --config config/<deployment>.json
```

Nothing is redeployed. The command is idempotent and sets `required` last, so a deployment is
never closed before its partners exist.

Deactivating a partner (`"active": false`) stops its new orders at once, and fees already
escrowed are unaffected.

## Evidence

- **Foundry, `test/PartnerOrders.t.sol` (19 tests), covers:**
  - the authorisation's binding to the user and the order;
  - replay, expiry and the fee ceilings;
  - ERC-1271 signers;
  - the fee outcome for fill, refund, cancel and strand;
  - sweep protection;
  - a fee fuzz test.
- **Foundry, `test/invariant/RelayInvariant.t.sol`:** the campaign charges a fee on every order
  and checks two things throughout: the contract holds exactly the fees it owes, and every
  request's fee state matches its outcome.
- **Solana, `solana/programs/swap_request/src/partner_tests.rs`:**
  - fee arithmetic matching EVM;
  - the payout rule per status;
  - the authoriser and ceiling checks;
  - account sizes, including a store created before these fields still loading.
- **Validation scenario 10** runs on live local chains with an EVM home, an EVM mirror and a
  Solana mirror:
  - the gate holds;
  - the off-chain and on-chain digests match;
  - fills pay exact fees and the partner withdraws its share;
  - refunds return every unit;
  - a stranger can't use someone else's approval.

## Not yet covered

- **Partner self-service.** Only the owner or admin registers and updates partners, although an
  EVM partner can withdraw its own nonces.
- **The partner SDK and API** (quotes, building transactions, tracking, webhooks). That is the
  next branch, and it will build on `signPartnerOrder` and `openRequestViaPartner`.
- **Solana-home deployments.** Scenario 10 runs where the home chain is EVM. The partner logic
  is identical whatever the home chain, because none of it leaves the mirror, but the scenario's
  funding steps assume an EVM home.
