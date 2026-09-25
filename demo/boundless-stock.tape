# The terminal demo, recorded with VHS (https://github.com/charmbracelet/vhs):
#
#   vhs demo/boundless-stock.tape  ->  demo/boundless-stock.mp4
#
# Run it from the repo root, on a machine where the one-time build has already run (see
# demo/DEMO.md). Deployment takes about two minutes; speed that part up in editing.

Output demo/boundless-stock.mp4
Output demo/boundless-stock.gif

Set Shell "bash"
Set FontSize 18
Set Width 1500
Set Height 950
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WaitTimeout 400s

# Start clean, off camera: no chains running, a short prompt.
Hide
Type "export PS1='$ ' PATH=$HOME/.local/share/solana/install/active_release/bin:$PATH; npm run -s solana:down; npm run -s chains:down; clear"
Enter
Wait
Show

# 1. Install
Type "npm install"
Sleep 400ms
Enter
Wait
Sleep 1s
Type "npx boundless-stock"
Enter
Wait
Sleep 3s
Type "clear && npx boundless-stock chains"
Enter
Wait
Sleep 3s

# 2. Deploy: issue on Solana, mirror to the chosen chains, open the home market
Type "clear && npx boundless-stock deploy --mirrors base,arbitrum,svm-chain"
Sleep 400ms
Enter
Wait
Sleep 3s

# 3. Market data: price, supply on the home chain and every other chain, proof of reserves
Type "clear && npx boundless-stock market"
Enter
Wait
Sleep 8s

# 4. A buy on a chain with no market, filled on Solana
Type "clear && npx boundless-stock buy --on base --spend 15000"
Enter
Wait
Sleep 5s

# 5. Supply has moved; the total and the backing have not
Type "clear && npx boundless-stock market"
Enter
Wait
Sleep 10s
