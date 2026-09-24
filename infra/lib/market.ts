/**
 * Live readings of a deployment's home chain: its market (price and depth) and its relay's
 * holdings. EVM homes read a Uniswap V3 pool and SwapRelay; Solana homes read an Orca
 * Whirlpool and `swap_relay`.
 */
import { existsSync, readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { formatUnits, parseAbi, type Address } from "viem";

import type { Chain } from "./chains.js";
import { forgeArtifact } from "./artifacts.js";
import { vmOf } from "./config.js";
import type { DeploymentConfig, Manifest } from "./types.js";
import { SolanaChain } from "../solana/chain.js";
import { solanaManifestPath } from "../solana/setup.js";
import { ataOf } from "../solana/client.js";
import { relayStoreAddress, type SolanaHomeDeployment } from "../solana/home.js";

export interface HomeMarket {
  venue: "Uniswap V3" | "Orca Whirlpool";
  /** Quote per unit of the asset, at the current pool price. */
  price: number;
  /** The pool's active liquidity, as the venue reports it (raw). */
  liquidity: string;
  /** What the pool holds of each asset, in whole units. */
  reserves: { base: string; quote: string };
  feeTierPct: number;
}

export interface RelayHealth {
  /** The relay's native balance, which pays for return legs: ETH on EVM, SOL on Solana. */
  native: string;
  nativeSymbol: string;
  /** Tokens the relay holds. Zero at rest; anything else is in flight or stranded. */
  holds: { base: string; quote: string };
}

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);

const u128 = (d: Buffer, at: number) => d.readBigUInt64LE(at) + (d.readBigUInt64LE(at + 8) << 64n);

export async function readHomeMarket(cfg: DeploymentConfig, manifest: Manifest, evm: Map<string, Chain>): Promise<HomeMarket | undefined> {
  if (vmOf(cfg.homeChain) === "svm") {
    const home = solanaHome(cfg);
    if (!home?.pool) return undefined;
    const sol = new SolanaChain(cfg.homeChain);
    const d = (await sol.connection.getAccountInfo(new PublicKey(home.pool.whirlpool)))!.data;
    // Whirlpool: liquidity u128 @49, sqrt_price u128 @65 (Q64.64), mint A @101, vault A @133, vault B @213
    const baseIsA = new PublicKey(d.subarray(101, 133)).toBase58() === home.assets.base.mint;
    const [decA, decB] = baseIsA
      ? [home.assets.base.decimals, home.assets.quote.decimals]
      : [home.assets.quote.decimals, home.assets.base.decimals];
    const sqrt = Number(u128(d, 65)) / 2 ** 64;
    const bPerA = sqrt * sqrt * 10 ** (decA - decB);
    const [vaultA, vaultB] = [new PublicKey(d.subarray(133, 165)), new PublicKey(d.subarray(213, 245))];
    const [balA, balB] = await Promise.all([vaultA, vaultB].map((v) => sol.connection.getTokenAccountBalance(v)));
    return {
      venue: "Orca Whirlpool",
      price: baseIsA ? bPerA : 1 / bPerA,
      liquidity: u128(d, 49).toString(),
      reserves: baseIsA
        ? { base: balA.value.uiAmountString ?? "0", quote: balB.value.uiAmountString ?? "0" }
        : { base: balB.value.uiAmountString ?? "0", quote: balA.value.uiAmountString ?? "0" },
      feeTierPct: cfg.pool.feeTier / 10_000,
    };
  }

  const chain = evm.get(cfg.homeChain.key);
  const pool = manifest.pool?.address as Address | undefined;
  const c = manifest.chains[cfg.homeChain.key]?.contracts;
  if (!chain || !pool || !c) return undefined;
  const [slot0, liquidity, token0] = await Promise.all([
    chain.read<readonly [bigint, number]>(pool, POOL_ABI, "slot0"),
    chain.read<bigint>(pool, POOL_ABI, "liquidity"),
    chain.read<Address>(pool, POOL_ABI, "token0"),
  ]);
  const baseIs0 = token0.toLowerCase() === c.TokenizedStock.toLowerCase();
  const [dec0, dec1] = baseIs0
    ? [cfg.token.decimals, cfg.quoteAsset.decimals]
    : [cfg.quoteAsset.decimals, cfg.token.decimals];
  const sqrt = Number(slot0[0]) / 2 ** 96;
  const p1per0 = sqrt * sqrt * 10 ** (dec0 - dec1);
  const erc20 = forgeArtifact("OmniToken").abi;
  const [rb, rq] = await Promise.all([
    chain.read<bigint>(c.TokenizedStock as Address, erc20, "balanceOf", [pool]),
    chain.read<bigint>(c.QuoteAsset as Address, erc20, "balanceOf", [pool]),
  ]);
  return {
    venue: "Uniswap V3",
    price: baseIs0 ? p1per0 : 1 / p1per0,
    liquidity: liquidity.toString(),
    reserves: { base: formatUnits(rb, cfg.token.decimals), quote: formatUnits(rq, cfg.quoteAsset.decimals) },
    feeTierPct: cfg.pool.feeTier / 10_000,
  };
}

export async function readRelayHealth(cfg: DeploymentConfig, manifest: Manifest, evm: Map<string, Chain>): Promise<RelayHealth | undefined> {
  if (vmOf(cfg.homeChain) === "svm") {
    const home = solanaHome(cfg);
    if (!home) return undefined;
    const sol = new SolanaChain(cfg.homeChain);
    const store = relayStoreAddress(new PublicKey(home.programs.swapRelay));
    const held = async (mint: string) => {
      try {
        return (await sol.connection.getTokenAccountBalance(ataOf(store, new PublicKey(mint)))).value.uiAmountString ?? "0";
      } catch {
        return "0";
      }
    };
    return {
      native: formatUnits(BigInt(await sol.connection.getBalance(store)), 9),
      nativeSymbol: "SOL",
      holds: { base: await held(home.assets.base.mint), quote: await held(home.assets.quote.mint) },
    };
  }

  const chain = evm.get(cfg.homeChain.key);
  const c = manifest.chains[cfg.homeChain.key]?.contracts;
  if (!chain || !c?.SwapRelay) return undefined;
  const relay = c.SwapRelay as Address;
  const erc20 = forgeArtifact("OmniToken").abi;
  const [native, b, q] = await Promise.all([
    chain.publicClient.getBalance({ address: relay }),
    chain.read<bigint>(c.TokenizedStock as Address, erc20, "balanceOf", [relay]),
    chain.read<bigint>(c.QuoteAsset as Address, erc20, "balanceOf", [relay]),
  ]);
  return {
    native: formatUnits(native, 18),
    nativeSymbol: cfg.homeChain.nativeSymbol ?? "ETH",
    holds: { base: formatUnits(b, cfg.token.decimals), quote: formatUnits(q, cfg.quoteAsset.decimals) },
  };
}

export function solanaHome(cfg: DeploymentConfig): SolanaHomeDeployment | undefined {
  const path = solanaManifestPath(cfg, cfg.homeChain.key);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SolanaHomeDeployment) : undefined;
}
