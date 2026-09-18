import { Harness, type ScenarioResult } from "./harness.js";
import { scenario2 } from "./02-swap-roundtrip.js";
import { log } from "../lib/logger.js";

/**
 * SCENARIO 5 — multi-mirror check.
 *
 * Repeats the core proof against a SECOND mirror chain.
 *
 * The point is not that a second swap works — it is that the infra's per-chain wiring
 * generalises. A deployment pipeline can very easily be accidentally correct for the first
 * chain it was tested against: an address cached from the first loop iteration, a peer written
 * in one direction only, a gas parameter set once instead of per chain. None of those show up
 * until a second chain is exercised, and all of them are cheap to introduce.
 *
 * This scenario reuses scenario 2 verbatim, pointed at a different mirror. That reuse is
 * itself part of the check: if the second chain needed different test code, the infra would
 * not actually be generalising.
 */
export async function scenario5(h: Harness): Promise<ScenarioResult> {
  const mirrors = h.mirrorKeys;

  if (mirrors.length < 2) {
    return {
      name: "5. Multi-mirror check",
      passed: false,
      detail: `deployment has only ${mirrors.length} mirror chain(s); at least 2 are needed`,
      metrics: {},
      findings: ["configuration has fewer than two mirror chains"],
    };
  }

  const second = mirrors[1];
  log.banner(`Scenario 5 — repeating the core proof on a SECOND mirror: ${h.name(second)}`);
  log.info(`First mirror was ${h.name(mirrors[0])}. Same test code, different chain, no special casing.`);

  const result = await scenario2(h, second, "5");

  return {
    ...result,
    name: "5. Multi-mirror check (core proof on a second chain)",
    detail: result.passed
      ? `per-chain wiring generalises — ${result.detail}`
      : `SECOND MIRROR FAILED where the first succeeded: ${result.detail}`,
  };
}
