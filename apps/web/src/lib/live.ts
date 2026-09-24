import "server-only";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Manifest } from "@crossstock/shared";
import { configForDeployment } from "@infra/lib/deployment-config";
import { loadManifest } from "@infra/lib/manifest";
import { allChains, vmOf } from "@infra/lib/config";
import { buildChains, type Chain } from "@infra/lib/chains";
import { measureSupply, type AssetSupply } from "@infra/lib/omnisupply";
import { readHomeMarket, readRelayHealth, type HomeMarket, type RelayHealth } from "@infra/lib/market";
import { loadHistory, syncHistory, type History, type HistoryRecord } from "@infra/history";
import { repoRoot } from "./deployments";

/**
 * The read API's engine: live state for one deployment, read from its chains with the infra's
 * own code — the same functions behind `npm run supply` and `npm run history`.
 *
 * Every figure is fetched from chain on demand and cached briefly, so a dashboard polling
 * every few seconds costs one set of RPC reads per interval, not one per viewer.
 */

process.env.CROSSSTOCK_ROOT ??= repoRoot();

const LIVE_TTL_MS = 4_000;
const HISTORY_TTL_MS = 4_000;
const RPC_TIMEOUT_MS = 8_000;
/** A pending request older than this is flagged for an operator. */
export const ATTENTION_AFTER_S = 10 * 60;

export type Availability =
  | { state: "live" }
  | { state: "no-config"; reason: string }
  | { state: "not-running"; reason: string }
  | { state: "unreachable"; reason: string };

export interface JsonSupply {
  symbol: string;
  decimals: number;
  total: string;
  inFlight: string;
  expected: string;
  conserved: boolean;
  adapted: boolean;
  rows: { key: string; name: string; role: string; vm: string; supply: string; pool?: string; locked?: string }[];
}

export interface LiveSnapshot {
  deployment: string;
  at: string;
  availability: Availability;
  supply?: { base: JsonSupply; quote: JsonSupply };
  market?: HomeMarket;
  relay?: RelayHealth;
}

const withTimeout = <T,>(p: Promise<T>, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), RPC_TIMEOUT_MS)),
  ]);

/**
 * Whether this deployment is what the chains are running now. On a live network it always is.
 * Local chains are recreated on every `chains:up`, and anvil hands out the same addresses each
 * time, so an older local deployment can share addresses with a newer one — reading it "live"
 * would describe the wrong deployment. It counts only if it was deployed after the chains
 * it needs were started.
 */
function currentOnLocalChains(manifest: Manifest, hasSolana: boolean): Availability {
  if (manifest.environment !== "local") return { state: "live" };
  const root = repoRoot();
  const starts: number[] = [];
  const evm = resolve(root, ".localnet/nodes.json");
  if (!existsSync(evm)) return { state: "not-running", reason: "The local EVM chains are not running (npm run chains:up)." };
  starts.push(statSync(evm).mtimeMs);
  if (hasSolana) {
    const sol = resolve(root, ".localnet-solana/validators.json");
    if (!existsSync(sol)) return { state: "not-running", reason: "The local Solana validator is not running (npm run solana:up)." };
    starts.push(statSync(sol).mtimeMs);
  }
  if (Date.parse(manifest.updatedAt) < Math.max(...starts)) {
    return { state: "not-running", reason: "The local chains were restarted after this deployment; it no longer exists on them." };
  }
  return { state: "live" };
}

interface Context {
  cfg: NonNullable<ReturnType<typeof configForDeployment>>["config"];
  manifest: Manifest;
  evm: Map<string, Chain>;
  availability: Availability;
}

function context(name: string): Context | { availability: Availability } {
  const manifest = loadManifest(name) as Manifest | null;
  if (!manifest) return { availability: { state: "no-config", reason: "No deployment record by that name." } };
  const found = configForDeployment(name);
  if (!found) {
    return { availability: { state: "no-config", reason: "No config in config/ produced this deployment, so its RPC endpoints are unknown." } };
  }
  const cfg = found.config;
  const availability = currentOnLocalChains(manifest, allChains(cfg).some((c) => vmOf(c) === "svm"));
  const evm = buildChains(allChains(cfg).filter((c) => vmOf(c) === "evm"));
  return { cfg, manifest, evm, availability };
}

