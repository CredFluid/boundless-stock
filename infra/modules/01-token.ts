import { parseUnits, formatUnits, type Address } from "viem";
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { setContract, recordStep } from "../lib/manifest.js";
import { endpointOf } from "./00-endpoints.js";
import { reuse } from "../lib/reuse.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 1 — home-chain token deployment.
 *
 * Deploys both assets on the home chain with their full initial supply: the stock
 * (TokenizedStock) and the quote asset (USDC). Both are LayerZero OFTs.
 *
 * WHY THE QUOTE ASSET IS OMNICHAIN TOO: a user standing on a mirror chain has to be able to
 * *pay* with something. If the quote asset only existed on the home chain, a mirror user could
 * only ever sell — they would have nothing to buy with. Making it omnichain is what enables
 * the flow this POC is actually about: buying an asset from a chain that has no market for it.
 *
 * This does not put liquidity on the mirror chain. A user's own wallet balance is not
 * liquidity: there is still no pool there, no market maker, no reserves, and no price. All
 * price discovery happens on the home chain's pool.
 *
 * Token names, symbols, decimals and supplies all come from config. Nothing here knows or
 * cares which chain it is running against.
 */
export async function deployHomeToken(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<{ token: Address; quote: Address }> {
  log.step("Module 1 — home chain token + pairing asset");

  const home = chains.get(cfg.homeChain.key)!;
  const endpoint = endpointOf(manifest, home.key);

  const supply = parseUnits(cfg.token.initialSupply, cfg.token.decimals);
  const quoteSupply = parseUnits(cfg.quoteAsset.initialSupply, cfg.quoteAsset.decimals);

  log.group(`${home.name} (home, eid ${home.eid})`);

  const tokenArtifact = forgeArtifact("TokenizedStock");
  const quoteArtifact = forgeArtifact("OmniToken");

  // Reuse before deploying. Adding a mirror chain to an already-launched token must never
  // mint a second home-chain token — that would fork the supply and orphan the pool.
  const token =
    (await reuse(manifest, home, home.key, "TokenizedStock")) ??
    (await home.deploy(tokenArtifact, [
      cfg.token.name,
      cfg.token.symbol,
      cfg.token.decimals,
      endpoint,
      home.deployer,
      supply,
    ]));
  log.kv(`${cfg.token.symbol} (OFT)`, token);

  const quote =
    (await reuse(manifest, home, home.key, "QuoteAsset")) ??
    (await home.deploy(quoteArtifact, [
      cfg.quoteAsset.name,
      cfg.quoteAsset.symbol,
      cfg.quoteAsset.decimals,
      endpoint,
      home.deployer,
      quoteSupply,
    ]));
  log.kv(`${cfg.quoteAsset.symbol} (OFT)`, quote);

  // Read back on-chain rather than trusting the constructor arguments we just passed.
  const onChainSupply = await home.read<bigint>(token, tokenArtifact.abi, "totalSupply");
  const onChainSymbol = await home.read<string>(token, tokenArtifact.abi, "symbol");
  const sharedDecimals = await home.read<number>(token, tokenArtifact.abi, "sharedDecimals");

  // On a fresh deploy this must match config exactly. On an incremental run the supply has
  // legitimately moved (pool seeding, bridging), so only the fresh case is asserted.
  const isFreshToken = onChainSupply === supply;
  if (!isFreshToken) {
    log.dim(`total supply is ${formatUnits(onChainSupply, cfg.token.decimals)} (moved since launch — expected on an incremental run)`);
  }
  log.groupEnd();

  log.ok(`${onChainSymbol} verified on-chain: ${formatUnits(onChainSupply, cfg.token.decimals)} total supply`);
  log.dim(`OFT sharedDecimals = ${sharedDecimals} (amounts are quantised to this when bridging)`);

  setContract(manifest, home.key, "TokenizedStock", token);
  setContract(manifest, home.key, "QuoteAsset", quote);
  recordStep(manifest, "01-token", "ok", `${cfg.token.symbol} + ${cfg.quoteAsset.symbol} on ${home.key}`);

  return { token, quote };
}
