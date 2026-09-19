#!/usr/bin/env tsx
/**
 * Initialises the `swap_request` store on a Solana chain.
 *
 * This is the instruction that registers the program's store PDA with LayerZero as an OApp —
 * the moment the program becomes something the endpoint will deliver to. It exercises the
 * whole stack in one call: Anchor instruction dispatch, PDA derivation, account creation, and
 * a CPI into the genuine EndpointV2.
 *
 *   npm run solana:init -- --config config/localnet-solana.json --chain solana-devnet
 */
import { execFileSync } from "node:child_process";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { loadConfig, allChains, vmOf } from "../lib/config.js";
import { SolanaChain } from "./chain.js";
import { log } from "../lib/logger.js";

/** Anchor discriminators: first eight bytes of sha256("global:<name>"). */
const DISCRIMINATORS = {
  init_store: Buffer.from([250, 74, 6, 95, 163, 188, 19, 181]),
  set_home_relay: Buffer.from([236, 206, 33, 70, 35, 57, 110, 13]),
} as const;

/** Seeds, mirroring the constants in the program and in LayerZero's endpoint. */
const STORE_SEED = Buffer.from("Store");
const LZ_COMPOSE_TYPES_SEED = Buffer.from("LzComposeTypes");
const OAPP_SEED = Buffer.from("OApp");
const EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${name}`);
}

/** Creates an SPL mint via the CLI and returns its address. */
function createMint(rpcUrl: string, keypairPath: string, decimals: number): string {
  const out = execFileSync(
    "spl-token",
    ["create-token", "--decimals", String(decimals), "--url", rpcUrl, "--fee-payer", keypairPath, "--owner", keypairPath],
    { encoding: "utf8" }
  );
  const match = out.match(/Address:\s+([1-9A-HJ-NP-Za-km-z]{32,44})/);
  if (!match) throw new Error(`Could not parse a mint address from spl-token output:\n${out}`);
  return match[1];
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet-solana.json"));
  const chainKey = arg("chain", "");

  const chainConfig = allChains(cfg).find(
    (c) => vmOf(c) === "svm" && (chainKey === "" || c.key === chainKey)
  );
  if (!chainConfig) throw new Error(`No Solana chain${chainKey ? ` "${chainKey}"` : ""} in ${cfg.name}.`);

  const chain = new SolanaChain(chainConfig);
  await chain.preflight();

  const programId = new PublicKey(
    execFileSync("solana-keygen", ["pubkey", "solana/keys/swap_request-keypair.json"], {
      encoding: "utf8",
    }).trim()
  );
  if (!(await chain.isProgramDeployed(programId.toBase58()))) {
    throw new Error(`swap_request is not deployed on ${chain.name}. Run \`npm run solana:deploy\` first.`);
  }

  log.banner(`Initialising swap_request store — ${chain.name}`);
  log.kv("program", programId.toBase58());
  log.kv("endpoint", chain.endpointProgramId.toBase58());

  // The two assets. Real SPL mints, so the store records something meaningful rather than
  // placeholder keys.
  log.step("SPL mints");
  const keypairPath = chainConfig.svm!.keypairPath!;
  const baseMint = new PublicKey(createMint(chainConfig.rpcUrl, keypairPath, cfg.token.decimals));
  const quoteMint = new PublicKey(createMint(chainConfig.rpcUrl, keypairPath, cfg.quoteAsset.decimals));
  log.kv(`${cfg.token.symbol} mint`, baseMint.toBase58());
  log.kv(`${cfg.quoteAsset.symbol} mint`, quoteMint.toBase58());

  // ------------------------------------------------------------------ PDAs

  const [store] = PublicKey.findProgramAddressSync([STORE_SEED], programId);
  const [lzComposeTypes] = PublicKey.findProgramAddressSync(
    [LZ_COMPOSE_TYPES_SEED, store.toBuffer()],
    programId
  );
  const [oappRegistry] = PublicKey.findProgramAddressSync(
    [OAPP_SEED, store.toBuffer()],
    chain.endpointProgramId
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [EVENT_AUTHORITY_SEED],
    chain.endpointProgramId
  );

  log.step("derived accounts");
  log.kv("store PDA", store.toBase58());
  log.kv("lzComposeTypes PDA", lzComposeTypes.toBase58());
  log.kv("OApp registry PDA", oappRegistry.toBase58());

  if (await chain.accountInfo(store.toBase58())) {
    log.ok("store already initialised; nothing to do");
    return;
  }

  // ------------------------------------------------------------------ instruction data

  // InitStoreParams: home_eid u32 ‖ base_oft ‖ quote_oft ‖ endpoint_program ‖ delegate
  const homeEid = cfg.homeChain.eid;
  const eidBuf = Buffer.alloc(4);
  eidBuf.writeUInt32LE(homeEid);

  // The OFTs are not deployed yet, so they are recorded as the program id for now and updated
  // once LayerZero's OFT program is initialised for each asset. The store's own identity and
  // its OApp registration — what this instruction exists to establish — do not depend on them.
  const data = Buffer.concat([
    DISCRIMINATORS.init_store,
    eidBuf,
    programId.toBuffer(), // base_oft placeholder
    programId.toBuffer(), // quote_oft placeholder
    chain.endpointProgramId.toBuffer(),
    chain.payer.publicKey.toBuffer(), // delegate
  ]);

  // Accounts for InitStore, then the register_oapp CPI's own list. The CPI helper expects the
  // target program at index 0 of that second group, followed by the endpoint's RegisterOApp
  // accounts in declaration order, with the two #[event_cpi] accounts last.
  const keys = [
    { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true }, // admin
    { pubkey: store, isSigner: false, isWritable: true },
    { pubkey: lzComposeTypes, isSigner: false, isWritable: true },
    { pubkey: baseMint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },

    // --- remaining_accounts: endpoint register_oapp
    { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
    { pubkey: chain.payer.publicKey, isSigner: true, isWritable: true }, // payer
    { pubkey: store, isSigner: false, isWritable: false }, // oapp (signs via PDA seeds)
    { pubkey: oappRegistry, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: chain.endpointProgramId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({ programId, keys, data });

  log.step("sending init_store");
  const tx = new Transaction().add(ix);
  const sig = await chain.connection.sendTransaction(tx, [chain.payer], {
    skipPreflight: false,
  });
  await chain.connection.confirmTransaction(sig, chain.commitment);
  log.ok(`init_store confirmed: ${sig}`);

  // ------------------------------------------------------------------ verify

  const storeInfo = await chain.accountInfo(store.toBase58());
  const registryInfo = await chain.accountInfo(oappRegistry.toBase58());

  log.step("verification");
  log.kv("store account", storeInfo ? `${storeInfo.data.length} bytes` : "MISSING");
  log.kv("store owner", storeInfo?.owner.toBase58() ?? "-");
  log.kv("OApp registry", registryInfo ? `${registryInfo.data.length} bytes` : "MISSING");
  log.kv("registry owner", registryInfo?.owner.toBase58() ?? "-");

  if (!storeInfo) throw new Error("store PDA was not created");
  if (!registryInfo) throw new Error("the endpoint did not register this OApp");
  if (!registryInfo.owner.equals(chain.endpointProgramId)) {
    throw new Error("OApp registry is not owned by the LayerZero endpoint");
  }

  log.ok("the program is registered with LayerZero as an OApp");
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
