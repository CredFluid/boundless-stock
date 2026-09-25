#!/usr/bin/env tsx
/**
 * `boundless-stock` — the command line an issuer or developer uses.
 *
 *   boundless-stock chains                               the chains a stock can be mirrored to
 *   boundless-stock deploy --mirrors base,svm-chain       issue on Solana, mirror to the chosen chains
 *   boundless-stock market                               price, supply by chain, proof of reserves
 *   boundless-stock buy --on base --spend 15000          buy on another chain, filled on Solana
 *
 * It drives the same pipeline and readers as the npm scripts, and prints only what matters. The
 * full output of each deployment step is kept in `.boundless/logs/`, and the last deployment is
 * remembered, so `market` and `buy` need no flags after `deploy`.
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits, parseUnits, type Address } from "viem";

import { loadConfig, allChains, vmOf } from "./lib/config.js";
import { buildChains } from "./lib/chains.js";
import { loadManifest } from "./lib/manifest.js";
import { measureSupply } from "./lib/omnisupply.js";
import { readHomeMarket } from "./lib/market.js";
import { forgeArtifact } from "./lib/artifacts.js";
import { repoRoot } from "./lib/root.js";
import { log } from "./lib/logger.js";
import type { ChainConfig, DeploymentConfig } from "./lib/types.js";

// ------------------------------------------------------------------------------------ output

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string | number) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1");
const dim = c("2");
const green = c("32");
const red = c("31");
const cyan = c("36");
const yellow = c("33");
const out = (s = "") => process.stdout.write(s + "\n");
const tick = green("✓");

/** The pipeline's own logger is for the npm scripts; this command prints its own summary. */
function silencePipelineLog(): void {
  for (const k of Object.keys(log) as (keyof typeof log)[]) (log as Record<string, unknown>)[k] = () => {};
}

function header(title: string, sub?: string): void {
  out();
  out(`  ${bold(title)}${sub ? "  " + dim(sub) : ""}`);
  out(`  ${dim("─".repeat(68))}`);
}

function section(title: string): void {
  out();
  out(`  ${cyan(title)}`);
}

/** A thousands-separated amount, trimmed to `frac` decimals. */
function amount(v: bigint, decimals: number, frac = 2): string {
  const [i, f = ""] = formatUnits(v, decimals).split(".");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fr = f.slice(0, frac).replace(/0+$/, "");
  return fr ? `${int}.${fr}` : int;
}

function num(n: number, frac = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
}

function bar(part: bigint, whole: bigint, width = 24): string {
  if (whole === 0n || part === 0n) return dim("·");
  const n = Math.max(1, Number((part * BigInt(width)) / whole));
  return green("█".repeat(n));
}

