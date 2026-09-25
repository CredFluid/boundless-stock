# Demo

About three minutes: the problem in one breath, then the product in a terminal.

## The flow

| # | On screen | Command | What it shows |
|---|---|---|---|
| 0 | Title card | — | The problem (voice-over below) |
| 1 | Terminal | `npm install`, then `npx crossstock` | Installing, and the three commands |
| 2 | Terminal | `npx crossstock deploy` | The stock issued on Solana, mirrors created on every other chain, the home market opened |
| 3 | Terminal | `npx crossstock market` | Price, total supply, how much is on Solana and on each other chain, proof of reserves |
| 4 | Terminal | `npx crossstock buy --on base-sepolia --spend 15000` | A buy on a chain with no market, filled on Solana |
| 5 | Terminal | `npx crossstock market` | Supply has moved between chains; the total and the backing have not |
| 6 | Browser (optional) | `npm run web:dev`, then `/app` | The issuer dashboard |

## Voice-over

**0 · The problem.** "A tokenized stock isn't like other tokens. Its supply is fixed by the real
shares behind it: a million shares, a million tokens, and not one more. As tokenized stocks
spread across chains, every chain carves a thin market out of that same fixed supply. Different
prices, split liquidity, operations everywhere. We built one market instead."

**1 · Install.** "CrossStock is one install and one command."

**2 · Deploy.** "One command deploys a stock. It's issued on Solana, its home. Every other chain
gets a mirror: a real token on that chain, minted only when stock arrives from Solana. And the
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

The terminal part is scripted in [`crossstock.tape`](crossstock.tape) for
[VHS](https://github.com/charmbracelet/vhs), so it can be re-recorded identically:

```bash
# once: the toolchain and builds (not on camera)
npm install && forge build
npm run solana:build && npm run solana:build:relay

# record
vhs demo/crossstock.tape        # -> demo/crossstock.mp4 and .gif
```

- Deployment takes about two minutes on a laptop: speed that section up in editing.
- The tape expects the Solana CLI on `PATH`; edit the first hidden line if yours lives elsewhere.
- Without VHS, run the same commands in a large-font terminal and screen-record it.
- `--config` defaults to `config/localnet-solana-home-svm-mirror.json`: Solana home, three EVM
  chains and a second Solana chain. Proof of reserves reads `token.reserves` from that file.
