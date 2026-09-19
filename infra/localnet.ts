#!/usr/bin/env tsx
/**
 * Local three-chain environment.
 *
 * Starts one anvil node per chain in the config, using each chain's real chain id so the only
 * thing that differs from a live run is the RPC URL.
 *
 *   npm run chains:up   [-- --config config/localnet.json]
 *   npm run chains:down
 */
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, allChains } from "./lib/config.js";
import { log } from "./lib/logger.js";

const STATE_DIR = resolve(process.cwd(), ".localnet");
const STATE_FILE = resolve(STATE_DIR, "nodes.json");

interface NodeState {
  key: string;
  name: string;
  chainId: number;
  port: number;
  pid: number;
  logFile: string;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function portOf(rpcUrl: string): number {
  const m = rpcUrl.match(/:(\d+)/);
  if (!m) throw new Error(`Cannot derive a port from rpcUrl "${rpcUrl}" — local chains need an explicit port.`);
  return Number(m[1]);
}

async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC at ${url} did not come up within ${timeoutMs}ms`);
}

async function up(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet.json"));
  mkdirSync(STATE_DIR, { recursive: true });

  if (existsSync(STATE_FILE)) {
    log.warn("Local chains appear to be running already. Run `npm run chains:down` first.");
    process.exit(1);
  }

  log.banner("Starting local chain set");
  const nodes: NodeState[] = [];

  for (const c of allChains(cfg)) {
    const port = portOf(c.rpcUrl);
    const logFile = resolve(STATE_DIR, `${c.key}.log`);
    const fd = openSync(logFile, "a");

    const child = spawn(
      "anvil",
      [
        "--port", String(port),
        "--chain-id", String(c.chainId!),
        "--accounts", "10",
        "--balance", "100000",
        // Uniswap's NonfungiblePositionManager sits right at the EIP-170 limit; raising it
        // locally avoids a deploy failure that would say nothing about CrossStock.
        "--disable-code-size-limit",
      ],
      { detached: true, stdio: ["ignore", fd, fd] }
    );
    child.unref();

    await waitForRpc(c.rpcUrl);
    nodes.push({ key: c.key, name: c.name, chainId: c.chainId!, port, pid: child.pid!, logFile });
    log.ok(`${c.name}: chainId ${c.chainId} on :${port} (pid ${child.pid})`);
  }

  writeFileSync(STATE_FILE, JSON.stringify(nodes, null, 2));
  log.info(`\nState: ${STATE_FILE}`);
  log.info("Next: npm run deploy -- --config config/localnet.json");
}

function down(): void {
  if (!existsSync(STATE_FILE)) {
    log.warn("No local chains recorded as running.");
    return;
  }
  const nodes: NodeState[] = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  for (const n of nodes) {
    try {
      process.kill(n.pid, "SIGTERM");
      log.ok(`stopped ${n.name} (pid ${n.pid})`);
    } catch {
      log.dim(`${n.name} (pid ${n.pid}) was not running`);
    }
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
  console.log("usage: tsx infra/localnet.ts <up|down> [--config <path>]");
  process.exit(1);
}
