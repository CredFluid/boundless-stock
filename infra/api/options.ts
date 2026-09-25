import { parseEther, type Hex } from "viem";
import { Options } from "../lib/options.js";
import type { DeploymentConfig } from "../lib/types.js";

/**
 * Executor options for an order's leg from a Solana mirror to the home chain. An EVM mirror's
 * `SwapRequest` builds its own from `setGasParams`; a Solana order carries them in the
 * transaction, so the API supplies the deployment's figures. The compose value funds the
 * relay's return leg.
 */
export function solanaOrderOptions(cfg: DeploymentConfig): Hex {
  return Options.new()
    .addExecutorLzReceive(BigInt(cfg.relay.homeLzReceiveGas))
    .addExecutorLzCompose(0, BigInt(cfg.relay.homeComposeGas), parseEther(cfg.relay.homeComposeValue))
    .build();
}
