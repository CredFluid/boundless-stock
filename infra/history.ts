#!/usr/bin/env tsx
/**
 * Trade history — every request on every mirror chain, and where it ended up.
 *
 * A poller over request STATE, not events: request ids on each mirror are sequential and each
 * request records its own status and timestamps, so the history is exactly what the chains
 * say, with no event indexing to fall behind or re-org. Each sync fetches ids it has not seen
 * and re-reads only the records that can still change (pending, or stranded and not yet
 * recovered). Results persist to `.crossstock/history/<deployment>.json`.
 *
 *   npm run history -- --config config/localnet.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { formatUnits, type Address } from "viem";

import { loadConfig, allChains, vmOf } from "./lib/config.js";
import { buildChains, type Chain } from "./lib/chains.js";
import { loadManifest } from "./lib/manifest.js";
import { forgeArtifact } from "./lib/artifacts.js";
import { repoRoot } from "./lib/root.js";
import { log } from "./lib/logger.js";
import type { DeploymentConfig, Manifest } from "./lib/types.js";
import { SolanaChain } from "./solana/chain.js";
import { SolanaSwapClient } from "./solana/client.js";
import { solanaHome } from "./lib/market.js";
import { SolanaRelayAdmin } from "./solana/relay-admin.js";

export type RequestStatus = "pending" | "filled" | "refunded" | "stranded" | "cancelled";
const STATUS: Record<number, RequestStatus> = { 1: "pending", 2: "filled", 3: "refunded", 4: "stranded", 5: "cancelled" };

export interface HistoryRecord {
  key: string;
  chainKey: string;
  chainName: string;
  vm: "evm" | "svm";
  id: string;
  user: string;
  direction: "buy" | "sell";
  tokenIn: string;
  tokenOut: string;
  /** Whole units, as strings, in each token's decimals on that chain. */
  amountIn: string;
  minAmountOut: string;
  amountOut: string;
  status: RequestStatus;
  failureReason: number;
  lzNonce: string;
  /** Unix seconds; 0 while pending. */
  createdAt: number;
  settledAt: number;
  /** For a stranded request: what the home chain still holds for it (whole units), or "0" once recovered. */
  strandedHeld?: string;
}

export interface History {
  deployment: string;
  updatedAt: string;
  records: HistoryRecord[];
  /** Chains that could not be read on the last sync; their records are from earlier syncs. */
  unreachable: string[];
}

const storePath = (name: string) => resolve(repoRoot(), ".crossstock", "history", `${name}.json`);

export function loadHistory(name: string): History {
  const path = storePath(name);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as History)
    : { deployment: name, updatedAt: new Date(0).toISOString(), records: [], unreachable: [] };
}

/** Whether a record can still change, and so must be re-read. */
const live = (r: HistoryRecord) => r.status === "pending" || (r.status === "stranded" && r.strandedHeld !== "0");

export async function syncHistory(cfg: DeploymentConfig, manifest: Manifest, evm: Map<string, Chain>): Promise<History> {
  const history = loadHistory(cfg.name);
  const byKey = new Map(history.records.map((r) => [r.key, r]));
  const unreachable: string[] = [];
  const sym = { base: cfg.token.symbol, quote: cfg.quoteAsset.symbol };

  // ---- EVM mirrors: SwapRequest.getRequest over ids 1..nextRequestId-1
  const requestAbi = forgeArtifact("SwapRequest").abi;
  for (const cd of Object.values(manifest.chains).filter((c) => c.role === "mirror")) {
    const chain = evm.get(cd.key);
    const request = cd.contracts.SwapRequest as Address | undefined;
    if (!chain || !request) continue;
    try {
      const next = await chain.read<bigint>(request, requestAbi, "nextRequestId");
      for (let id = 1n; id < next; id++) {
        const key = `${cd.key}:${id}`;
        const prev = byKey.get(key);
        if (prev && !live(prev)) continue;
        const r = await chain.read<{
          user: Address; direction: number; amountIn: bigint; minAmountOut: bigint; amountOut: bigint;
          createdAt: bigint; settledAt: bigint; status: number; failureReason: number; lzNonce: bigint;
        }>(request, requestAbi, "getRequest", [id]);
        const buy = r.direction === 0;
        const [inDec, outDec] = buy ? [cfg.quoteAsset.decimals, cfg.token.decimals] : [cfg.token.decimals, cfg.quoteAsset.decimals];
        byKey.set(key, {
          key, chainKey: cd.key, chainName: cd.name, vm: "evm", id: id.toString(), user: r.user,
          direction: buy ? "buy" : "sell", tokenIn: buy ? sym.quote : sym.base, tokenOut: buy ? sym.base : sym.quote,
          amountIn: formatUnits(r.amountIn, inDec), minAmountOut: formatUnits(r.minAmountOut, outDec),
          amountOut: formatUnits(r.amountOut, outDec), status: STATUS[r.status] ?? "pending",
          failureReason: r.failureReason, lzNonce: r.lzNonce.toString(),
          createdAt: Number(r.createdAt), settledAt: Number(r.settledAt), strandedHeld: prev?.strandedHeld,
        });
      }
    } catch {
      unreachable.push(cd.key);
    }
  }

  // ---- Solana mirrors: the request accounts of swap_request
  for (const c of allChains(cfg).filter((c) => vmOf(c) === "svm" && c.key !== cfg.homeChain.key)) {
    try {
      const client = new SolanaSwapClient(cfg, new SolanaChain(c));
      const [bDec, qDec] = [(await client.mintSupply("base")).decimals, (await client.mintSupply("quote")).decimals];
      const next = await client.nextRequestId();
      for (let id = 1n; id < next; id++) {
        const key = `${c.key}:${id}`;
        const prev = byKey.get(key);
        if (prev && !live(prev)) continue;
        const r = await client.getRequest(id);
        if (!r) continue;
        const buy = r.direction === 0;
        const [inDec, outDec] = buy ? [qDec, bDec] : [bDec, qDec];
        byKey.set(key, {
          key, chainKey: c.key, chainName: c.name, vm: "svm", id: id.toString(), user: r.user.toBase58(),
          direction: buy ? "buy" : "sell", tokenIn: buy ? sym.quote : sym.base, tokenOut: buy ? sym.base : sym.quote,
          amountIn: formatUnits(r.amountIn, inDec), minAmountOut: formatUnits(r.minAmountOut, outDec),
          amountOut: formatUnits(r.amountOut, outDec), status: STATUS[r.status] ?? "pending",
          failureReason: r.failureReason, lzNonce: r.lzNonce.toString(),
          createdAt: Number(r.createdAt), settledAt: Number(r.settledAt), strandedHeld: prev?.strandedHeld,
        });
      }
    } catch {
      unreachable.push(c.key);
    }
  }

  // ---- stranded: what the home chain still holds for each
  const stranded = [...byKey.values()].filter((r) => r.status === "stranded" && r.strandedHeld !== "0");
  if (stranded.length > 0) {
    try {
      for (const r of stranded) r.strandedHeld = await strandedHeld(cfg, manifest, evm, r);
    } catch {
      unreachable.push(cfg.homeChain.key);
    }
  }

  const out: History = {
    deployment: cfg.name,
    updatedAt: new Date().toISOString(),
    records: [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key)),
    unreachable,
  };
  mkdirSync(dirname(storePath(cfg.name)), { recursive: true });
  writeFileSync(storePath(cfg.name), JSON.stringify(out, null, 2) + "\n");
  return out;
}

