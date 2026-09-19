#!/usr/bin/env tsx
/**
 * Deploys a plain ERC-20 to stand in for a token an issuer already has.
 *
 * Only used to demonstrate the adapter path: it produces a token that CrossStock did not
 * create and that knows nothing about LayerZero, which the pipeline then adapts rather than
 * replaces.
 *
 *   npm run deploy:legacy -- --config config/localnet.json --symbol tAAPL --supply 1000000
 */
import { parseUnits, formatUnits } from "viem";
import { loadConfig } from "./lib/config.js";
import { Chain } from "./lib/chains.js";
import { forgeArtifact } from "./lib/artifacts.js";
import { log } from "./lib/logger.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet.json"));
  const chain = new Chain(cfg.homeChain);
  await chain.preflight();

  const name = arg("name", cfg.token.name);
  const symbol = arg("symbol", cfg.token.symbol);
  const decimals = Number(arg("decimals", String(cfg.token.decimals)));
  const supply = arg("supply", cfg.token.initialSupply);

  log.banner(`Deploying a pre-existing ERC-20 on ${chain.name}`);
  log.dim("stands in for a token the issuer already had; CrossStock will adapt it, not replace it");

  const artifact = forgeArtifact("LegacyERC20");
  const address = await chain.deploy(artifact, [
    name,
    symbol,
    decimals,
    chain.deployer,
    parseUnits(supply, decimals),
  ]);

  const onChainSupply = await chain.read<bigint>(address, artifact.abi, "totalSupply");
  const onChainSymbol = await chain.read<string>(address, artifact.abi, "symbol");

  log.ok(`${onChainSymbol} deployed at ${address}`);
  log.kv("total supply", `${formatUnits(onChainSupply, decimals)} ${onChainSymbol}`);
  log.kv("holder", chain.deployer);
  log.info("\nNow point the deployment config at it:");
  log.info(`  EXISTING_STOCK_ADDRESS=${address} npm run deploy -- --config config/localnet-adapter.json`);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
