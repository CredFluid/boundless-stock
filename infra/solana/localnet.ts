#!/usr/bin/env tsx
/**
 * Local Solana validator with LayerZero's EndpointV2 and test message library loaded onto it.
 *
 * The Solana counterpart to `infra/localnet.ts`. LayerZero's Solana endpoint is a single
 * canonical program, so rather than deploying a stand-in the validator loads the real one at
 * its real id — built from the vendored LayerZero commit by `npm run solana:lz-build`, together
 * with LayerZero's `simple-messagelib`, the Solana counterpart of the EVM `LocalMessageLib`.
 * `--clone-devnet` copies the endpoint from devnet instead, as the original setup did.
 *
 *   npm run solana:lz-build   # once
 *   npm run solana:up
 *   npm run solana:down
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { log } from "../lib/logger.js";
import { LZ_PROGRAMS_DIR } from "./lz-build.js";
import { SIMPLE_MESSAGELIB_PROGRAM_ID } from "./lz-local.js";
import { WHIRLPOOL_PROGRAM_ID } from "./ids.js";

/** LayerZero EndpointV2 on Solana. Same program id on mainnet and devnet. */
export const LZ_ENDPOINT_PROGRAM_ID = "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6";
const WHIRLPOOL_SO = resolve(process.cwd(), "solana/vendor/whirlpool/target/deploy/whirlpool.so");

/** Where the validator state and payer keypair live. Gitignored. */
const STATE_DIR = resolve(process.cwd(), ".localnet-solana");
const STATE_FILE = resolve(STATE_DIR, "validator.json");
const PAYER_FILE = resolve(STATE_DIR, "payer.json");
const LEDGER_DIR = resolve(STATE_DIR, "ledger");

const RPC_PORT = 8899;
export const LOCAL_RPC = `http://127.0.0.1:${RPC_PORT}`;

interface ValidatorState {
  pid: number;
  rpc: string;
  payer: string;
  clonedPrograms: string[];
}

async function waitForRpc(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Solana RPC at ${url} did not come up within ${timeoutMs}ms`);
}

function ensurePayer(): string {
  if (!existsSync(PAYER_FILE)) {
    execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "-s", "-o", PAYER_FILE], {
      stdio: "ignore",
    });
  }
  return execFileSync("solana-keygen", ["pubkey", PAYER_FILE], { encoding: "utf8" }).trim();
}

async function up(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) {
    log.warn("A local Solana validator is already recorded as running. Run `npm run solana:down` first.");
    process.exit(1);
  }

  log.banner("Starting local Solana validator");
  const payer = ensurePayer();
  const logFile = resolve(STATE_DIR, "validator.log");
  const fd = openSync(logFile, "a");

  // Two ways to get LayerZero's programs onto the validator:
  //
  //   from source (default) — load the endpoint AND simple-messagelib, built by
  //     `npm run solana:lz-build` from the vendored commit, at their canonical ids. No network
  //     needed, and the message library is what lets the local relayer verify packets.
  //   --clone-devnet — copy the endpoint from devnet (the original M16 approach). No message
  //     library comes with it, so nothing can be verified locally; kept for inspecting devnet's
  //     exact build.
  //
  // --clone-upgradeable-program pulls the bytecode AND its programdata account; plain --clone
  // gives an account the loader cannot execute.
  const cloneDevnet = process.argv.includes("--clone-devnet");
  const programArgs: string[] = [];
  if (cloneDevnet) {
    programArgs.push("--url", "https://api.devnet.solana.com", "--clone-upgradeable-program", LZ_ENDPOINT_PROGRAM_ID);
  } else {
    for (const [id, so] of [
      [LZ_ENDPOINT_PROGRAM_ID, "endpoint.so"],
      [SIMPLE_MESSAGELIB_PROGRAM_ID, "simple_messagelib.so"],
    ]) {
      const path = resolve(LZ_PROGRAMS_DIR, so);
      if (!existsSync(path)) {
        throw new Error(`${path} is missing. Build LayerZero's programs first: npm run solana:lz-build`);
      }
      programArgs.push("--upgradeable-program", id, path, payer);
    }
    // Orca Whirlpools, the home-chain venue when Solana is the home chain. Optional: a
    // Solana MIRROR needs no pool at all. Built by `npm run solana:build:orca`.
    if (existsSync(WHIRLPOOL_SO)) {
      programArgs.push("--upgradeable-program", WHIRLPOOL_PROGRAM_ID, WHIRLPOOL_SO, payer);
    }
  }

  const child = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", LEDGER_DIR, "--rpc-port", String(RPC_PORT), ...programArgs],
    { detached: true, stdio: ["ignore", fd, fd] }
  );
  child.unref();

  await waitForRpc(LOCAL_RPC);

  // Confirm the endpoint is actually executable here, not just present.
  const shown = execFileSync(
    "solana",
    ["program", "show", LZ_ENDPOINT_PROGRAM_ID, "--url", LOCAL_RPC, "--keypair", PAYER_FILE],
    { encoding: "utf8" }
  );
  if (!shown.includes("BPFLoaderUpgradeab1e")) {
    throw new Error("LayerZero endpoint did not clone as an executable upgradeable program.");
  }

  execFileSync("solana", ["airdrop", "100", payer, "--url", LOCAL_RPC, "--keypair", PAYER_FILE], {
    stdio: "ignore",
  });

  const state: ValidatorState = {
    pid: child.pid!,
    rpc: LOCAL_RPC,
    payer,
    clonedPrograms: cloneDevnet ? [LZ_ENDPOINT_PROGRAM_ID] : [LZ_ENDPOINT_PROGRAM_ID, SIMPLE_MESSAGELIB_PROGRAM_ID],
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  log.ok(`validator running on ${LOCAL_RPC} (pid ${child.pid})`);
  log.kv("payer", payer);
  log.kv(
    "LayerZero EndpointV2",
    `${LZ_ENDPOINT_PROGRAM_ID} (${cloneDevnet ? "cloned from devnet" : "built from source"}, executable)`
  );
  if (!cloneDevnet) log.kv("simple-messagelib", `${SIMPLE_MESSAGELIB_PROGRAM_ID} (built from source)`);
  if (!cloneDevnet && existsSync(WHIRLPOOL_SO)) log.kv("Orca Whirlpools", `${WHIRLPOOL_PROGRAM_ID} (built from source)`);
  log.info(`\nState: ${STATE_FILE}`);
}

function down(): void {
  if (!existsSync(STATE_FILE)) {
    log.warn("No local Solana validator recorded as running.");
    return;
  }
  const state: ValidatorState = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  try {
    process.kill(state.pid, "SIGTERM");
    log.ok(`stopped validator (pid ${state.pid})`);
  } catch {
    log.dim(`validator (pid ${state.pid}) was not running`);
  }
  try {
    unlinkSync(STATE_FILE);
  } catch {
    /* already gone */
  }
}

const cmd = process.argv[2];
if (cmd === "up") {
  up().catch((e) => {
    log.fail(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
} else if (cmd === "down") {
  down();
} else {
  console.log("usage: tsx infra/solana/localnet.ts <up|down>");
  process.exit(1);
}
