import "server-only";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainConfig, DeploymentConfig } from "@crossstock/shared";
import { repoRoot } from "./deployments";

export interface ChainPreset {
  key: string;
  name: string;
  vm: "evm" | "svm";
  eid: number;
  environment: "local" | "testnet";
  config: ChainConfig;
}

export interface LaunchPresets {
  chains: ChainPreset[];
  pool: DeploymentConfig["pool"];
  relay: DeploymentConfig["relay"];
}

/**
 * Chains the launch wizard can offer, gathered from the repo's own configs so the wizard
 * emits exactly what the deploy pipeline accepts. A chain whose RPC is on localhost is local.
 */
export function launchPresets(): LaunchPresets {
  const dir = resolve(repoRoot(), "config");
  const chains = new Map<string, ChainPreset>();
  let pool: DeploymentConfig["pool"] | undefined;
  let relay: DeploymentConfig["relay"] | undefined;

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const cfg = JSON.parse(readFileSync(resolve(dir, f), "utf8")) as DeploymentConfig;
    if (f === "testnet.json") ({ pool, relay } = cfg);
    for (const c of [cfg.homeChain, ...cfg.mirrorChains]) {
      const environment = /127\.0\.0\.1|localhost/.test(c.rpcUrl) ? "local" : "testnet";
      const id = `${environment}:${c.key}`;
      if (chains.has(id)) continue;
      chains.set(id, { key: c.key, name: c.name, vm: c.vm ?? "evm", eid: c.eid, environment, config: c });
    }
  }
  const fallback = JSON.parse(readFileSync(resolve(dir, "localnet.json"), "utf8")) as DeploymentConfig;
  return {
    chains: [...chains.values()].sort((a, b) => a.environment.localeCompare(b.environment) || a.name.localeCompare(b.name)),
    pool: pool ?? fallback.pool,
    relay: relay ?? fallback.relay,
  };
}
