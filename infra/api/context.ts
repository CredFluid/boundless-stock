/**
 * Shared plumbing for the partner API: errors with an HTTP status, and a per-deployment
 * context — config, manifest, chain clients — built once and reused.
 */
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { configForDeployment } from "../lib/deployment-config.js";
import { loadManifest } from "../lib/manifest.js";
import { allChains, vmOf } from "../lib/config.js";
import { buildChains, type Chain } from "../lib/chains.js";
import { SolanaSwapClient } from "../solana/client.js";
import { SolanaChain } from "../solana/chain.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface ApiContext {
  cfg: DeploymentConfig;
  manifest: Manifest;
  /** Every EVM chain in the deployment. */
  evm: Map<string, Chain>;
  /** A client per Solana MIRROR chain, by chain key. */
  solana: Map<string, SolanaSwapClient>;
}

const contexts = new Map<string, ApiContext>();

/** A context for a config already in hand — e.g. one passed on the command line. */
export function contextFromConfig(cfg: DeploymentConfig): ApiContext {
  const hit = contexts.get(cfg.name);
  if (hit) return hit;
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new ApiError(404, "unknown_deployment", `No deployment "${cfg.name}".`);
  return remember(cfg, manifest);
}

function remember(cfg: DeploymentConfig, manifest: Manifest): ApiContext {
  const solana = new Map(
    allChains(cfg)
      .filter((c) => vmOf(c) === "svm" && c.key !== cfg.homeChain.key)
      .map((c) => [c.key, new SolanaSwapClient(cfg, new SolanaChain(c))] as const)
  );
  const ctx: ApiContext = { cfg, manifest, evm: buildChains(allChains(cfg).filter((c) => vmOf(c) === "evm")), solana };
  contexts.set(cfg.name, ctx);
  return ctx;
}

export function apiContext(name: string): ApiContext {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new ApiError(400, "invalid_deployment", `"${name}" is not a deployment name.`);
  const hit = contexts.get(name);
  if (hit) return hit;
  const manifest = loadManifest(name);
  if (!manifest) throw new ApiError(404, "unknown_deployment", `No deployment "${name}".`);
  const found = configForDeployment(name);
  if (!found) throw new ApiError(404, "unknown_deployment", `No config for "${name}", so its chains cannot be reached.`);
  return remember(found.config, manifest);
}

/** Forget cached contexts, e.g. after a redeploy. */
export function resetApiContexts(): void {
  contexts.clear();
}

export function isMirror(ctx: ApiContext, chain: string): { vm: "evm" | "svm" } {
  if (ctx.solana.has(chain)) return { vm: "svm" };
  const c = ctx.manifest.chains[chain];
  if (c?.role === "mirror" && c.contracts.SwapRequest) return { vm: "evm" };
  throw new ApiError(404, "unknown_chain", `"${chain}" is not a mirror chain of ${ctx.cfg.name}.`);
}

export function parseAmount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new ApiError(400, "invalid_amount", `${field} must be a string of integer base units.`);
  }
  const n = BigInt(value);
  if (n === 0n) throw new ApiError(400, "invalid_amount", `${field} must be greater than zero.`);
  return n;
}

export function parseBps(value: unknown, field: string, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ApiError(400, "invalid_bps", `${field} must be an integer from 0 to ${max}.`);
  }
  return value;
}