/** Runs `work` behind a spinner, then prints a tick (or a cross) with the elapsed time. */
async function task<T>(label: string, work: (update: (s: string) => void) => Promise<T>): Promise<T> {
  const t0 = Date.now();
  let detail = "";
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const draw = () => process.stdout.write(`\r\x1b[2K  ${cyan(frames[i++ % frames.length])} ${label}${detail ? dim("  " + detail) : ""}`);
  const timer = tty ? setInterval(draw, 80) : undefined;
  const secs = () => dim(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try {
    const r = await work((s) => (detail = s));
    if (timer) clearInterval(timer);
    process.stdout.write(tty ? `\r\x1b[2K` : "");
    out(`  ${tick} ${label}  ${secs()}`);
    return r;
  } catch (e) {
    if (timer) clearInterval(timer);
    process.stdout.write(tty ? `\r\x1b[2K` : "");
    out(`  ${red("✗")} ${label}  ${secs()}`);
    throw e;
  }
}

// ------------------------------------------------------------------------------------ args

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Every chain a stock can be mirrored to, with Solana as home: the full local set. */
const CATALOG = "config/localnet-solana-home-svm-mirror.json";
const STATE = () => resolve(repoRoot(), ".boundless");
const CURRENT = () => resolve(STATE(), "current");

/** `--config`, else the last deployment, else the full catalog. */
function currentConfig(): string {
  const explicit = arg("config");
  if (explicit) return explicit;
  if (existsSync(CURRENT())) return readFileSync(CURRENT(), "utf8").trim();
  return CATALOG;
}

/** A short name for a chain: `base` for base-sepolia, `svm-chain` for the second SVM chain. */
function alias(ch: ChainConfig): string {
  if (vmOf(ch) === "svm") return ch.key === "svm-b" ? "svm-chain" : ch.key;
  return ch.key.replace(/-(sepolia|testnet|devnet|local)$/, "");
}

function findChain(chains: ChainConfig[], want: string): ChainConfig {
  const w = want.trim().toLowerCase();
  const hit = chains.find((ch) => ch.key === w || alias(ch) === w);
  if (!hit) throw new Error(`unknown chain "${want}". Available: ${chains.map(alias).join(", ")}`);
  return hit;
}

/**
 * The deployment config for `--mirrors`: the catalog with only the chosen mirror chains, written
 * under `.boundless/configs/` and named after them, so each selection keeps its own records.
 */
function configFor(base: string, mirrors: string | undefined): string {
  if (!mirrors) return base;
  const cfg = loadConfigRaw(base);
  const chosen = mirrors.split(",").filter(Boolean).map((m) => findChain(cfg.mirrorChains, m));
  const keys = [...new Set(chosen.map((ch) => ch.key))];
  if (keys.length === 0) throw new Error("--mirrors needs at least one chain");
  cfg.mirrorChains = cfg.mirrorChains.filter((ch: ChainConfig) => keys.includes(ch.key));
  cfg.name = `boundless-${String(cfg.token.symbol).toLowerCase()}--${cfg.mirrorChains.map(alias).join("-")}`;
  const dir = resolve(STATE(), "configs");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${cfg.name}.json`);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
  return path.replace(repoRoot() + "/", "");
}

/** The config file as written, before any defaults are applied, so it can be re-written. */
function loadConfigRaw(path: string) {
  return JSON.parse(readFileSync(resolve(repoRoot(), path), "utf8"));
}

// ------------------------------------------------------------------------------------ deploy

/**
 * Milestones worth showing, recognised in the pipeline's own output. Each prints once, the
 * first time its pattern appears.
 */
const MILESTONES: [RegExp, (cfg: DeploymentConfig) => string][] = [
  [/Solana programs deployed/, () => "Programs deployed on Solana: omnichain token, orders, market relay"],
  [/Module 0 — LayerZero endpoints/, () => "Cross-chain messaging endpoints ready"],
  [/Module 2 — mirror deployment/, (cfg) => {
    const n = cfg.mirrorChains.filter((m) => vmOf(m) === "evm").length;
    return `Mirror tokens created on ${n} EVM chain${n === 1 ? "" : "s"}`;
  }],
  [/Solana mirror chain ready/, () => "Mirror tokens created on a second Solana chain"],
  [/pool \+ seed liquidity/, (cfg) => `${cfg.token.symbol} and ${cfg.quoteAsset.symbol} issued on Solana, home market opened`],
  [/Module 3 — peer wiring/, () => "Every mirror linked to the home chain"],
  [/the home-chain relay/, () => "Market relay live: every chain can trade against the home market"],
];

function run(script: string, args: string[], logFile: string, onLine?: (line: string) => void): Promise<void> {
  return new Promise((ok, fail) => {
    const file = createWriteStream(logFile, { flags: "a" });
    const p = spawn("npm", ["run", "--silent", script, "--", ...args], { cwd: repoRoot(), env: process.env });
    let buf = "";
    const feed = (chunk: Buffer) => {
      file.write(chunk);
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) onLine?.(l.replace(/\x1b\[[0-9;]*m/g, ""));
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("close", (code) => {
      file.end();
      code === 0 ? ok() : fail(new Error(`${script} failed (exit ${code}); see ${logFile}`));
    });
  });
}

async function deploy(): Promise<void> {
  const config = configFor(arg("config") ?? CATALOG, arg("mirrors"));
  const cfg = loadConfig(config);
  const logs = resolve(STATE(), "logs");
  mkdirSync(logs, { recursive: true });
  const logFile = resolve(logs, `deploy-${cfg.name}.log`);
  const svm = allChains(cfg).filter((ch) => vmOf(ch) === "svm").length;
  const evm = allChains(cfg).length - svm;

  header(`Deploying ${cfg.token.symbol}`, `${cfg.token.name} · home: Solana · ${cfg.mirrorChains.length} other chains`);
  const t0 = Date.now();

  // A deployment starts from fresh local chains: stop whatever an earlier run left up.
  await run("solana:down", [], logFile).catch(() => {});
  await run("chains:down", [], logFile).catch(() => {});
  await task(`Starting ${svm} local Solana validator${svm > 1 ? "s" : ""}`, () => run("solana:up", ["--config", config], logFile));
  await task(`Starting ${evm} local EVM chain${evm > 1 ? "s" : ""}`, () => run("chains:up", [], logFile));

  const seen = new Set<number>();
  const pending: string[] = [];
  const watch = (update: (s: string) => void) => (line: string) => {
    MILESTONES.forEach(([re, text], i) => {
      if (!seen.has(i) && re.test(line)) {
        seen.add(i);
        pending.push(text(cfg));
      }
    });
    const step = line.match(/^▸ (.+)/);
    if (step) update(step[1]);
  };
  const flush = () => {
    for (const m of pending.splice(0)) out(`      ${tick} ${m}`);
  };

  await task("Deploying programs on Solana", async (u) => {
    await run("solana:deploy", ["--config", config], logFile, watch(u));
  });
  flush();
  const targets = cfg.mirrorChains.map((m) => alias(m)).join(", ");
  await task(`Issuing ${cfg.token.symbol} on Solana and mirroring it to ${targets}`, async (u) => {
    await run("deploy", ["--config", config, "--fresh"], logFile, watch(u));
  });
  flush();

  out();
  out(`  ${bold(green("Deployed"))} in ${((Date.now() - t0) / 1000).toFixed(0)}s  ${dim("· full log: " + logFile.replace(repoRoot() + "/", ""))}`);
  writeFileSync(CURRENT(), config + "\n");
  out(`  ${dim("next:")} boundless-stock market`);
  out();
}

// ------------------------------------------------------------------------------------ chains

async function chains(): Promise<void> {
  const cfg = loadConfig(arg("config") ?? CATALOG);
  header("Chains", "Solana is home; any of these can hold a mirror");
  out(`    ${bold("solana".padEnd(14))}${cfg.homeChain.name.padEnd(26)}${dim("home: the stock and its market live here")}`);
  for (const ch of cfg.mirrorChains) {
    out(`    ${alias(ch).padEnd(14)}${ch.name.padEnd(26)}${dim(vmOf(ch) === "svm" ? "Solana chain" : "EVM chain")}`);
  }
  out();
  out(`  ${dim("deploy to some of them:")} boundless-stock deploy --mirrors ${cfg.mirrorChains.slice(0, 2).map(alias).join(",")}`);
  out();
}

// ------------------------------------------------------------------------------------ market

async function market(): Promise<void> {
  silencePipelineLog();
  const config = currentConfig();
  const cfg = loadConfig(config);
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No deployment for "${cfg.name}" yet: run boundless-stock deploy`);
  const evm = buildChains(allChains(cfg).filter((ch) => vmOf(ch) === "evm"));

  const [supply, home] = await Promise.all([measureSupply(cfg, manifest, evm), readHomeMarket(cfg, manifest, evm)]);
  const s = supply.base;
  const sym = cfg.token.symbol;
  const issued = s.total + s.inFlight;

  header(`${sym} · ${cfg.token.name}`, `home: ${cfg.homeChain.name}`);

  section("PRICE");
  if (home) {
    out(`    ${bold(num(home.price))} ${cfg.quoteAsset.symbol} per ${sym}    ${dim("from the home market on Solana")}`);
    out(`    ${dim("market depth")}  ${num(Number(home.reserves.base))} ${sym}  ·  ${num(Number(home.reserves.quote))} ${cfg.quoteAsset.symbol}`);
    out(`    ${dim("market cap  ")}  ${num((Number(formatUnits(issued, s.decimals)) * home.price), 0)} ${cfg.quoteAsset.symbol}`);
  } else {
    out(`    ${yellow("no home market found")}`);
  }

  section(`SUPPLY  ${bold(amount(issued, s.decimals))} ${sym} across ${s.rows.length} chains`);
  const rows = [...s.rows].sort((a, b) => (a.role === "home" ? -1 : b.role === "home" ? 1 : 0));
  const nameW = Math.max(...rows.map((r) => r.name.length)) + 2;
  for (const r of rows) {
    const pct = s.total === 0n ? 0 : Number((r.supply * 10000n) / s.total) / 100;
    const role = r.role === "home" ? bold("home  ") : dim("mirror");
    const pctText = r.supply > 0n && pct < 0.01 ? "<0.01%" : pct.toFixed(2) + "%";
    out(
      `    ${r.name.padEnd(nameW)}${role}  ${amount(r.supply, s.decimals).padStart(14)}  ${dim(pctText.padStart(7))}  ${bar(r.supply, s.total)}`
    );
    if (r.pool !== undefined) out(`    ${"".padEnd(nameW)}${dim(`        of which ${amount(r.pool, s.decimals)} in the home market`)}`);
  }
  out(`    ${dim("in flight between chains".padEnd(nameW + 8))}${amount(s.inFlight, s.decimals).padStart(14)}`);
  if (issued === s.expected) out(`    ${tick} conserved: every chain plus in flight equals the ${amount(s.expected, s.decimals)} issued`);
  else out(`    ${red("✗")} NOT conserved: expected ${amount(s.expected, s.decimals)}`);

  section("PROOF OF RESERVES");
  const r = cfg.token.reserves;
  if (!r) {
    out(`    ${yellow("no reserve source configured")} ${dim("(token.reserves in the config)")}`);
  } else {
    const perShare = r.tokensPerShare ?? 1;
    const backed = parseUnits(r.shares, s.decimals) * BigInt(Math.round(perShare * 1e6)) / 1_000_000n;
    const ratio = issued === 0n ? 0 : Number((backed * 1_000_000n) / issued) / 10_000;
    out(`    ${dim("shares held      ")}  ${amount(parseUnits(r.shares, 0), 0).padStart(14)}  ${dim(`${r.source}${r.asOf ? ", " + r.asOf : ""}`)}`);
    out(`    ${dim("tokens they back ")}  ${amount(backed, s.decimals).padStart(14)}  ${dim(`${perShare} ${sym} per share`)}`);
    out(`    ${dim("tokens issued    ")}  ${amount(issued, s.decimals).padStart(14)}  ${dim("measured on every chain, in flight included")}`);
    if (backed >= issued) out(`    ${tick} ${bold("fully backed")}  ${dim(`${ratio.toFixed(2)}% collateralised`)}`);
    else out(`    ${red("✗")} ${bold("under-backed")}  ${ratio.toFixed(2)}%`);
  }
  out();
}

