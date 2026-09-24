import type { ChainConfig, DeploymentConfig, TokenConfig } from "./types.js";

/**
 * Per-chain local decimals.
 *
 * An omnichain asset does not need the same decimals on every chain. LayerZero moves amounts
 * in **shared decimals** (6 for every CrossStock asset) and each chain converts to its own
 * local precision at its edge; CrossStock's order and settlement payloads follow the same rule
 * (see `SwapTypes.sol`). That freedom is what lets a Solana mirror exist at all: an SPL amount
 * is a u64, and 1,000,000 tAAPL at 18 decimals is 1e24 — five orders of magnitude past what a
 * u64 holds.
 */

/** The OFTs' cross-chain precision. Every CrossStock asset uses 6. */
export const SHARED_DECIMALS = 6;

/** Default ceiling for an SPL mint, matching SOL and most Solana tokens. */
export const SVM_DEFAULT_MAX_DECIMALS = 9;

const U64_MAX = (1n << 64n) - 1n;

export type AssetSide = "base" | "quote";

const assetOf = (cfg: DeploymentConfig, side: AssetSide): TokenConfig =>
  side === "base" ? cfg.token : cfg.quoteAsset;

/** The decimals `side`'s token uses on `chain`. */
export function localDecimals(cfg: DeploymentConfig, chain: ChainConfig, side: AssetSide): number {
  const configured = assetOf(cfg, side).decimals;
  if ((chain.vm ?? "evm") !== "svm") return configured;
  return chain.svm?.decimals?.[side] ?? Math.min(configured, SVM_DEFAULT_MAX_DECIMALS);
}

/**
 * Refuses, before anything is deployed, a decimals choice that would fail later.
 *
 * Two ways it can: local decimals below shared, which cannot represent what crosses the wire
 * (the OFT rejects it at initialisation, several steps in), and an SVM supply that overflows a
 * u64 — checked against the WHOLE supply, since every unit could legitimately end up on one
 * chain.
 */
export function validateDecimals(cfg: DeploymentConfig, chains: ChainConfig[]): void {
  for (const chain of chains) {
    for (const side of ["base", "quote"] as const) {
      const asset = assetOf(cfg, side);
      const dec = localDecimals(cfg, chain, side);
      const where = `${chain.key} ${asset.symbol}`;

      if (!Number.isInteger(dec) || dec < SHARED_DECIMALS) {
        throw new Error(
          `${where}: local decimals ${dec} are below the shared decimals (${SHARED_DECIMALS}); ` +
            `amounts crossing the bridge could not be represented.`
        );
      }
      if ((chain.vm ?? "evm") === "svm") {
        const whole = BigInt(asset.initialSupply.split(".")[0]);
        if (whole * 10n ** BigInt(dec) > U64_MAX) {
          throw new Error(
            `${where}: a supply of ${asset.initialSupply} at ${dec} decimals overflows a Solana u64. ` +
              `Set svm.decimals.${side} lower for this chain.`
          );
        }
      }
    }
  }
}
