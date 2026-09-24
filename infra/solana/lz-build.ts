#!/usr/bin/env tsx
/**
 * Builds LayerZero's Solana endpoint and `simple-messagelib` from source, for the local
 * validator.
 *
 *   npm run solana:lz-build
 *
 * The local validator needs both programs at their canonical ids. Cloning the endpoint from
 * devnet works only where devnet is reachable, clones no message library a local relayer can
 * drive, and ties local testing to whatever build LayerZero last deployed there. Building them
 * from the commit the rest of `solana/vendor/layerzero` is pinned to removes all three
 * problems; `solana-test-validator --upgradeable-program` then loads each `.so` at its id
 * without needing LayerZero's keypair.
 *
 * Both live in LayerZero's anchor-0.29 program tree, which pins Rust 1.75: newer compilers
 * reject a transitive `ahash` that uses the removed `stdsimd` feature. Hence
 * `--tools-version v1.41`, the platform-tools release that ships Rust 1.75.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../lib/logger.js";
import { repoRoot } from "../lib/root.js";

const COMMIT = readFileSync(resolve("solana/vendor/layerzero/COMMIT"), "utf8").trim();
const REPO = "https://github.com/LayerZero-Labs/LayerZero-v2";
const TREE = "packages/layerzero-v2/solana/programs";
const SRC = resolve(repoRoot(), ".localnet-solana/lz-src");
export const LZ_PROGRAMS_DIR = resolve(repoRoot(), ".localnet-solana/lz-programs");
const PLATFORM_TOOLS = "v1.41";

/** Program crate → the `.so` name `cargo build-sbf` produces. */
const PROGRAMS = [
  ["endpoint", "endpoint.so"],
  ["simple-messagelib", "simple_messagelib.so"],
] as const;

function run(cmd: string, args: string[], cwd?: string): void {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function main(): void {
  log.banner(`Building LayerZero Solana programs @ ${COMMIT.slice(0, 7)}`);
  mkdirSync(LZ_PROGRAMS_DIR, { recursive: true });

  if (!existsSync(resolve(SRC, ".git"))) {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", REPO, SRC]);
    run("git", ["sparse-checkout", "set", TREE], SRC);
  }
  run("git", ["fetch", "--quiet", "origin", COMMIT], SRC);
  run("git", ["checkout", "--quiet", COMMIT], SRC);

  const tree = resolve(SRC, TREE);
  for (const [crate, so] of PROGRAMS) {
    log.step(crate);
    run("cargo-build-sbf", ["--tools-version", PLATFORM_TOOLS, "--manifest-path", `programs/${crate}/Cargo.toml`], tree);
    copyFileSync(resolve(tree, "target/deploy", so), resolve(LZ_PROGRAMS_DIR, so));
    log.ok(`${so} → ${LZ_PROGRAMS_DIR}`);
  }
  log.info("\nNext: npm run solana:up");
}

if (process.argv[1]?.endsWith("lz-build.ts")) main();
