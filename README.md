# Boundless Stock

**A reference market for every tokenized stock, on Solana, reachable from every chain.
Liquidity and operations are managed from one chain and one place.**

## The problem: tokenized stocks are breaking into pieces

A tokenized stock is not like other tokens. When a team launches a token on chain, it decides
how much to mint, and can mint more whenever a new market needs liquidity. A tokenized stock
has no such freedom: its supply is fixed by the real shares that back it. An issuer holding
100,000 shares can issue 100,000 tokens, and not one more. That limited supply is the whole
point, and it is also the problem.

Tokenized stocks are arriving on many chains at once. Every chain the stock goes to takes a
slice of that same fixed supply, and with it gets:

- **its own thin pool,** carved out of a supply that cannot grow to fill it, so the same share
  trades at different prices on different chains, and a large order moves the price far more
  than it should;
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

Boundless Stock makes Solana the **hub**. The stock is issued on Solana and lives there, and its
reference market lives there too: the deepest pool of liquidity and the reference price, with
the backed supply held in one place instead of split across chains.

Every other chain is a **spoke**. Each spoke gets a **mirror** of the stock: a real, valid token
native to that chain, which can be held, transferred and used like any other token there.
A mirror is never a separate issue. It is minted on a spoke only when stock arrives from
Solana, and burned when it leaves, so every mirror token is one of the original backed tokens,
just located on another chain. A spoke doesn't need a pool of its own to be tradable: orders
placed through Boundless Stock fill on the market on Solana.

Once delivered, a mirror is an ordinary token on its chain. Holders transfer it to each other,
and a local pool can list it and trade it there, without touching Solana. Supply accounting
still holds, because only moves between chains burn and mint. Solana stays the reference
market: it holds the deepest liquidity and sets the price, and a local pool that drifts from it
can be arbitraged back through Boundless Stock.

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
came from. Nothing is wrapped, and the chain needs no market of its own for this to work.

For the issuer, this changes where everything is managed:

- **Liquidity on Solana.** The liquidity on Solana powers trades on every other chain, with
  no pool to fund there first.
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

**Supply is conserved, so the backing holds.** Supply on every chain plus what is in flight
always equals what was issued, and so always matches the shares behind it. A spoke can never
create supply; moving the stock between chains only changes where it sits. The validation suite checks this after every scenario,
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
| **An issuer dashboard** | Supply per chain with the conservation check, holders across chains, the live market, trade history and operations queues. |
| **Proof of reserves** | Supply across every chain, in flight included, checked continuously against the shares held by the custodian, issuer or an oracle: issued ≤ held. See [`PROOF_OF_RESERVES.md`](PROOF_OF_RESERVES.md). |
| **Solana as the home chain** | The market, the liquidity and the operations live on Solana. Other chains, EVM chains and other Solana chains alike, connect to it as spokes. |

## For developers

Issuers bring the stock. Developers bring the users. Any wallet, exchange, neobank or trading
app on another chain can offer buy and sell for a tokenized stock without running a pool, a
bridge or its own liquidity, and any app can build on what only the home market can see. The
SDK (`@boundless-stock/sdk`) and API (`/api/v1`) offer:

**Trading** (for developers who bring users; they handle KYC, the market is ours):

| | |
|---|---|
| **Discover** | Which stocks are available, on which chains, with every address needed to trade them. |
| **Exact quotes** | A price for a given size from the home market itself. Orders fill at their quote to the base unit; price impact and the cross-chain messaging fee are included. |
| **Ready-to-sign orders** | A transaction, on an EVM chain or Solana, signed in the user's own wallet. The developer never holds user funds. |
| **Partner approval** | A typed-data signature on EVM, or a checked co-signature on Solana that refuses anything but the approved amount, side, fee and floor. |
| **Tracking and webhooks** | Follow an order until it is filled, refunded or cancelled, and receive signed notifications when it settles. |
| **Partner fees** | The developer sets its own fee, up to a cap, charged only on a fill: a business model built in. |
| **Contract-level buying** | Orders placed by smart contracts, not only wallets, so a vault, a savings app or an index product on another chain can buy and hold tokenized stocks automatically. |
| **Embeddable widget** | The buy and sell flow as a drop-in component, for apps that don't want to build it. |

**Data** (open to every developer):

| | |
|---|---|
| **Market data on every chain** | The stock's price in the home market, and its premium or discount to the real share, for portfolio apps, dashboards and trading tools on any chain. |
| **A price feed on every chain** | An on-chain price, checked against a reference price of the underlying share, that lending and perpetuals protocols on other chains can read. This turns a mirror token into collateral, not just something to hold. |
| **Supply and holders** | Supply per chain, stock in flight between chains, and holder counts, for explorers, analytics platforms and investor relations. |
| **Proof of reserves** | "Is this token fully backed right now?" `GET /api/v1/reserves/:deployment` (or `api.reserves()` in the SDK) returns supply on every chain, in transit, and coverage against the shares held, for lending protocols, wallets and custodians before they accept the asset. |

**A sandbox:** test keys against a test deployment, to try everything before integrating.

## Quick start

```bash
npm install && forge build
npm run solana:build && npm run solana:build:relay        # the Solana programs (see solana/README.md for the rest)

npx boundless-stock chains                                 # the chains a stock can be mirrored to
npx boundless-stock deploy --mirrors base,arbitrum,svm-chain  # issue on Solana, mirror to those chains, open the home market
npx boundless-stock market                                 # price, supply on every chain, proof of reserves
npx boundless-stock buy --on base --spend 15000            # buy on another chain, filled on Solana
npm run web:dev                                            # issuer dashboard: http://localhost:3000/app
```

Leave out `--mirrors` to mirror to every available chain. `market` and `buy` read the last
deployment; every command also takes `--config <file>`. The step-by-step scripts behind it
(`solana:up`, `chains:up`, `solana:deploy`, `deploy`, `validate`, `supply`) are still there to run
one at a time.

Other setups are a different config, with no code changes:

| Config | Home | Spokes |
|---|---|---|
| `localnet-solana-home.json` | Solana | three EVM chains |
| `localnet-solana-home-svm-mirror.json` | Solana | three EVM chains and a second Solana chain |
| `localnet-solana-home-t22.json` | Solana, **Token-2022 mints** | three EVM chains and a second Solana chain |
| `localnet-solana-home-adapter.json` | Solana, **the issuer's existing SPL mint** | three EVM chains |

Onboard partners and set fees on a running deployment with `npm run partners -- --config …`. The
partner API (`/api/v1`) and the SDK (`@boundless-stock/sdk`) are described in [`PARTNERS.md`](PARTNERS.md).
