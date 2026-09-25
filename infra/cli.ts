#!/usr/bin/env tsx
/**
 * `crossstock` — the command line an issuer or developer uses.
 *
 *   crossstock deploy --config <file>                 bring a deployment up, step by step
 *   crossstock market --config <file>                 price, supply by chain, proof of reserves
 *   crossstock buy    --config <file> --on <chain> --spend <USDC>
 *                                                     buy on another chain, filled on the home market
 *
 * It drives the same pipeline and readers as the npm scripts, and prints only what matters. The
 * full output of each deployment step is kept in `.crossstock/logs/`.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
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
import type { DeploymentConfig } from "./lib/types.js";

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

const DEFAULT_CONFIG = "config/localnet-solana-home-svm-mirror.json";

// ------------------------------------------------------------------------------------ deploy

/**
 * Milestones worth showing, recognised in the pipeline's own output. Each prints once, the
 * first time its pattern appears.
 */
const MILESTONES: [RegExp, (cfg: DeploymentConfig) => string][] = [
  [/Solana programs deployed/, () => "Programs deployed on Solana: omnichain token, orders, market relay"],
  [/Module 0 — LayerZero endpoints/, () => "Cross-chain messaging endpoints ready"],
  [/Module 2 — mirror deployment/, (cfg) => `Mirror tokens created on ${cfg.mirrorChains.filter((m) => vmOf(m) === "evm").length} EVM chains`],
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
  const config = arg("config", DEFAULT_CONFIG)!;
  const cfg = loadConfig(config);
  const logs = resolve(repoRoot(), ".crossstock/logs");
  mkdirSync(logs, { recursive: true });
  const logFile = resolve(logs, `deploy-${cfg.name}.log`);
  const svm = allChains(cfg).filter((ch) => vmOf(ch) === "svm").length;
  const evm = allChains(cfg).length - svm;

  header(`Deploying ${cfg.token.symbol}`, `${cfg.token.name} · home: Solana · ${cfg.mirrorChains.length} other chains`);
  const t0 = Date.now();

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
  await task(`Issuing ${cfg.token.symbol} on Solana and mirroring it to every chain`, async (u) => {
    await run("deploy", ["--config", config, "--fresh"], logFile, watch(u));
  });
  flush();

  out();
  out(`  ${bold(green("Deployed"))} in ${((Date.now() - t0) / 1000).toFixed(0)}s  ${dim("· full log: " + logFile.replace(repoRoot() + "/", ""))}`);
  out(`  ${dim("next:")} crossstock market --config ${config}`);
  out();
}

// ------------------------------------------------------------------------------------ market

async function market(): Promise<void> {
  silencePipelineLog();
  const config = arg("config", DEFAULT_CONFIG)!;
  const cfg = loadConfig(config);
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No deployment for "${cfg.name}" yet: run crossstock deploy --config ${config}`);
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
  const config = arg("config", DEFAULT_CONFIG)!;
  const spendWhole = arg("spend", "15000")!;
  const h = await Harness.create({ config });
  const on = arg("on", h.mirrorKeys[0])!;
  if (!h.mirrorKeys.includes(on)) {
    throw new Error(`--on must be one of the EVM mirror chains: ${h.mirrorKeys.join(", ")}`);
  }
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
  out(`    ${dim("next:")} crossstock market --config ${config}`);
  out();
}

// ------------------------------------------------------------------------------------ main

const commands: Record<string, () => Promise<void>> = { deploy, market, buy };
const cmd = process.argv[2];

if (!cmd || !commands[cmd]) {
  out();
  out(`  ${bold("crossstock")}  ${dim("one market for tokenized stocks, on Solana, reachable from every chain")}`);
  out();
  out(`    crossstock deploy --config <file>                         bring a deployment up`);
  out(`    crossstock market --config <file>                         price, supply by chain, proof of reserves`);
  out(`    crossstock buy    --config <file> --on <chain> --spend <n>  buy on another chain`);
  out();
  process.exit(cmd ? 1 : 0);
}

commands[cmd]()
  .then(() => process.exit(0))
  .catch((e) => {
    out(`  ${red("✗")} ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
