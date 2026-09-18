import { parseUnits, formatUnits, type Address } from "viem";
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { setContract, recordStep } from "../lib/manifest.js";
import { endpointOf } from "./00-endpoints.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 1 — home-chain token deployment.
 *
 * Deploys the omnichain asset (TokenizedStock, a LayerZero OFT) with the full initial supply,
 * and the pairing asset (USDC) as a plain ERC-20 that exists nowhere else.
 *
 * Token name, symbol, decimals and supply all come from config. Nothing here knows or cares
 * which chain it is running against.
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
  const token = await chains
    .get(home.key)!
    .deploy(tokenArtifact, [cfg.token.name, cfg.token.symbol, endpoint, home.deployer, supply]);
  log.kv(`${cfg.token.symbol} (OFT)`, token);
  log.kv("initial supply", `${cfg.token.initialSupply} ${cfg.token.symbol}`);

  const quoteArtifact = forgeArtifact("USDCMock");
  const quote = await home.deploy(quoteArtifact, [
    cfg.quoteAsset.name,
    cfg.quoteAsset.symbol,
    cfg.quoteAsset.decimals,
    home.deployer,
    quoteSupply,
  ]);
  log.kv(`${cfg.quoteAsset.symbol} (ERC-20)`, quote);
  log.kv("initial supply", `${cfg.quoteAsset.initialSupply} ${cfg.quoteAsset.symbol}`);

  // Read back on-chain rather than trusting the constructor arguments we just passed.
  const onChainSupply = await home.read<bigint>(token, tokenArtifact.abi, "totalSupply");
  const onChainSymbol = await home.read<string>(token, tokenArtifact.abi, "symbol");
  const sharedDecimals = await home.read<number>(token, tokenArtifact.abi, "sharedDecimals");

  if (onChainSupply !== supply) {
    throw new Error(`Supply mismatch on ${home.name}: expected ${supply}, chain reports ${onChainSupply}.`);
  }
  log.groupEnd();

  log.ok(`${onChainSymbol} verified on-chain: ${formatUnits(onChainSupply, cfg.token.decimals)} total supply`);
  log.dim(`OFT sharedDecimals = ${sharedDecimals} (amounts are quantised to this when bridging)`);

  setContract(manifest, home.key, "TokenizedStock", token);
  setContract(manifest, home.key, "QuoteAsset", quote);
  recordStep(manifest, "01-token", "ok", `${cfg.token.symbol} + ${cfg.quoteAsset.symbol} on ${home.key}`);

  return { token, quote };
}
