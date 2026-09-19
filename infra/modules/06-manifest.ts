import type { Manifest } from "../lib/types.js";
import type { Chain } from "../lib/chains.js";
import { saveManifest, peerSummary, recordStep } from "../lib/manifest.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 6 — manifest output.
 *
 * The single artifact anything downstream reads. A script, a UI, or the validation suite
 * should never need to know deployment order or dig through logs to find an address — it
 * reads this file.
 *
 * Finalisation is a consistency check, not just a write: a manifest that records an
 * unverified peer link or a missing contract is a manifest that will mislead whoever picks it
 * up next, so the discrepancies are surfaced loudly here.
 */
export function finalizeManifest(
  manifest: Manifest,
  chains?: Map<string, Chain>
): { path: string; complete: boolean; problems: string[] } {
  log.step("Module 6 — manifest");

  if (chains) {
    for (const [key, chain] of chains) {
      if (manifest.chains[key]) {
        manifest.chains[key].deploymentGas = { gasUsed: chain.gasUsed.toString(), txCount: chain.txCount };
      }
    }
  }

  const problems: string[] = [];
  const homeKey = manifest.homeChainKey;

  const required: Record<string, string[]> = {
    home: ["TokenizedStock", "TokenizedStockOft", "QuoteAsset", "QuoteAssetOft", "Pool", "SwapRouter", "SwapRelay"],
    mirror: ["TokenizedStock", "TokenizedStockOft", "QuoteAsset", "QuoteAssetOft", "SwapRequest"],
  };

  for (const [key, chain] of Object.entries(manifest.chains)) {
    for (const name of required[chain.role]) {
      if (!chain.contracts[name]) problems.push(`${key}: missing ${name}`);
    }
    if (!chain.lzEndpoint) problems.push(`${key}: missing lzEndpoint`);
  }

  const peers = peerSummary(manifest);
  for (const f of peers.failed) {
    problems.push(`peer ${f.kind} ${f.fromChain} → ${f.toChain}: expected ${f.expected}, got ${f.actual}`);
  }

  if (!manifest.pool) problems.push("no pool recorded");

  const complete = problems.length === 0;
  recordStep(manifest, "06-manifest", complete ? "ok" : "failed", `${problems.length} problems`);

  const path = saveManifest(manifest);

  log.group("summary");
  log.kv("environment", manifest.environment);
  log.kv("home chain", `${manifest.chains[homeKey]?.name} (eid ${manifest.chains[homeKey]?.eid})`);
  log.kv("mirror chains", String(Object.values(manifest.chains).filter((c) => c.role === "mirror").length));
  log.kv("peer links", `${peers.verified}/${peers.total} verified`);
  log.kv("pool", manifest.pool?.address ?? "none");
  let totalGas = 0n;
  for (const c of Object.values(manifest.chains)) {
    if (!c.deploymentGas) continue;
    totalGas += BigInt(c.deploymentGas.gasUsed);
    log.kv(`gas — ${c.name}`, `${Number(c.deploymentGas.gasUsed).toLocaleString()} (${c.deploymentGas.txCount} txs)`);
  }
  if (totalGas > 0n) log.kv("gas — total", Number(totalGas).toLocaleString());
  log.groupEnd();

  if (complete) {
    log.ok(`manifest written: ${path}`);
  } else {
    log.fail(`manifest written with ${problems.length} problem(s): ${path}`);
    for (const p of problems) log.dim(`  - ${p}`);
  }

  return { path, complete, problems };
}

/** Prints the deployment as an operator would want to read it. */
export function printManifest(manifest: Manifest): void {
  log.banner(`Deployment: ${manifest.name}`);
  for (const chain of Object.values(manifest.chains)) {
    log.group(`${chain.name}  [${chain.role}]  chainId ${chain.chainId}  eid ${chain.eid}`);
    log.kv("lzEndpoint", chain.lzEndpoint);
    for (const [name, addr] of Object.entries(chain.contracts)) log.kv(name, addr);
    log.groupEnd();
  }
  if (manifest.pool) {
    log.group("Pool");
    log.kv("address", manifest.pool.address);
    log.kv("fee tier", String(manifest.pool.feeTier));
    log.kv("liquidity", manifest.pool.liquidity);
    log.kv("reserves", `${manifest.pool.reserves.base} base / ${manifest.pool.reserves.quote} quote`);
    log.groupEnd();
  }
}