async function strandedHeld(cfg: DeploymentConfig, manifest: Manifest, evm: Map<string, Chain>, r: HistoryRecord): Promise<string> {
  const eid = allChains(cfg).find((c) => c.key === r.chainKey)!.eid;
  if (vmOf(cfg.homeChain) === "svm") {
    const home = solanaHome(cfg)!;
    const sol = new SolanaChain(cfg.homeChain);
    const admin = new SolanaRelayAdmin(sol, home);
    const d = (await sol.connection.getAccountInfo(admin.strandedAddress(eid, BigInt(r.id))))?.data;
    if (!d) return "0"; // retried: the record is closed
    // Stranded: disc 8 | eid 4 | request_id 8 | mint 32 | amount u64
    const mint = new PublicKey(d.subarray(20, 52)).toBase58();
    const decimals = mint === home.assets.base.mint ? home.assets.base.decimals : home.assets.quote.decimals;
    return formatUnits(d.readBigUInt64LE(52), decimals);
  }
  const home = evm.get(cfg.homeChain.key)!;
  const c = manifest.chains[cfg.homeChain.key].contracts;
  const relayAbi = forgeArtifact("SwapRelay").abi;
  const amount = await home.read<bigint>(c.SwapRelay as Address, relayAbi, "stranded", [eid, BigInt(r.id)]);
  if (amount === 0n) return "0";
  const token = await home.read<Address>(c.SwapRelay as Address, relayAbi, "strandedToken", [eid, BigInt(r.id)]);
  const decimals = token.toLowerCase() === c.TokenizedStock.toLowerCase() ? cfg.token.decimals : cfg.quoteAsset.decimals;
  return formatUnits(amount, decimals);
}

// ---------------------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const i = process.argv.indexOf("--config");
  const cfg = loadConfig(i >= 0 ? process.argv[i + 1] : "config/localnet.json");
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No manifest for "${cfg.name}" — deploy first.`);
  const evm = buildChains(allChains(cfg).filter((c) => vmOf(c) === "evm"));
  const h = await syncHistory(cfg, manifest, evm);
  log.banner(`Trade history — ${cfg.name}`);
  const counts = h.records.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  log.kv("requests", `${h.records.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"})`);
  if (h.unreachable.length) log.warn(`unreachable: ${h.unreachable.join(", ")} — showing their last known records`);
  for (const r of h.records.slice(0, 20)) {
    log.kv(
      `${r.chainName} #${r.id}`,
      `${r.direction} ${r.amountIn} ${r.tokenIn} → ${r.status === "filled" ? `${r.amountOut} ${r.tokenOut}` : r.status}` +
        (r.strandedHeld && r.strandedHeld !== "0" ? ` (${r.strandedHeld} held at home)` : "")
    );
  }
}

if (process.argv[1]?.endsWith("history.ts")) {
  main().catch((e) => {
    log.fail(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
