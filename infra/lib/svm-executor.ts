import type { ChainConfig } from "./types.js";

/**
 * Defaults for what a message to a Solana chain costs and asks for. See `SvmConfig` for each
 * field; these suit the local validator and are overridable per chain.
 */
export const SVM_DEFAULTS = {
  localMessageLibFeeLamports: 50_000,
  lzReceiveComputeUnits: 400_000,
  lzReceiveValueLamports: 2_500_000,
  lzComposeComputeUnits: 600_000,
  maxReturnFeeLamports: 5_000_000,
} as const;

/** Executor settings for messages delivered to `chain`, a Solana chain. */
export function svmExecutor(chain: ChainConfig): {
  lzReceiveComputeUnits: bigint;
  lzReceiveValueLamports: bigint;
  lzComposeComputeUnits: bigint;
} {
  const e = chain.svm?.executor ?? {};
  return {
    lzReceiveComputeUnits: BigInt(e.lzReceiveComputeUnits ?? SVM_DEFAULTS.lzReceiveComputeUnits),
    lzReceiveValueLamports: BigInt(e.lzReceiveValueLamports ?? SVM_DEFAULTS.lzReceiveValueLamports),
    lzComposeComputeUnits: BigInt(e.lzComposeComputeUnits ?? SVM_DEFAULTS.lzComposeComputeUnits),
  };
}

export function localMessageLibFee(chain: ChainConfig): bigint {
  return BigInt(chain.svm?.localMessageLibFeeLamports ?? SVM_DEFAULTS.localMessageLibFeeLamports);
}

export function maxReturnFee(chain: ChainConfig): bigint {
  return BigInt(chain.svm?.maxReturnFeeLamports ?? SVM_DEFAULTS.maxReturnFeeLamports);
}
