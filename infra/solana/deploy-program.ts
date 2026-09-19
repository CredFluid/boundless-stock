#!/usr/bin/env tsx
/**
 * Deploys the CrossStock Solana programs to a configured SVM chain.
 *
 * The SVM counterpart to the EVM pipeline's contract-deployment modules. Kept as its own entry
 * point for now because the full pipeline cannot yet drive a Solana chain end to end — the OFT
 * still has to be deployed and initialised, and peer wiring needs LayerZero's SDK. Running it
 * separately makes the part that *does* work usable and verifiable today.
 *
 *   npm run solana:deploy -- --config config/localnet-solana.json --chain solana-devnet
 */
import { resolve } from "node:path";
import { loadConfig, allChains, vmOf } from "../lib/config.js";
import { SolanaChain } from "./chain.js";
import { log } from "../lib/logger.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

const SWAP_REQUEST_SO = "solana/target/deploy/swap_request.so";
const SWAP_REQUEST_KEYPAIR = "solana/keys/swap_request-keypair.json";

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet-solana.json"));
  const chainKey = arg("chain", "");

  const svmChains = allChains(cfg).filter(
    (c) => vmOf(c) === "svm" && (chainKey === "" || c.key === chainKey)
  );
  if (svmChains.length === 0) {
    throw new Error(
      chainKey
        ? `No Solana chain "${chainKey}" in ${cfg.name}.`
        : `${cfg.name} has no Solana chains configured.`
    );
  }

  for (const chainConfig of svmChains) {
    const chain = new SolanaChain(chainConfig);

    log.banner(`Solana deployment — ${chain.name} (eid ${chain.eid})`);
    log.kv("rpc", chainConfig.rpcUrl);
    log.kv("payer", chain.deployer);

    await chain.preflight();
    log.ok("cluster reachable, LayerZero EndpointV2 present and executable");

    const balance = await chain.balance();
    log.kv("payer balance", `${Number(balance) / 1e9} SOL`);
    if (balance < 2_000_000_000n) {
      log.dim("topping the payer up");
      await chain.airdrop(100);
    }

    log.step("swap_request program");
    const programId = await chain.deployProgram(SWAP_REQUEST_SO, SWAP_REQUEST_KEYPAIR);
    log.ok(`deployed and executable: ${programId}`);

    const info = await chain.accountInfo(programId);
    log.kv("owner", info!.owner.toBase58());
    log.kv("executable", String(info!.executable));

    log.banner("Solana programs deployed");
    log.info("Still required before a trade can round-trip through this chain:");
    log.info("  - deploy and initialise LayerZero's OFT program for each asset");
    log.info("  - init_store + set_home_relay on swap_request");
    log.info("  - peer wiring, and relayer support for the SVM delivery path");
    log.info("See agents.md section 12.");
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  log.fail(msg);
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});

export { SWAP_REQUEST_SO, SWAP_REQUEST_KEYPAIR, resolve };
