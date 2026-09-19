import { parseUnits, formatUnits, type Address } from "viem";
import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { setContract, recordStep } from "../lib/manifest.js";
import { endpointOf } from "./00-endpoints.js";
import { reuse, reuseAddress } from "../lib/reuse.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 1 — home-chain token deployment.
 *
 * Deploys both assets on the home chain with their full initial supply: the stock
 * (TokenizedStock) and the quote asset (USDC). Both are LayerZero OFTs.
 *
 * WHY THE QUOTE ASSET IS OMNICHAIN TOO: a user standing on a mirror chain has to be able to
 * *pay* with something. If the quote asset only existed on the home chain, a mirror user could
 * only ever sell — they would have nothing to buy with. Making it omnichain is what enables
 * the flow this POC is actually about: buying an asset from a chain that has no market for it.
 *
 * This does not put liquidity on the mirror chain. A user's own wallet balance is not
 * liquidity: there is still no pool there, no market maker, no reserves, and no price. All
 * price discovery happens on the home chain's pool.
 *
 * Token names, symbols, decimals and supplies all come from config. Nothing here knows or
 * cares which chain it is running against.
 */
export async function deployHomeToken(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<{ token: Address; quote: Address }> {
  log.step("Module 1 — home chain token + pairing asset");

  const home = chains.get(cfg.homeChain.key)!;
  const endpoint = endpointOf(manifest, home.key);

  const supply = parseUnits(cfg.token.initialSupply, cfg.token.decimals);
  const quoteSupply = parseUnits(cfg.quoteAsset.initialSupply, cfg.quoteAsset.decimals);

  log.group(`${home.name} (home, eid ${home.eid})`);

  const tokenArtifact = forgeArtifact("TokenizedStock");
  const quoteArtifact = forgeArtifact("OmniToken");
  const adapterArtifact = forgeArtifact("OmniTokenAdapter");

  /**
   * Deploy an asset on the home chain, in one of two modes.
   *
   *   launch — mint a fresh OmniToken. The token is its own OFT handle.
   *   adapt  — the asset already exists; deploy an OmniTokenAdapter that locks it and backs
   *            representations elsewhere. Token and OFT handle are different contracts.
   *
   * Reuse-first in both modes: adding a mirror chain to a live token must never mint a second
   * home-chain token or, worse, a second lockbox.
   */
  async function deployHomeAsset(
    label: string,
    spec: { name: string; symbol: string; decimals: number; existingToken?: string },
    freshSupply: bigint,
    artifact: typeof tokenArtifact,
    tokenKey: string,
    oftKey: string
  ): Promise<{ token: Address; oft: Address }> {
    if (spec.existingToken) {
      // ADAPT: the issuer brought their own token.
      const underlying = spec.existingToken as Address;
      const code = await home.publicClient.getBytecode({ address: underlying });
      if (!code || code === "0x") {
        throw new Error(`${label}: config names an existing token at ${underlying} but there is no code there.`);
      }

      const onChainDecimals = await home.read<number>(underlying, artifact.abi, "decimals");
      if (onChainDecimals !== spec.decimals) {
        throw new Error(
          `${label}: config says ${spec.decimals} decimals but ${underlying} reports ${onChainDecimals}. ` +
            `Bridging maths depends on this, so the mismatch is refused rather than guessed at.`
        );
      }

      const existingAdapter = await reuse(manifest, home, home.key, oftKey);
      const adapter =
        existingAdapter ?? (await home.deploy(adapterArtifact, [underlying, endpoint, home.deployer]));

      log.kv(`${spec.symbol} (existing ERC-20)`, underlying);
      log.kv(`${spec.symbol} (adapter)`, adapter);
      log.kv("mode", "ADAPT — existing token locked, not replaced");
      setContract(manifest, home.key, tokenKey, underlying);
      setContract(manifest, home.key, oftKey, adapter);
      return { token: underlying, oft: adapter };
    }

    // LAUNCH: mint a fresh omnichain asset.
    const token =
      (await reuse(manifest, home, home.key, tokenKey)) ??
      (await home.deploy(artifact, [
        spec.name,
        spec.symbol,
        spec.decimals,
        endpoint,
        home.deployer,
        freshSupply,
      ]));
    log.kv(`${spec.symbol} (OFT)`, token);
    setContract(manifest, home.key, tokenKey, token);
    setContract(manifest, home.key, oftKey, token); // its own OFT handle
    return { token, oft: token };
  }

  const base = await deployHomeAsset(
    "token",
    cfg.token,
    supply,
    tokenArtifact,
    "TokenizedStock",
    "TokenizedStockOft"
  );
  const quoteAsset = await deployHomeAsset(
    "quoteAsset",
    cfg.quoteAsset,
    quoteSupply,
    quoteArtifact,
    "QuoteAsset",
    "QuoteAssetOft"
  );
  const token = base.token;
  const quote = quoteAsset.token;

  // Read back on-chain rather than trusting the constructor arguments we just passed.
  const onChainSupply = await home.read<bigint>(token, tokenArtifact.abi, "totalSupply");
  const onChainSymbol = await home.read<string>(token, tokenArtifact.abi, "symbol");
  // sharedDecimals lives on the OFT handle, which is the adapter in adapt mode.
  const sharedDecimals = await home.read<number>(base.oft, adapterArtifact.abi, "sharedDecimals");

  // On a fresh deploy this must match config exactly. On an incremental run the supply has
  // legitimately moved (pool seeding, bridging), so only the fresh case is asserted.
  const isFreshToken = onChainSupply === supply;
  if (!isFreshToken) {
    log.dim(`total supply is ${formatUnits(onChainSupply, cfg.token.decimals)} (moved since launch — expected on an incremental run)`);
  }
  log.groupEnd();

  log.ok(`${onChainSymbol} verified on-chain: ${formatUnits(onChainSupply, cfg.token.decimals)} total supply`);
  log.dim(`OFT sharedDecimals = ${sharedDecimals} (amounts are quantised to this when bridging)`);

  const mode = cfg.token.existingToken ? "adapt" : "launch";
  recordStep(manifest, "01-token", "ok", `${cfg.token.symbol} + ${cfg.quoteAsset.symbol} on ${home.key} (${mode})`);

  return { token, quote };
}
