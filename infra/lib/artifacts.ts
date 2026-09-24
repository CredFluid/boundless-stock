import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Abi, Hex } from "viem";
import { repoRoot } from "./root.js";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

const cache = new Map<string, Artifact>();

/**
 * Loads a contract compiled by Foundry from `out/`.
 * @param name Contract name; assumes the standard `out/<Name>.sol/<Name>.json` layout.
 */
export function forgeArtifact(name: string, file = `${name}.sol`): Artifact {
  const key = `forge:${file}:${name}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const path = resolve(repoRoot(), "out", file, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Artifact not found: ${path}\nRun \`forge build\` first.`);
  }
  const json = JSON.parse(readFileSync(path, "utf8"));
  const bytecode = (json.bytecode?.object ?? json.bytecode) as Hex;
  if (!bytecode || bytecode === "0x") {
    throw new Error(`Artifact ${name} has no deployable bytecode (is it an interface or library?).`);
  }
  const artifact: Artifact = { abi: json.abi as Abi, bytecode };
  cache.set(key, artifact);
  return artifact;
}

/**
 * Loads a precompiled artifact shipped inside an npm package.
 *
 * @remarks Used for Uniswap V3, whose sources pin solc 0.7.6 and therefore cannot be compiled
 *          in the same unit as the 0.8.22 LayerZero stack. The official published bytecode is
 *          exactly what is deployed on live chains, so using it keeps the local environment
 *          faithful rather than approximating the pool with a reimplementation.
 */
export function packageArtifact(relativePath: string): Artifact {
  const key = `pkg:${relativePath}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const path = resolve(repoRoot(), "node_modules", relativePath);
  if (!existsSync(path)) throw new Error(`Package artifact not found: ${path}`);

  const json = JSON.parse(readFileSync(path, "utf8"));
  const bytecode = (json.bytecode?.object ?? json.bytecode) as Hex;
  const artifact: Artifact = { abi: json.abi as Abi, bytecode };
  cache.set(key, artifact);
  return artifact;
}
