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

/**
 * The programs a Solana mirror chain needs.
 *
 * `oft` is LayerZero's, vendored under `solana/vendor/oft-solana` and built from source rather
 * than shipped as a binary so it stays auditable. Its program id comes from the `OFT_ID`
 * environment variable at build time — LayerZero's design, so every project deploys its own
 * OFT instance rather than sharing one.
 */
const PROGRAMS = [
  {
    label: "oft (LayerZero)",
    so: "solana/vendor/oft-solana/target/deploy/oft.so",
    keypair: "solana/keys/oft-keypair.json",
    manifestKey: "OftProgram",
  },
  {
    label: "swap_request (CrossStock)",
    so: "solana/target/deploy/swap_request.so",
    keypair: "solana/keys/swap_request-keypair.json",
    manifestKey: "SwapRequestProgram",
  },
] as const;

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

    const deployed: Record<string, string> = {};
    for (const program of PROGRAMS) {
      log.step(program.label);
      const programId = await chain.deployProgram(program.so, program.keypair);
      const info = await chain.accountInfo(programId);
      log.ok(`deployed and executable: ${programId}`);
      log.kv("owner", info!.owner.toBase58());
      deployed[program.manifestKey] = programId;
    }

    log.banner("Solana programs deployed");
    for (const [key, id] of Object.entries(deployed)) log.kv(key, id);
    log.info("\nStill required before a trade can round-trip through this chain:");
    log.info("  - init_oft for each asset, and init_store on swap_request");
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

export { PROGRAMS, resolve };