function toJson(a: AssetSupply): JsonSupply {
  const f = (v: bigint) => {
    const neg = v < 0n;
    const s = (neg ? -v : v).toString().padStart(a.decimals + 1, "0");
    const whole = s.slice(0, s.length - a.decimals);
    const frac = s.slice(s.length - a.decimals).replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
  };
  return {
    symbol: a.symbol,
    decimals: a.decimals,
    total: f(a.total),
    inFlight: f(a.inFlight),
    expected: f(a.expected),
    conserved: a.total + a.inFlight === a.expected,
    adapted: a.adapted,
    rows: a.rows.map((r) => ({
      key: r.key,
      name: r.name,
      role: r.role,
      vm: r.vm,
      supply: f(r.supply),
      pool: r.pool === undefined ? undefined : f(r.pool),
      locked: r.locked === undefined ? undefined : f(r.locked),
    })),
  };
}

const liveCache = new Map<string, { at: number; value: Promise<LiveSnapshot> }>();

export function getLive(name: string): Promise<LiveSnapshot> {
  const hit = liveCache.get(name);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return hit.value;
  const value = readLive(name);
  liveCache.set(name, { at: Date.now(), value });
  return value;
}

async function readLive(name: string): Promise<LiveSnapshot> {
  const at = new Date().toISOString();
  const ctx = context(name);
  if (!("cfg" in ctx) || ctx.availability.state !== "live") {
    return { deployment: name, at, availability: ctx.availability };
  }
  try {
    const [supply, market, relay] = await Promise.all([
      withTimeout(measureSupply(ctx.cfg, ctx.manifest, ctx.evm), "supply"),
      withTimeout(readHomeMarket(ctx.cfg, ctx.manifest, ctx.evm), "market"),
      withTimeout(readRelayHealth(ctx.cfg, ctx.manifest, ctx.evm), "relay"),
    ]);
    return { deployment: name, at, availability: { state: "live" }, supply: { base: toJson(supply.base), quote: toJson(supply.quote) }, market, relay };
  } catch (e) {
    return { deployment: name, at, availability: { state: "unreachable", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) } };
  }
}

export interface RequestsView {
  deployment: string;
  availability: Availability;
  history: History;
}

const historyCache = new Map<string, { at: number; value: Promise<RequestsView> }>();

/** The deployment's trade history, synced from its chains at most every few seconds. */
export function getRequests(name: string): Promise<RequestsView> {
  const hit = historyCache.get(name);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.value;
  const value = readRequests(name);
  historyCache.set(name, { at: Date.now(), value });
  return value;
}

async function readRequests(name: string): Promise<RequestsView> {
  const ctx = context(name);
  if (!("cfg" in ctx) || ctx.availability.state !== "live") {
    return { deployment: name, availability: ctx.availability, history: loadHistory(name) };
  }
  try {
    const history = await withTimeout(syncHistory(ctx.cfg, ctx.manifest, ctx.evm), "history");
    return { deployment: name, availability: { state: "live" }, history };
  } catch (e) {
    return {
      deployment: name,
      availability: { state: "unreachable", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) },
      history: loadHistory(name),
    };
  }
}

export interface OperationsItem extends HistoryRecord {
  deployment: string;
  ageSeconds: number;
}

export interface OperationsView {
  at: string;
  pending: OperationsItem[];
  attention: OperationsItem[];
  stranded: OperationsItem[];
  recovered: OperationsItem[];
  cancelled: OperationsItem[];
  deployments: { name: string; availability: Availability }[];
}

/** Everything an operator should look at, across every deployment that is live. */
export async function getOperations(names: string[]): Promise<OperationsView> {
  const now = Math.floor(Date.now() / 1000);
  const views = await Promise.all(names.map((n) => getRequests(n)));
  const items = views.flatMap((v) =>
    v.availability.state === "live"
      ? v.history.records.map((r) => ({ ...r, deployment: v.deployment, ageSeconds: now - r.createdAt }))
      : []
  );
  const pending = items.filter((r) => r.status === "pending").sort((a, b) => b.ageSeconds - a.ageSeconds);
  return {
    at: new Date().toISOString(),
    pending,
    attention: pending.filter((r) => r.ageSeconds >= ATTENTION_AFTER_S),
    stranded: items.filter((r) => r.status === "stranded" && r.strandedHeld !== "0"),
    recovered: items.filter((r) => r.status === "stranded" && r.strandedHeld === "0"),
    cancelled: items.filter((r) => r.status === "cancelled"),
    deployments: views.map((v) => ({ name: v.deployment, availability: v.availability })),
  };
}
