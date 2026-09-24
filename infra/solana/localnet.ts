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
 *   npm run solana:up                                   # one validator on :8899
 *   npm run solana:up -- --config config/<name>.json    # one per Solana chain in the config
 *   npm run solana:down
 *
 * With a config, every Solana chain whose rpcUrl is local gets its own validator on that port,
 * with its own ledger, faucet and gossip ports: separate clusters, as two SVM chains are. They
 * share one payer keypair, funded on each.
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { log } from "../lib/logger.js";
import { loadConfig, allChains, vmOf } from "../lib/config.js";
import { LZ_PROGRAMS_DIR } from "./lz-build.js";
import { SIMPLE_MESSAGELIB_PROGRAM_ID } from "./lz-local.js";
import { WHIRLPOOL_PROGRAM_ID } from "./ids.js";
import { repoRoot } from "../lib/root.js";

/** LayerZero EndpointV2 on Solana. Same program id on mainnet and devnet. */
export const LZ_ENDPOINT_PROGRAM_ID = "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6";
const WHIRLPOOL_SO = resolve(repoRoot(), "solana/vendor/whirlpool/target/deploy/whirlpool.so");

/** Where the validator state and payer keypair live. Gitignored. */
const STATE_DIR = resolve(repoRoot(), ".localnet-solana");
const STATE_FILE = resolve(STATE_DIR, "validators.json");
const PAYER_FILE = resolve(STATE_DIR, "payer.json");

const RPC_PORT = 8899;
export const LOCAL_RPC = `http://127.0.0.1:${RPC_PORT}`;

interface ValidatorState {
  key: string;
  pid: number;
  rpc: string;
  payer: string;
  clonedPrograms: string[];
}

/** A validator to start: which chain, and on which port. */
interface Target {
  key: string;
  name: string;
  port: number;
}

/** Local Solana chains named by the config, or the single default validator. */
function targets(): Target[] {
  const i = process.argv.indexOf("--config");
  if (i < 0 || !process.argv[i + 1]) return [{ key: "default", name: "Solana (local)", port: RPC_PORT }];
  const cfg = loadConfig(process.argv[i + 1]);
  const out: Target[] = [];
  for (const c of allChains(cfg).filter((c) => vmOf(c) === "svm")) {
    const url = new URL(c.rpcUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") continue;
    out.push({ key: c.key, name: c.name, port: Number(url.port || RPC_PORT) });
  }
  if (out.length === 0) throw new Error("The config names no local Solana chain.");
  return out;
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
  if (existsSync(STATE_FILE) || existsSync(resolve(STATE_DIR, "validator.json"))) {
    log.warn("Local Solana validators are already recorded as running. Run `npm run solana:down` first.");
    process.exit(1);
  }
  const all = targets();
  log.banner(`Starting ${all.length} local Solana validator${all.length > 1 ? "s" : ""}`);
  const payer = ensurePayer();
  const cloneDevnet = process.argv.includes("--clone-devnet");
  if (cloneDevnet && all.length > 1) throw new Error("--clone-devnet supports a single validator only.");

  const states: ValidatorState[] = [];
  for (const [n, t] of all.entries()) states.push(await startOne(t, n, payer, cloneDevnet));
  writeFileSync(STATE_FILE, JSON.stringify(states, null, 2));
  log.info(`\nState: ${STATE_FILE}`);
}

/**
 * Starts one validator. The n-th gets its own faucet, gossip and dynamic port range, so several
 * run side by side; the first keeps the defaults a single validator always had.
 */
async function startOne(t: Target, n: number, payer: string, cloneDevnet: boolean): Promise<ValidatorState> {
  const rpc = `http://127.0.0.1:${t.port}`;
  const ledger = resolve(STATE_DIR, n === 0 ? "ledger" : `ledger-${t.key}`);
  const fd = openSync(resolve(STATE_DIR, n === 0 ? "validator.log" : `validator-${t.key}.log`), "a");

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
  const portArgs =
    n === 0
      ? []
      : [
          "--faucet-port", String(9900 + n),
          "--gossip-port", String(8000 + 100 * n),
          "--dynamic-port-range", `${20000 + 1000 * n}-${20000 + 1000 * n + 999}`,
        ];

  const child = spawn(
    "solana-test-validator",
    ["--reset", "--quiet", "--ledger", ledger, "--rpc-port", String(t.port), ...portArgs, ...programArgs],
    { detached: true, stdio: ["ignore", fd, fd] }
  );
  child.unref();

  await waitForRpc(rpc);

  // Confirm the endpoint is actually executable here, not just present.
  const shown = execFileSync("solana", ["program", "show", LZ_ENDPOINT_PROGRAM_ID, "--url", rpc, "--keypair", PAYER_FILE], {
    encoding: "utf8",
  });
  if (!shown.includes("BPFLoaderUpgradeab1e")) {
    throw new Error("LayerZero endpoint did not clone as an executable upgradeable program.");
  }
  execFileSync("solana", ["airdrop", "100", payer, "--url", rpc, "--keypair", PAYER_FILE], { stdio: "ignore" });

  log.ok(`${t.name}: validator running on ${rpc} (pid ${child.pid})`);
  log.kv("payer", payer);
  log.kv(
    "LayerZero EndpointV2",
    `${LZ_ENDPOINT_PROGRAM_ID} (${cloneDevnet ? "cloned from devnet" : "built from source"}, executable)`
  );
  if (!cloneDevnet) log.kv("simple-messagelib", `${SIMPLE_MESSAGELIB_PROGRAM_ID} (built from source)`);
  if (!cloneDevnet && existsSync(WHIRLPOOL_SO)) log.kv("Orca Whirlpools", `${WHIRLPOOL_PROGRAM_ID} (built from source)`);
  return {
    key: t.key,
    pid: child.pid!,
    rpc,
    payer,
    clonedPrograms: cloneDevnet ? [LZ_ENDPOINT_PROGRAM_ID] : [LZ_ENDPOINT_PROGRAM_ID, SIMPLE_MESSAGELIB_PROGRAM_ID],
  };
}

function down(): void {
  // `validator.json` is the single-validator file earlier versions wrote.
  const legacy = resolve(STATE_DIR, "validator.json");
  const states: { pid: number; key?: string }[] = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : existsSync(legacy)
      ? [JSON.parse(readFileSync(legacy, "utf8"))]
      : [];
  if (states.length === 0) {
    log.warn("No local Solana validator recorded as running.");
    return;
  }
  for (const st of states) {
    try {
      process.kill(st.pid, "SIGTERM");
      log.ok(`stopped validator ${st.key ?? ""} (pid ${st.pid})`);
    } catch {
      log.dim(`validator (pid ${st.pid}) was not running`);
    }
  }
  for (const f of [STATE_FILE, legacy]) {
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
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
  console.log("usage: tsx infra/solana/localnet.ts <up [--config <path>] | down>");
  process.exit(1);
}
