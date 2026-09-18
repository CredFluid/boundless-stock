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
import { log } from "./lib/logger.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const h = await Harness.create({ config: arg("config"), manifest: arg("manifest") });
  const only = arg("only");

  log.banner(`CrossStock validation — ${h.manifest.name}`);
  log.kv("environment", h.manifest.environment);
  log.kv("home chain", `${h.name(h.home.key)} (eid ${h.eid(h.home.key)})`);
  log.kv("mirror chains", h.mirrorKeys.map((k) => h.name(k)).join(", "));
  log.kv("pool", h.manifest.pool?.address ?? "none");

  if (h.relayer) {
    await h.relayer.syncToHead();
    log.dim("local relayer active (stands in for LayerZero DVN + Executor)");
  }

  const all: { id: string; run: () => Promise<ScenarioResult> }[] = [
    { id: "1", run: () => scenario1(h) },
    { id: "2", run: () => scenario2(h) },
    { id: "3", run: () => scenario3(h) },
  ];

  const selected = only ? all.filter((s) => s.id === only) : all;
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