// ------------------------------------------------------------------------------------ buy

async function buy(): Promise<void> {
  silencePipelineLog();
  const { Harness, Direction, Status } = await import("./validation/harness.js");
  const config = currentConfig();
  const spendWhole = arg("spend", "15000")!;
  const h = await Harness.create({ config });
  const evmMirrors = h.config.mirrorChains.filter((ch) => vmOf(ch) === "evm");
  if (evmMirrors.length === 0) throw new Error("this deployment has no EVM chain to buy on");
  const on = findChain(evmMirrors, arg("on") ?? alias(evmMirrors[0])).key;
  const where = h.name(on);
  const q = h.quoteSymbol;
  const t = h.tokenSymbol;
  const tokenAbi = forgeArtifact("OmniToken").abi;
  const requestAbi = forgeArtifact("SwapRequest").abi;
  const request = h.addr(on, "SwapRequest");
  const stock = h.addr(on, "TokenizedStock");
  const usdc = h.addr(on, "QuoteAsset");
  const user = h.user(on);
  const bal = (token: Address) => h.chain(on).read<bigint>(token, tokenAbi, "balanceOf", [h.userAddress]);
  const spend = parseUnits(spendWhole, h.quoteDecimals);

  header(`Buying ${t} on ${where}`, `filled on the home market on Solana`);
  if (h.relayer) await h.relayer.syncToHead();

  const evm = buildChains(allChains(h.config).filter((ch) => vmOf(ch) === "evm"));
  const home = await readHomeMarket(h.config, h.manifest, evm);
  if (!home) throw new Error("no home market found");
  out(`    ${dim("home market price")}  ${num(home.price)} ${q} per ${t}`);
  out(`    ${dim("market on " + where + ":")} ${bold("none")}`);
  out();

  await task(`Wallet on ${where} holds ${num(Number(spendWhole), 0)} ${q}`, () => h.ensureUserFunded(on, spend, "QuoteAsset"));

  const floor = parseUnits(((Number(spendWhole) / home.price) * 0.95).toFixed(h.tokenDecimals), h.tokenDecimals);
  const before = await bal(stock);
  const id = await task(`Order placed on ${where}: ${num(Number(spendWhole), 0)} ${q} for ${t}`, async () => {
    await user.write(usdc, tokenAbi, "approve", [request, spend]);
    const fee = await user.read<{ nativeFee: bigint }>(request, requestAbi, "quoteTrade", [Direction.BUY, spend, floor]);
    const next = (await user.read<bigint>(request, requestAbi, "nextRequestId")) as bigint;
    await user.write(request, requestAbi, "buy", [spend, floor], fee.nativeFee);
    return next;
  });

  const t0 = Date.now();
  const rec = await task("Crossing to Solana, filling on the home market, returning", async (u) => {
    u("order in flight");
    const { ok } = await h.waitFor("the order to settle", async () => (await h.getRequest(on, id)).status !== Status.PENDING);
    if (!ok) throw new Error("the order did not settle in time");
    return h.getRequest(on, id);
  });
  const ms = Date.now() - t0;
  const got = (await bal(stock)) - before;

  out();
  if (rec.status === Status.FILLED) {
    const px = Number(spendWhole) / Number(formatUnits(got, h.tokenDecimals));
    out(`    ${tick} ${bold(`${amount(got, h.tokenDecimals, 6)} ${t}`)} delivered to the wallet on ${where}`);
    out(`    ${dim("paid")}   ${num(px)} ${q} per ${t}   ${dim("round trip")} ${(ms / 1000).toFixed(1)}s`);
  } else {
    out(`    ${yellow("!")} order ${Status[rec.status]}: the ${q} was returned in full`);
  }
  out(`    ${dim("next:")} boundless-stock market`);
  out();
}

// ------------------------------------------------------------------------------------ main

const commands: Record<string, () => Promise<void>> = { chains, deploy, market, buy };
const cmd = process.argv[2];

if (!cmd || !commands[cmd]) {
  out();
  out(`  ${bold("boundless-stock")}  ${dim("one market for tokenized stocks, on Solana, reachable from every chain")}`);
  out();
  out(`    boundless-stock chains                             the chains a stock can be mirrored to`);
  out(`    boundless-stock deploy --mirrors <chain,chain,…>   issue on Solana, mirror to those chains`);
  out(`    boundless-stock market                             price, supply by chain, proof of reserves`);
  out(`    boundless-stock buy --on <chain> --spend <n>       buy on another chain, filled on Solana`);
  out();
  out(`  ${dim("every command also takes --config <file>; market and buy default to the last deployment")}`);
  out();
  process.exit(cmd ? 1 : 0);
}

commands[cmd]()
  .then(() => process.exit(0))
  .catch((e) => {
    out(`  ${red("✗")} ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
