/**
 * Where every unit of each omnichain asset is, across every chain of every VM.
 *
 * The invariant it makes checkable, from chain state alone:
 *
 *     Σ supply on each chain  +  in flight  ==  what exists
 *
 * "In flight" is `Σ bridgedOut − Σ bridgedIn` over every OFT — `OmniToken`'s counters on EVM,
 * the same two fields CrossStock adds to the Solana OFT store — because an amount is counted out
 * when it leaves and in when it lands, never both before it has landed. "What exists" is the
 * genesis supply for a launched asset, and the underlying token's supply for an adapted one.
 *
 * Amounts from chains with different local decimals are rescaled to the finest of them, so the
 * comparison is exact.
 */
import { readFileSync, existsSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { parseUnits, type Address } from "viem";

import type { DeploymentConfig, Manifest } from "./types.js";
import { allChains, vmOf } from "./config.js";
import type { Chain } from "./chains.js";
import { forgeArtifact } from "./artifacts.js";
import { localDecimals } from "./decimals.js";
import { SolanaChain } from "../solana/chain.js";
import { solanaManifestPath } from "../solana/setup.js";

export type Side = "base" | "quote";

export interface SupplyRow {
  key: string;
  name: string;
  role: "home" | "mirror";
  vm: "evm" | "svm";
  /** This chain's share of the omnichain supply (for an adapter: its supply less what is locked). */
  supply: bigint;
  /** Held by the home pool, where there is one. Part of `supply`, not additional. */
  pool?: bigint;
  /** Locked in an adapter, backing representations elsewhere. Not part of `supply`. */
  locked?: bigint;
}

export interface AssetSupply {
  symbol: string;
  /** The decimals every figure here is expressed in. */
  decimals: number;
  rows: SupplyRow[];
  total: bigint;
  inFlight: bigint;
  /** What should exist: genesis for a launched asset, the underlying supply for an adapted one. */
  expected: bigint;
  adapted: boolean;
}

interface SolanaAsset {
  mint: string;
  oftStore: string;
  escrow: string;
  decimals: number;
  mode?: "launch" | "adapt";
}

interface SolanaFile {
  assets: { base: SolanaAsset; quote: SolanaAsset };
  pool?: { whirlpool: string };
}

/**
 * The Solana OFT store's flow counters. Layout: discriminator 8 | oft_type 1 | ld2sd 8 | mint 32 |
 * escrow 32 | endpoint 32 | bump 1 | tvl 8 | admin 32 | fee_bps 2 | paused 1 | pauser Option |
 * unpauser Option | bridged_out u128 | bridged_in u128. Borsh writes an Option as 1 byte, plus 32
 * when present, so the counters' offset depends on the two options.
 */
export function solanaOftFlow(data: Buffer): { out: bigint; in: bigint } {
  let o = 157;
  for (let i = 0; i < 2; i++) o += data[o] === 1 ? 33 : 1;
  const u128 = (at: number) => data.readBigUInt64LE(at) + (data.readBigUInt64LE(at + 8) << 64n);
  return { out: u128(o), in: u128(o + 16) };
}

export async function measureSupply(
  cfg: DeploymentConfig,
  manifest: Manifest,
  evmChains: Map<string, Chain>
): Promise<Record<Side, AssetSupply>> {
  const abi = forgeArtifact("OmniToken").abi;
  const svmChains = allChains(cfg).filter((c) => vmOf(c) === "svm");
  const out = {} as Record<Side, AssetSupply>;

  for (const [side, contract, meta] of [
    ["base", "TokenizedStock", cfg.token],
    ["quote", "QuoteAsset", cfg.quoteAsset],
  ] as const) {
    // The finest local precision anywhere, so every figure rescales up, exactly.
    const dec = Math.max(meta.decimals, ...svmChains.map((c) => localDecimals(cfg, c, side)));
    const up = (v: bigint, from: number) => v * 10n ** BigInt(dec - from);
    const rows: SupplyRow[] = [];
    let flowOut = 0n;
    let flowIn = 0n;
    let expected = parseUnits(meta.initialSupply, dec);
    let adapted = false;

    // ---- EVM chains
    for (const cd of Object.values(manifest.chains)) {
      const chain = evmChains.get(cd.key);
      const token = cd.contracts[contract] as Address | undefined;
      if (!chain || !token) continue;
      const oft = (cd.contracts[`${contract}Oft`] ?? token) as Address;
      const raw = await chain.read<bigint>(token, abi, "totalSupply");
      let supply = raw;
      let locked: bigint | undefined;
      if (oft.toLowerCase() !== token.toLowerCase()) {
        adapted = true;
        locked = await chain.read<bigint>(token, abi, "balanceOf", [oft]);
        supply -= locked;
        expected = up(raw, meta.decimals);
      }
      const poolAddr = manifest.pool?.address as Address | undefined;
      const pool =
        cd.role === "home" && poolAddr?.startsWith("0x") ? await chain.read<bigint>(token, abi, "balanceOf", [poolAddr]) : undefined;
      flowOut += up(await chain.read<bigint>(oft, abi, "bridgedOut"), meta.decimals);
      flowIn += up(await chain.read<bigint>(oft, abi, "bridgedIn"), meta.decimals);
      rows.push({
        key: cd.key,
        name: cd.name,
        role: cd.role,
        vm: "evm",
        supply: up(supply, meta.decimals),
        pool: pool === undefined ? undefined : up(pool, meta.decimals),
        locked: locked === undefined ? undefined : up(locked, meta.decimals),
      });
    }

    // ---- Solana chains
    for (const c of svmChains) {
      const path = solanaManifestPath(cfg, c.key);
      if (!existsSync(path)) continue;
      const file: SolanaFile = JSON.parse(readFileSync(path, "utf8"));
      const asset = file.assets[side];
      const sol = new SolanaChain(c);
      const s = (await sol.connection.getTokenSupply(new PublicKey(asset.mint))).value;
      const raw = BigInt(s.amount);
      let supply = raw;
      let locked: bigint | undefined;
      if (asset.mode === "adapt") {
        adapted = true;
        locked = BigInt((await sol.connection.getTokenAccountBalance(new PublicKey(asset.escrow))).value.amount);
        supply -= locked;
        expected = up(raw, s.decimals);
      }
      let pool: bigint | undefined;
      if (file.pool) {
        // The Whirlpool's vault for this mint: mint A at 101, vault A at 133; mint B at 181, vault B at 213.
        const d = (await sol.connection.getAccountInfo(new PublicKey(file.pool.whirlpool)))!.data;
        const vault = new PublicKey(d.subarray(101, 133)).toBase58() === asset.mint ? d.subarray(133, 165) : d.subarray(213, 245);
        pool = BigInt((await sol.connection.getTokenAccountBalance(new PublicKey(vault))).value.amount);
      }
      const flow = solanaOftFlow((await sol.connection.getAccountInfo(new PublicKey(asset.oftStore)))!.data);
      flowOut += up(flow.out, s.decimals);
      flowIn += up(flow.in, s.decimals);
      rows.push({
        key: c.key,
        name: c.name,
        role: c.key === cfg.homeChain.key ? "home" : "mirror",
        vm: "svm",
        supply: up(supply, s.decimals),
        pool: pool === undefined ? undefined : up(pool, s.decimals),
        locked: locked === undefined ? undefined : up(locked, s.decimals),
      });
    }

    out[side] = {
      symbol: meta.symbol,
      decimals: dec,
      rows,
      total: rows.reduce((a, r) => a + r.supply, 0n),
      inFlight: flowOut - flowIn,
      expected,
      adapted,
    };
  }
  return out;
}
