/**
 * A deployment as a partner sees it: the mirror chains they can place orders on, the contracts
 * and tokens there, and each mirror's partner settings, read live.
 */
import type { Address } from "viem";
import type { DeploymentDescriptor, MirrorDescriptor, TokenRef } from "@crossstock/sdk";

import { localDecimals } from "../lib/decimals.js";
import { vmOf } from "../lib/config.js";
import { PARTNER_ABI } from "../lib/partners.js";
import type { ApiContext } from "./context.js";

export async function describe(ctx: ApiContext): Promise<DeploymentDescriptor> {
  const { cfg, manifest } = ctx;
  const mirrors: MirrorDescriptor[] = [];

  for (const c of Object.values(manifest.chains)) {
    if (c.role !== "mirror" || !c.contracts.SwapRequest) continue;
    const chain = ctx.evm.get(c.key);
    if (!chain) continue;
    const request = c.contracts.SwapRequest as Address;
    const [partnerRequired, platformFeeBps] = await Promise.all([
      chain.read<boolean>(request, PARTNER_ABI, "partnerRequired"),
      chain.read<number>(request, PARTNER_ABI, "platformFeeBps"),
    ]);
    const token = (contract: "TokenizedStock" | "QuoteAsset", side: "base" | "quote"): TokenRef => ({
      symbol: side === "base" ? cfg.token.symbol : cfg.quoteAsset.symbol,
      address: c.contracts[contract],
      decimals: localDecimals(cfg, chain.config, side),
    });
    mirrors.push({
      vm: "evm",
      key: c.key,
      name: c.name,
      eid: c.eid,
      chainId: c.chainId!,
      swapRequest: request,
      base: token("TokenizedStock", "base"),
      quote: token("QuoteAsset", "quote"),
      partnerRequired,
      platformFeeBps,
      eip712: { name: "CrossStock SwapRequest", version: "1", chainId: c.chainId!, verifyingContract: request },
    });
  }

  for (const [key, sol] of ctx.solana) {
    const settings = await sol.partnerSettings();
    const [b, q] = await Promise.all([sol.mintSupply("base"), sol.mintSupply("quote")]);
    mirrors.push({
      vm: "svm",
      key,
      name: sol.chain.config.name,
      eid: sol.eid,
      program: sol.program.toBase58(),
      store: sol.store.toBase58(),
      base: { symbol: cfg.token.symbol, address: sol.baseMint.toBase58(), decimals: b.decimals },
      quote: { symbol: cfg.quoteAsset.symbol, address: sol.quoteMint.toBase58(), decimals: q.decimals },
      partnerRequired: settings.partnerRequired,
      platformFeeBps: settings.platformFeeBps,
    });
  }

  const homeVm = vmOf(cfg.homeChain);
  return {
    name: cfg.name,
    environment: manifest.environment,
    asset: { name: cfg.token.name, symbol: cfg.token.symbol },
    quoteAsset: { name: cfg.quoteAsset.name, symbol: cfg.quoteAsset.symbol },
    home: {
      key: cfg.homeChain.key,
      name: cfg.homeChain.name,
      vm: homeVm,
      eid: cfg.homeChain.eid,
      venue: homeVm === "svm" ? "Orca Whirlpool" : "Uniswap V3",
    },
    mirrors,
  };
}
