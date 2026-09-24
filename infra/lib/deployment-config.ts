import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { repoRoot } from "./root.js";
import type { DeploymentConfig } from "./types.js";

/**
 * The config that produced a deployment, found by the deployment's name.
 *
 * Configs whose `${ENV}` references are unset (an adapter config waiting for its token's
 * address, say) are skipped rather than failing the lookup for every other deployment.
 */
export function configForDeployment(name: string): { path: string; config: DeploymentConfig } | undefined {
  const dir = resolve(repoRoot(), "config");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const path = `config/${f}`;
    try {
      if ((JSON.parse(readFileSync(resolve(dir, f), "utf8")) as { name?: string }).name !== name) continue;
      return { path, config: loadConfig(path) };
    } catch {
      /* unparseable, or references an unset variable: not this deployment's usable config */
    }
  }
  return undefined;
}
