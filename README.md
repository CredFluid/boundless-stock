# CrossStock

**One market for every tokenized stock, on Solana, reachable from every chain. Liquidity and
operations are managed from one chain and one place.**

## The problem: tokenized stocks are breaking into pieces

Tokenized stocks are arriving on many chains at once. Each new chain gets its own copy of the
stock, and with it:

- **its own thin pool,** so the same share trades at different prices on different chains, and
  a large order moves the price far more than it should;
- **its own liquidity to fund,** so an issuer seeds many small markets instead of one deep one;
- **its own operations,** so contracts, fees, stuck transfers and refunds are handled chain by
  chain, by hand;
- **its own ledger,** so nobody can say, at a glance, how much of the stock exists in total or
  where it sits.

This is fragmentation, and it is what has held tokenized assets back. The industry's usual
answers each fix one part of it:

- **A bridge** moves the token, but the holder often ends up with a wrapped IOU, and every chain
  still needs its own market.
- **A pool on every chain** gives each chain a market, but splits the liquidity further.
- **Unified accounting** (one hub keeping the books for many chains) fixes the ledger, but the
  stock still trades in separate markets.

The books can be unified. **The market has not been.**

## Our answer: Solana is the home market, every other chain a doorway

CrossStock makes Solana the **hub**: the chain where the stock's market lives, with one pool of
liquidity and one price. Every other chain is a **spoke**, a doorway into that market with no
pool of its own.

```
 Other chains (spokes)                                            Solana (hub)
 ┌──────────────────────────────────┐   order + funds      ┌──────────────────────────────────┐
 │ a buy or sell order is placed     │ ───────────────────► │ the order fills in the home      │
 │                                   │                      │ market: one price, one pool      │
 │ the stock or proceeds arrive      │ ◄─────────────────── │ of liquidity                     │
 │ on the same chain                 │   stock + outcome    └──────────────────────────────────┘
 └──────────────────────────────────┘
```

An order placed on another chain crosses to Solana, fills against the home market at the real
market price, and the stock (or the proceeds of a sale) is delivered back on the chain the order
came from. Nothing is wrapped, and no market is needed on that chain.

For the issuer, this changes where everything is managed:

- **Liquidity on Solana.** The liquidity on Solana powers trades on every other chain.
- **Operations in one place.** Refunds happen automatically at the hub. Stuck-order
  cancellation, recovery of stranded returns, partners and fees are driven from one command line
  across every chain, and tracked in one issuer dashboard.
- **One source of truth.** Supply on every chain, tokens in flight between chains, the live
  market and every trade are in one view.

## How it stays honest

**Tokens move by burn and mint, not by wrapping.** Every asset is an omnichain token (LayerZero
OFT):

- it is burned (or, for an issuer's existing token, locked) on the chain it leaves;
- it is minted on the chain it arrives at;
- a real trade in the home market happens in between.

**Supply is conserved.** Supply on every chain plus what is in flight always equals what was
issued. A spoke can never create supply. The validation suite checks this after every scenario,
and the dashboard shows it live.

**Nothing is ever lost:**

- an order that can't fill is refunded in full;
- a stuck message can be cancelled and the funds restored;
- a return that can't be delivered is held and retried.

**Fees are only kept on a fill.** Partner and platform fees wait in escrow, and are returned if
the order is refunded, cancelled or stranded.

## Built to be a platform

| | |
|---|---|
| **Issuers keep their token** | Bring an existing SPL mint (Token-2022 included). It is locked in a vault, never replaced, and the issuer keeps the mint authority. Or launch a new one. |
| **Partners bring the users** | Wallets, exchanges and apps integrate buy and sell through an SDK and API, and handle KYC on their side. With `partnerRequired`, only orders a registered partner approved get in; on Solana the partner co-signs. See [`PARTNERS.md`](PARTNERS.md). |
| **Exact quotes** | The API asks the home market itself, so an order fills at its quote to the base unit. |
| **An issuer dashboard** | Supply per chain with the conservation check, the live market, trade history and operations queues. |
| **Solana as the home chain** | The market, the liquidity and the operations live on Solana. Other chains, EVM chains and other Solana chains alike, connect to it as spokes. |

## What we have proven

Everything above runs today on local chains, with the real LayerZero V2 programs and contracts,
and our own relayer standing in for LayerZero's network. An order of 15,000 USDC placed on an EVM
chain crossed to Solana, filled against the home market, and delivered 99.32568 tAAPL back on
the chain it came from, in 2.9 seconds, on a chain that has no market of its own. The same pool
served an order from a second Solana chain (10,000 USDC for 66.137881 tAAPL) without it ever
touching an EVM chain. The safety paths hold: an unfillable order is refunded in full, a stranded
return is recovered by retry, and a stuck order is cancelled and restored. Partner orders are
gated and co-signed, fees are kept only on fills, and orders placed through the SDK fill at
exactly their quote. It all works the same with Token-2022 mints, and after every scenario the
total supply across chains still equals what was issued. This is covered by 85 contract tests
(fuzz and invariants included), 55 Solana program tests, SDK tests and 11 end-to-end scenarios.

## Where it goes next

- **Proof of reserves.** The issued half (supply across every chain, in flight included) is
  already measured live. Pairing it with a reserve source (custodian, issuer or oracle) gives a
  continuous "issued ≤ held" check. See [`PROOF_OF_RESERVES.md`](PROOF_OF_RESERVES.md).
- **One price on every chain.** Publish the home market's price to every spoke, checked against
  a reference price of the underlying share, so apps on any chain can price the stock without a
  pool of their own.
- **Holders across chains,** alongside supply, in the issuer dashboard.

## Quick start

```bash
npm install && forge build
npm run solana:build && npm run solana:build:relay        # swap_request, swap_relay (see solana/README.md for the rest)

C=config/localnet-solana-home-svm-mirror.json              # Solana home; three EVM chains + a second Solana chain as spokes
npm run solana:up -- --config $C && npm run chains:up      # local Solana validators + EVM chains
npm run solana:deploy -- --config $C                       # programs onto the validators
npm run deploy   -- --config $C                            # full pipeline -> manifest
npm run validate -- --config $C                            # scenarios 8, 9, 10, 11
npm run supply   -- --config $C                            # where every token lives, across chains
npm run web:dev                                            # issuer dashboard: http://localhost:3000/app
```

Other setups are a different config, with no code changes:

| Config | Home | Spokes |
|---|---|---|
| `localnet-solana-home.json` | Solana | three EVM chains |
| `localnet-solana-home-svm-mirror.json` | Solana | three EVM chains and a second Solana chain |
| `localnet-solana-home-t22.json` | Solana, **Token-2022 mints** | three EVM chains and a second Solana chain |
| `localnet-solana-home-adapter.json` | Solana, **the issuer's existing SPL mint** | three EVM chains |

Onboard partners and set fees on a running deployment with `npm run partners -- --config …`. The
partner API (`/api/v1`) and the SDK (`@crossstock/sdk`) are described in [`PARTNERS.md`](PARTNERS.md).

## Honest limits

- **Local chains only so far.** Deploying on Solana devnet and public testnets with LayerZero's
  own network is the next step.
- **Token-2022: standard mints only.** Token-2022 mints work end to end (metadata extensions
  included; see `NOTES.md`). Mints with transfer fees, a permanent delegate or a transfer hook
  (which includes today's PreStocks) are refused, because each needs a product decision (who
  bears a fee, whether a delegate over the escrow is acceptable) before it can be carried safely.
- **The stock is a test token (tAAPL),** and USDC is our own omnichain token. A live deployment
  would pair the stock with a stablecoin that moves natively between chains.
