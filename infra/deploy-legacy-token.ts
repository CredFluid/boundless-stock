#!/usr/bin/env tsx
/**
 * Deploys a plain ERC-20 to stand in for a token an issuer already has.
 *
 * Only used to demonstrate the adapter path: it produces a token that CrossStock did not
 * create and that knows nothing about LayerZero, which the pipeline then adapts rather than
 * replaces.
 *
 *   npm run deploy:legacy -- --config config/localnet.json --symbol tAAPL --supply 1000000
 *
 * On a Solana home chain it creates a plain SPL mint instead, holding the supply in the
 * deployer's wallet and keeping mint authority there — an issuer's token, not CrossStock's:
 *
 *   npm run deploy:legacy -- --config config/localnet-solana-home.json
 */
import { execFileSync } from "node:child_process";
import { parseUnits, formatUnits } from "viem";
import { loadConfig } from "./lib/config.js";
import { Chain } from "./lib/chains.js";
import { forgeArtifact } from "./lib/artifacts.js";
import { log } from "./lib/logger.js";
import { localDecimals } from "./lib/decimals.js";
import { SolanaChain } from "./solana/chain.js";
import { createMint } from "./solana/setup.js";
import type { DeploymentConfig } from "./lib/types.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet.json"));
  if ((cfg.homeChain.vm ?? "evm") === "svm") return legacyMint(cfg);
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

async function legacyMint(cfg: DeploymentConfig): Promise<void> {
  const chain = new SolanaChain(cfg.homeChain);
  await chain.preflight();
  const symbol = arg("symbol", cfg.token.symbol);
  const decimals = Number(arg("decimals", String(localDecimals(cfg, cfg.homeChain, "base"))));
  const supply = arg("supply", cfg.token.initialSupply);
  const keypair = cfg.homeChain.svm!.keypairPath!;

  log.banner(`Creating a pre-existing SPL mint on ${chain.name}`);
  log.dim("stands in for a token the issuer already had; CrossStock will adapt it, not replace it");

  const mint = createMint(cfg.homeChain.rpcUrl, keypair, decimals);
  const url = ["--url", cfg.homeChain.rpcUrl, "--fee-payer", keypair, "--owner", keypair];
  execFileSync("spl-token", ["create-account", mint.toBase58(), ...url], { stdio: "pipe" });
  execFileSync("spl-token", ["mint", mint.toBase58(), supply, ...url], { stdio: "pipe" });

  log.ok(`${symbol} mint created at ${mint.toBase58()} (${decimals} decimals)`);
  log.kv("total supply", `${supply} ${symbol}`);
  log.kv("holder and mint authority", chain.deployer);
  log.info("\nNow point the deployment config at it:");
  log.info(`  EXISTING_STOCK_ADDRESS=${mint.toBase58()} npm run deploy -- --config config/localnet-solana-home-adapter.json`);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
