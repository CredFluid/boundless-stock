#!/usr/bin/env node
// Runs the TypeScript CLI in infra/ through tsx, from wherever the command is called.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tsx = createRequire(resolve(root, "package.json")).resolve("tsx/cli");
const r = spawnSync(process.execPath, [tsx, resolve(root, "infra/cli.ts"), ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
});
process.exit(r.status ?? 1);
