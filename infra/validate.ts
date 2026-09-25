#!/usr/bin/env tsx
/**
 * CrossStock validation suite.
 *
 * Runs against a deployment manifest and confirms the deployment actually works. Scenario 2 is
 * the one that matters: it is the core proof point.
 *
 *   npm run validate -- --config config/localnet.json
 *   npm run validate -- --only 2
 */
import { Harness, type ScenarioResult } from "./validation/harness.js";
import { scenario1 } from "./validation/01-direct-bridge.js";
import { scenario2 } from "./validation/02-swap-roundtrip.js";
import { scenario3 } from "./validation/03-bad-slippage.js";
import { scenario4 } from "./validation/04-stalled-message.js";
import { scenario5 } from "./validation/05-multi-mirror.js";
import { scenario6 } from "./validation/06-sell-direction.js";
import { scenario7 } from "./validation/07-solana-mirror.js";
import { scenario8 } from "./validation/08-solana-home.js";
import { scenario9 } from "./validation/09-solana-to-solana.js";
import { scenario10 } from "./validation/10-partner-orders.js";
import { log } from "./lib/logger.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const h = await Harness.create({ config: arg("config"), manifest: arg("manifest") });
  const only = arg("only");
  const mirror = arg("mirror"); // target a specific mirror chain by key

  log.banner(`CrossStock validation — ${h.manifest.name}`);
  log.kv("environment", h.manifest.environment);
  const solanaHome = (h.config.homeChain.vm ?? "evm") === "svm";
  log.kv("home chain", `${h.config.homeChain.name} (eid ${h.config.homeChain.eid})${solanaHome ? " — Solana" : ""}`);
  log.kv("mirror chains", h.mirrorKeys.map((k) => h.name(k)).join(", "));
  log.kv("pool", h.manifest.pool?.address ?? "none");

  if (h.relayer) {
    await h.relayer.syncToHead();
    log.dim("local relayer active (stands in for LayerZero DVN + Executor)");
  }

  const all: { id: string; run: () => Promise<ScenarioResult> }[] = [
    { id: "1", run: () => scenario1(h) },
    { id: "2", run: () => scenario2(h, mirror) },
    { id: "3", run: () => scenario3(h, mirror) },
    { id: "4", run: () => scenario4(h) },
    { id: "5", run: () => scenario5(h) },
    { id: "6", run: () => scenario6(h, mirror) },
    { id: "7", run: () => scenario7(h) },
    { id: "8", run: () => scenario8(h) },
    { id: "9", run: () => scenario9(h) },
    { id: "10", run: () => scenario10(h) },
  ];

  // Scenarios 1–7 exercise an EVM home chain's pool and relay directly; with the home on Solana
  // the same claims are made by scenario 8, through `swap_relay` and the Whirlpool. Scenario 9
  // (Solana to Solana) applies to either, when the deployment has the chains for it.
  const applicable = solanaHome ? all.filter((s) => s.id === "8" || s.id === "9") : all;
  const selected = only ? applicable.filter((s) => s.id === only) : applicable;
  if (selected.length === 0) throw new Error(`No scenario matching --only ${only}`);

  const results: ScenarioResult[] = [];
  for (const s of selected) {
    results.push(await s.run());
  }

  log.banner("Validation summary");
  for (const r of results) {
    if (r.passed) log.ok(`${r.name} — ${r.detail}`);
    else log.fail(`${r.name} — ${r.detail}`);
    for (const [k, v] of Object.entries(r.metrics)) log.kv(k, String(v));
  }

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    log.fail(`${failed.length}/${results.length} scenario(s) failed`);
    process.exit(1);
  }
  log.ok(`${results.length}/${results.length} scenarios passed`);
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
