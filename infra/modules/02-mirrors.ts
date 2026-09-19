import type { DeploymentConfig, Manifest } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact } from "../lib/artifacts.js";
import { setContract, recordStep } from "../lib/manifest.js";
import { endpointOf } from "./00-endpoints.js";
import { reuse } from "../lib/reuse.js";
import { log } from "../lib/logger.js";

/**
 * MODULE 2 — mirror deployment.
 *
 * Loops the configured mirror chain list and deploys **both** omnichain assets on each one:
 * the stock and the quote asset. Adding a chain to the set is a config edit; there is no
 * per-chain code path here, which is the property the multi-mirror validation scenario exists
 * to confirm.
 *
 * Every mirror instance is deployed with `initialSupply = 0`. A mirror therefore starts
 * structurally empty and can only ever be credited by an inbound bridge message.
 *
 * WHAT "ZERO LIQUIDITY" MEANS HERE, PRECISELY. The mirror chain gets token *contracts*, not a
 * market. There is no pool, no market maker, no reserves and no price on a mirror chain — and
 * critically, this module never seeds anything. A user who later holds the quote asset here
 * holds it in their own wallet, having bridged it themselves; that is not liquidity, and
 * nobody on this chain can quote them a price or take the other side of their trade.
 */
export async function deployMirrorTokens(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<Record<string, { base: string; quote: string }>> {
  log.step(`Module 2 — mirror deployment (${cfg.mirrorChains.length} chains × 2 assets)`);

  const stockArtifact = forgeArtifact("TokenizedStock");
  const quoteArtifact = forgeArtifact("OmniToken");
  const deployed: Record<string, { base: string; quote: string }> = {};

  for (const mc of cfg.mirrorChains) {
    const chain = chains.get(mc.key)!;
    const endpoint = endpointOf(manifest, mc.key);

    log.group(`${mc.name} (mirror, eid ${mc.eid})`);

    const existingBase = await reuse(manifest, chain, mc.key, "TokenizedStock");
    const base =
      existingBase ??
      (await chain.deploy(stockArtifact, [
        cfg.token.name,
        cfg.token.symbol,
        cfg.token.decimals,
        endpoint,
        chain.deployer,
        0n, // empty by construction
      ]));
    log.kv(`${cfg.token.symbol} (OFT)`, base);

    const existingQuote = await reuse(manifest, chain, mc.key, "QuoteAsset");
    const quote =
      existingQuote ??
      (await chain.deploy(quoteArtifact, [
        cfg.quoteAsset.name,
        cfg.quoteAsset.symbol,
        cfg.quoteAsset.decimals,
        endpoint,
        chain.deployer,
        0n, // empty by construction
      ]));
    log.kv(`${cfg.quoteAsset.symbol} (OFT)`, quote);

    // Verify emptiness on a first deployment. On an incremental run a non-zero supply is
    // legitimate — it means users have bridged in — so only the fresh case is asserted.
    for (const [label, addr, wasExisting] of [
      [cfg.token.symbol, base, existingBase],
      [cfg.quoteAsset.symbol, quote, existingQuote],
    ] as const) {
      const supply = await chain.read<bigint>(addr, stockArtifact.abi, "totalSupply");
      if (!wasExisting && supply !== 0n) {
        throw new Error(`Mirror ${mc.name} deployed ${label} with non-zero supply ${supply}.`);
      }
      log.kv(`${label} supply`, wasExisting ? `${supply} (bridged in since launch)` : "0 (verified empty)");
    }

    setContract(manifest, mc.key, "TokenizedStock", base);
    setContract(manifest, mc.key, "QuoteAsset", quote);
    // A mirror always receives a fresh OmniToken, so each token is its own OFT handle. The
    // keys are still written so downstream code never has to special-case home vs mirror.
    setContract(manifest, mc.key, "TokenizedStockOft", base);
    setContract(manifest, mc.key, "QuoteAssetOft", quote);
    deployed[mc.key] = { base, quote };

    log.groupEnd();
    log.ok(`${mc.name}: mirror instances live — contracts only, no market`);
  }

  recordStep(manifest, "02-mirrors", "ok", `${cfg.mirrorChains.length} mirrors × 2 assets`);
  return deployed;
}
