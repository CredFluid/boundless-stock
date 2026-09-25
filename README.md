# CrossStock

**One market for every tokenized stock, on Solana, reachable from every chain. Liquidity and
operations are managed from one chain and one place.**

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

CrossStock makes Solana the **hub**. The stock is issued on Solana and lives there, and its
market lives there too: one pool of liquidity and one price, holding the backed supply in one
place instead of splitting it.

Every other chain is a **spoke**. Each spoke gets a **mirror** of the stock: a real, valid token
native to that chain, which can be held, transferred and used like any other token there.
A mirror is never a separate issue. It is minted on a spoke only when stock arrives from
Solana, and burned when it leaves, so every mirror token is one of the original backed tokens,
just located on another chain. The spoke needs no pool of its own: its orders are sent to the
market on Solana.

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
| **An issuer dashboard** | Supply per chain with the conservation check, the live market, trade history and operations queues. |
| **Solana as the home chain** | The market, the liquidity and the operations live on Solana. Other chains, EVM chains and other Solana chains alike, connect to it as spokes. |

## For developers

Issuers bring the stock. Developers bring the users. Any wallet, exchange, neobank or trading
app on another chain can offer buy and sell for a tokenized stock without running a pool, a
bridge or its own liquidity. The developer handles its users and their KYC; the market is ours.

The SDK (`@crossstock/sdk`) and API (`/api/v1`) do this in a few calls today:

| Call | What it gives the developer |
|---|---|
| `deployments()` / `deployment(name)` | Which stocks are available, on which chains, with every address needed to trade them |
| `quote()` | An exact price for a given size, from the home market itself. Orders fill at their quote to the base unit; price impact and the cross-chain messaging fee are included. |
| `buildOrder()` | A ready-to-sign transaction, on an EVM chain or Solana, signed in the user's own wallet. The developer never holds user funds. |
| Authorise helpers | Approve an order as the partner: a typed-data signature on EVM, a checked co-signature on Solana that refuses anything but the approved amount, side, fee and floor |
| `order()` / `orders()` / `waitForOrder()` | Track an order until it is filled, refunded or cancelled |
| Webhooks | Signed notifications when an order settles, with a helper to verify them |
| Partner fee | The developer sets its own fee, up to a cap, charged only on a fill: a business model built in |

The trading API is for developers who bring users, and it needs a partner agreement because of
KYC. The data behind it can be open to everyone else (see below).

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

**For issuers:**

- **Proof of reserves.** The issued half (supply across every chain, in flight included) is
  already measured live. Pairing it with a reserve source (custodian, issuer or oracle) gives a
  continuous "issued ≤ held" check. See [`PROOF_OF_RESERVES.md`](PROOF_OF_RESERVES.md).
- **Holders across chains,** alongside supply, in the issuer dashboard.

**For developers**, opening what only the home market can see:

- **Market data on every chain.** The stock's price in the home market, and its premium or
  discount to the real share, for portfolio apps, dashboards and trading tools on any chain.
- **Supply and holder data.** Supply per chain, stock in flight between chains, and holder
  counts, for explorers, analytics platforms and investor relations.
- **Proof of reserves as an API and an on-chain check.** "Is this token fully backed right
  now?", asked by a lending protocol or custodian before accepting it as collateral.
- **A price feed on every chain.** An on-chain price, checked against a reference price of the
  underlying share, that lending and perpetuals protocols on other chains can read. This is what
  turns a mirror token into collateral, not just something to hold.
- **Contract-level buying.** Orders placed by smart contracts, not only wallets, so a vault, a
  savings app or an index product on another chain can buy and hold tokenized stocks
  automatically. Who carries KYC when the buyer is a contract is the question to settle first.
- **An embeddable buy widget,** for apps that want the flow without building it.
- **A sandbox:** test keys against a test deployment, to try it before integrating.

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
