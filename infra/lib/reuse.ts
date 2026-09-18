import type { Address } from "viem";
import type { Manifest } from "./types.js";
import { Chain } from "./chains.js";
import { log } from "./logger.js";

/**
 * Idempotency support for the deployment modules.
 *
 * A deployment pipeline that only works on an empty chain set is a one-shot script. The flow
 * that actually matters in production is *incremental*: a token is already launched and live,
 * and the issuer adds a new supported chain to it. That must deploy only the new pieces and
 * leave every existing address — especially the home-chain token and pool — untouched.
 *
 * So every module asks this first. The manifest is treated as a claim rather than the truth:
 * the address is only reused if there is actually code at it on that chain, which catches a
 * manifest left over from a chain that has since been reset.
 */
export async function reuse(
  manifest: Manifest,
  chain: Chain,
  chainKey: string,
  name: string
): Promise<Address | null> {
  const recorded = manifest.chains[chainKey]?.contracts[name];
  if (!recorded) return null;

  const code = await chain.publicClient.getBytecode({ address: recorded as Address });
  if (!code || code === "0x") {
    log.warn(`${chain.name}: manifest records ${name} at ${recorded} but there is no code there — redeploying`);
    return null;
  }

  log.dim(`${chain.name}: reusing existing ${name} at ${recorded}`);
  return recorded as Address;
}

/**
 * Same check as {@link reuse}, for addresses held in dedicated manifest fields rather than in
 * the `contracts` map — currently the LayerZero endpoint and its local message library.
 */
export async function reuseAddress(
  chain: Chain,
  recorded: string | undefined,
  label: string
): Promise<Address | null> {
  if (!recorded) return null;
  const code = await chain.publicClient.getBytecode({ address: recorded as Address });
  if (!code || code === "0x") {
    log.warn(`${chain.name}: manifest records ${label} at ${recorded} but there is no code there — redeploying`);
    return null;
  }
  log.dim(`${chain.name}: reusing existing ${label} at ${recorded}`);
  return recorded as Address;
}
