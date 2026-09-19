import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DeploymentConfig, ChainConfig } from "./types.js";

/**
 * Loads a deployment config and substitutes ${ENV_VAR} references.
 *
 * Config is the only place chain identity is allowed to live. If a value needs to change
 * between a local run and a Base Sepolia run, it belongs here — not in a module.
 */

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
}

/** Replaces ${VAR} with process.env.VAR, throwing if a referenced variable is unset. */
function interpolate(value: string, where: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined || v === "") {
      throw new Error(`Config ${where} references \${${name}} but that environment variable is not set.`);
    }
    return v;
  });
}

function walk(node: unknown, where: string): unknown {
  if (typeof node === "string") return interpolate(node, where);
  if (Array.isArray(node)) return node.map((n, i) => walk(n, `${where}[${i}]`));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, `${where}.${k}`);
    return out;
  }
  return node;
}

function validateChain(c: ChainConfig, where: string): void {
  for (const field of ["key", "name", "eid", "rpcUrl"] as const) {
    if (c[field] === undefined || c[field] === null || c[field] === "") {
      throw new Error(`Config ${where} is missing required field "${field}".`);
    }
  }

  const vm = c.vm ?? "evm";
  if (vm !== "evm" && vm !== "svm") {
    throw new Error(`Config ${where} has unknown vm "${vm}". Supported: "evm", "svm".`);
  }

  // Per-VM requirements. Checked here rather than at deploy time so a malformed config fails
  // before anything touches a chain.
  if (vm === "evm" && (c.chainId === undefined || c.chainId === null)) {
    throw new Error(`Config ${where} is an EVM chain and must specify "chainId".`);
  }
  if (vm === "svm") {
    if (!c.svm?.endpointProgramId) {
      throw new Error(`Config ${where} is a Solana chain and must specify "svm.endpointProgramId".`);
    }
    if (c.chainId !== undefined) {
      throw new Error(`Config ${where} is a Solana chain; "chainId" is an EVM concept and must be omitted.`);
    }
  }
}

/** The VM a chain runs, defaulting to EVM so existing configs are unaffected. */
export const vmOf = (c: ChainConfig): "evm" | "svm" => c.vm ?? "evm";

export function loadConfig(path: string): DeploymentConfig {
  loadDotEnv();
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new Error(`Config not found: ${abs}`);

  const cfg = walk(JSON.parse(readFileSync(abs, "utf8")), "root") as DeploymentConfig;

  if (!cfg.name) throw new Error("Config is missing a top-level \"name\".");
  validateChain(cfg.homeChain, "homeChain");
  if (!Array.isArray(cfg.mirrorChains) || cfg.mirrorChains.length === 0) {
    throw new Error("Config needs at least one entry in \"mirrorChains\".");
  }
  cfg.mirrorChains.forEach((c, i) => validateChain(c, `mirrorChains[${i}]`));

  // Endpoint ids must be unique across the whole set: LayerZero routes purely on eid, and a
  // collision would silently deliver a packet to the wrong chain.
  const eids = new Map<number, string>();
  for (const c of [cfg.homeChain, ...cfg.mirrorChains]) {
    const seen = eids.get(c.eid);
    if (seen) throw new Error(`Duplicate eid ${c.eid} used by both "${seen}" and "${c.key}".`);
    eids.set(c.eid, c.key);
  }

  const keys = new Set<string>();
  for (const c of [cfg.homeChain, ...cfg.mirrorChains]) {
    if (keys.has(c.key)) throw new Error(`Duplicate chain key "${c.key}".`);
    keys.add(c.key);
  }

  return cfg;
}

export const allChains = (cfg: DeploymentConfig): ChainConfig[] => [cfg.homeChain, ...cfg.mirrorChains];

/** A run is "local" if any chain needs the infra to stand up its own endpoint. */
export const isLocal = (cfg: DeploymentConfig): boolean => allChains(cfg).some((c) => !c.lzEndpoint);
