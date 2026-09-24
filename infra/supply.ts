#!/usr/bin/env tsx
/**
 * Supply report — where every unit of each omnichain asset currently lives.
 *
 * The question this answers, which comes up immediately for anyone operating an omnichain
 * token: "my home chain says totalSupply is less than I minted — where did the rest go?"
 *
 * An OFT's `totalSupply()` is **per chain**, not global. A bridge burns on the source and
 * mints on the destination, so each chain's figure is just the portion currently sitting
 * there. Only the sum across the whole chain set is invariant — and even that dips while a
 * message is in flight, because the tokens have been burned on the source and not yet minted
 * on the destination.
 *
 * Every chain of every VM is included: a Solana chain's share is its SPL mint's supply, and its
 * in-flight contribution comes from the flow counters CrossStock adds to the Solana OFT.
 *
 *   npm run supply -- --config config/localnet.json
 */
import { formatUnits } from "viem";
import { loadConfig, allChains, vmOf } from "./lib/config.js";
import { buildChains } from "./lib/chains.js";
import { loadManifest } from "./lib/manifest.js";
import { measureSupply } from "./lib/omnisupply.js";
import { log } from "./lib/logger.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet.json"));
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No manifest for "${cfg.name}" — run the deployment first.`);

  // EVM chains are read through viem; Solana chains through their own deployment files.
  const chains = buildChains(allChains(cfg).filter((c) => vmOf(c) === "evm"));
  const supply = await measureSupply(cfg, manifest, chains);

  log.banner(`Supply report — ${manifest.name}`);
  let broken = false;

  for (const [side, meta] of [
    ["base", cfg.token],
    ["quote", cfg.quoteAsset],
  ] as const) {
    const a = supply[side];
    const fmt = (v: bigint) => formatUnits(v, a.decimals);
    log.step(`${meta.name} (${meta.symbol}) — ${a.adapted ? "adapted" : `minted ${meta.initialSupply} at launch`}`);

    for (const r of a.rows) {
      const pct = a.total === 0n ? 0 : Number((r.supply * 10000n) / a.total) / 100;
      log.kv(
        `${r.name} (${r.role}${r.vm === "svm" ? ", Solana" : ""})`,
        `${fmt(r.supply).padStart(24)} ${meta.symbol}  ${pct.toFixed(2).padStart(6)}%` +
          (r.pool !== undefined ? `   [pool holds ${fmt(r.pool)}]` : "")
      );
      if (r.locked !== undefined) {
        log.dim(`      ${fmt(r.locked)} locked in the adapter, backing the representations on other chains`);
      }
    }
    if (a.inFlight !== 0n) log.kv("in flight", `${fmt(a.inFlight)} ${meta.symbol} (left one chain, not yet arrived)`);
    log.kv("ACROSS ALL CHAINS", `${fmt(a.total + a.inFlight)} ${meta.symbol}`);

    if (a.total + a.inFlight === a.expected) {
      log.ok(`conserved: equals the ${a.adapted ? "underlying token's supply" : "genesis supply"} exactly`);
    } else {
      broken = true;
      log.fail(`NOT conserved: expected ${fmt(a.expected)} ${meta.symbol}`);
    }
    if (a.adapted) {
      log.dim("ADAPTED asset: its home figure excludes what is locked in the adapter, because that");
      log.dim("backing already appears as representations on the other chains.");
    } else {
      log.dim("both halves come from chain state — supplies, and every OFT's bridgedOut/bridgedIn on");
      log.dim("EVM and Solana alike — so no feed of pending messages is needed to explain the gap");
    }
  }
  if (broken) process.exit(1);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
