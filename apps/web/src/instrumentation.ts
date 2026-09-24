import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runs once when the server starts. The infra resolves every path (deployments, configs,
 * keys, artifacts) against `CROSSSTOCK_ROOT`; point it at the monorepo root, since the web
 * server runs from apps/web.
 */
export function register(): void {
  if (process.env.CROSSSTOCK_ROOT) return;
  for (const c of [resolve(process.cwd(), "../.."), process.cwd()]) {
    if (existsSync(resolve(c, "deployments")) && existsSync(resolve(c, "infra"))) {
      process.env.CROSSSTOCK_ROOT = c;
      return;
    }
  }
}
