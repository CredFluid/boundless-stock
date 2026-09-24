import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Manifest, DeploymentConfig, ChainDeployment, PeerRecord } from "./types.js";
import { isLocal } from "./config.js";
import { repoRoot } from "./root.js";

export const MANIFEST_VERSION = "1";

export function manifestPath(name: string): string {
  return resolve(repoRoot(), "deployments", `${name}.manifest.json`);
}

export function emptyManifest(cfg: DeploymentConfig, deployer: string): Manifest {
  const now = new Date().toISOString();
  return {
    name: cfg.name,
    version: MANIFEST_VERSION,
    createdAt: now,
    updatedAt: now,
    environment: isLocal(cfg) ? "local" : "live",
    deployer,
    token: cfg.token,
    quoteAsset: cfg.quoteAsset,
    homeChainKey: cfg.homeChain.key,
    chains: {},
    peers: [],
    steps: [],
  };
}

export function loadManifest(name: string): Manifest | null {
  const path = manifestPath(name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function loadManifestAt(path: string): Manifest {
  const abs = resolve(repoRoot(), path);
  if (!existsSync(abs)) throw new Error(`Manifest not found: ${abs}`);
  return JSON.parse(readFileSync(abs, "utf8")) as Manifest;
}

export function saveManifest(m: Manifest): string {
  m.updatedAt = new Date().toISOString();
  const path = manifestPath(m.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
  return path;
}

export function recordStep(m: Manifest, module: string, status: "ok" | "failed", detail?: string): void {
  m.steps.push({ module, status, at: new Date().toISOString(), detail });
}

export function upsertChain(m: Manifest, chain: ChainDeployment): ChainDeployment {
  const existing = m.chains[chain.key];
  if (existing) {
    existing.contracts = { ...existing.contracts, ...chain.contracts };
    existing.lzEndpoint = chain.lzEndpoint || existing.lzEndpoint;
    if (chain.localMessageLib) existing.localMessageLib = chain.localMessageLib;
    return existing;
  }
  m.chains[chain.key] = chain;
  return chain;
}

export function setContract(m: Manifest, chainKey: string, name: string, address: string): void {
  const c = m.chains[chainKey];
  if (!c) throw new Error(`Manifest has no chain "${chainKey}" — deploy order problem.`);
  c.contracts[name] = address;
}

export function getContract(m: Manifest, chainKey: string, name: string): string {
  const addr = m.chains[chainKey]?.contracts[name];
  if (!addr) throw new Error(`Manifest has no "${name}" on chain "${chainKey}".`);
  return addr;
}

/** Replaces any existing record for the same (kind, fromChain, toEid) triple. */
export function upsertPeer(m: Manifest, record: PeerRecord): void {
  const i = m.peers.findIndex(
    (p) => p.label === record.label && p.fromChain === record.fromChain && p.toEid === record.toEid
  );
  if (i >= 0) m.peers[i] = record;
  else m.peers.push(record);
}

export function peerSummary(m: Manifest): { total: number; verified: number; failed: PeerRecord[] } {
  const failed = m.peers.filter((p) => !p.verified);
  return { total: m.peers.length, verified: m.peers.length - failed.length, failed };
}
