# Demo

About three minutes: the problem in one breath, then the product in a terminal.

## The flow

| # | On screen | Command | What it shows |
|---|---|---|---|
| 0 | Title card | — | The problem (voice-over below) |
| 1 | Terminal | `npm install`, `npx boundless-stock`, `npx boundless-stock chains` | Installing, the commands, and the chains a stock can be mirrored to |
| 2 | Terminal | `npx boundless-stock deploy --mirrors base,arbitrum,svm-chain` | The stock issued on Solana, mirrors created on the chosen chains, the home market opened |
| 3 | Terminal | `npx boundless-stock market` | Price, total supply, how much is on Solana and on each other chain, proof of reserves |
| 4 | Terminal | `npx boundless-stock buy --on base --spend 15000` | A buy on a chain with no market, filled on Solana |
| 5 | Terminal | `npx boundless-stock market` | Supply has moved between chains; the total and the backing have not |
| 6 | Browser (optional) | `npm run web:dev`, then `/app` | The issuer dashboard |

## Voice-over

**0 · The problem.** "A tokenized stock isn't like other tokens. Its supply is fixed by the real
shares behind it: a million shares, a million tokens, and not one more. As tokenized stocks
spread across chains, every chain carves a thin market out of that same fixed supply. Different
prices, split liquidity, operations everywhere. We built one market instead."

**1 · Install.** "Boundless Stock is one install and one command. Solana is home; these are the
chains a stock can be mirrored to."

**2 · Deploy.** "One command deploys a stock, to whichever chains the issuer picks. It's issued on
Solana, its home. Each chosen chain gets a mirror: a real token on that chain, minted only when stock arrives from Solana. And the
home market opens on Solana, with one pool of liquidity for every chain."

**3 · Market data.** "From one place, the issuer sees everything. The price, from the home market.
The total supply, where it sits: all of it on Solana, for now. And proof of reserves: a million
shares held, a million tokens issued, fully backed."

**4 · Buy.** "Now someone buys on another chain, an EVM chain with no market of its own. The order
crosses to Solana, fills in the home market at the real price, and the stock arrives back in
their wallet on their own chain, in about a second. The liquidity on Solana powered a trade on
another chain."

**5 · Market again.** "The stock has moved: some of it now lives on that other chain. The total
hasn't changed, and it's still fully backed. Supply is conserved across every chain, and it's
checked, not assumed. One market, on Solana, reachable from every chain."

## Recording it

The terminal part is scripted in [`boundless-stock.tape`](boundless-stock.tape) for
[VHS](https://github.com/charmbracelet/vhs), so it can be re-recorded identically:

```bash
# once: the toolchain and builds (not on camera)
npm install && forge build
npm run solana:build && npm run solana:build:relay

# record
vhs demo/boundless-stock.tape   # -> demo/boundless-stock.mp4 and .gif
```

- Deployment takes about two minutes on a laptop: speed that section up in editing.
- The tape expects the Solana CLI on `PATH`; edit the first hidden line if yours lives elsewhere.
- Without VHS, run the same commands in a large-font terminal and screen-record it.
- `--mirrors` picks from the chains `boundless-stock chains` lists; leave it out for all of them.
  `market` and `buy` read the last deployment. Proof of reserves reads `token.reserves` from
  `config/localnet-solana-home-svm-mirror.json`.
