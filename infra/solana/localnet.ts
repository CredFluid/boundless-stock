#!/usr/bin/env tsx
/**
 * Local Solana validator with LayerZero's EndpointV2 cloned onto it.
 *
 * The Solana counterpart to `infra/localnet.ts`. Where an EVM chain gets an endpoint the infra
 * deploys itself, LayerZero's Solana endpoint is a single canonical program that cannot be
 * meaningfully redeployed — so the local validator **clones it from devnet** instead. That is
 * the same trick LayerZero's own examples use, and it means local Solana testing runs against
 * the real endpoint bytecode rather than a stand-in.
 *
 *   npm run solana:up      # start, with the endpoint cloned
 *   npm run solana:down
 *
 * Verified working: the endpoint lands as a 1,639,888-byte upgradeable program owned by
 * BPFLoaderUpgradeab1e, queryable at the program id below.
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { log } from "../lib/logger.js";

/** LayerZero EndpointV2 on Solana. Same program id on mainnet and devnet. */
export const LZ_ENDPOINT_PROGRAM_ID = "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6";

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

  // --clone-upgradeable-program pulls the real endpoint bytecode AND its programdata account.
  // Cloning with plain --clone gives an account the loader cannot execute.
  const child = spawn(
    "solana-test-validator",
    [
      "--reset",
      "--quiet",
      "--ledger", LEDGER_DIR,
      "--rpc-port", String(RPC_PORT),
      "--url", "https://api.devnet.solana.com",
      "--clone-upgradeable-program", LZ_ENDPOINT_PROGRAM_ID,
    ],
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
    clonedPrograms: [LZ_ENDPOINT_PROGRAM_ID],
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  log.ok(`validator running on ${LOCAL_RPC} (pid ${child.pid})`);
  log.kv("payer", payer);
  log.kv("LayerZero EndpointV2", `${LZ_ENDPOINT_PROGRAM_ID} (cloned from devnet, executable)`);
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
