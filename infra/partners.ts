#!/usr/bin/env tsx
/**
 * Applies a config's `partners` section to a deployment that already exists, then prints what
 * each mirror now enforces. How a partner is onboarded, re-keyed or switched off: edit the
 * config and re-run — nothing is redeployed.
 *
 *   npm run partners -- --config config/localnet.json
 */
import type { Address } from "viem";
import { loadConfig, allChains, vmOf } from "./lib/config.js";
import { loadManifest } from "./lib/manifest.js";
import { buildChains } from "./lib/chains.js";
import { applyPartnersForDeployment, PARTNER_ABI } from "./lib/partners.js";
import { SolanaSwapClient } from "./solana/client.js";
import { SolanaChain } from "./solana/chain.js";
import { log } from "./lib/logger.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config") ?? "config/localnet.json");
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No manifest for "${cfg.name}" — deploy it first.`);
  if (!cfg.partners) throw new Error(`${arg("config")} has no "partners" section to apply.`);
  const evm = buildChains(allChains(cfg).filter((c) => vmOf(c) === "evm"));

  log.banner(`Partners — ${cfg.name}`);
  await applyPartnersForDeployment(cfg, manifest, evm);

  log.banner("Now enforced");
  for (const [key, c] of Object.entries(manifest.chains)) {
    const request = c.contracts.SwapRequest as Address | undefined;
    if (c.role !== "mirror" || !request) continue;
    const chain = evm.get(key)!;
    const required = await chain.read<boolean>(request, PARTNER_ABI, "partnerRequired");
    const bps = await chain.read<number>(request, PARTNER_ABI, "platformFeeBps");
    log.kv(chain.name, `partners ${required ? "required" : "optional"}, platform fee ${bps} bps`);
    for (const p of cfg.partners.partners ?? []) {
      const [signer, , maxFeeBps, active] = await chain.read<readonly [Address, Address, number, boolean]>(
        request,
        PARTNER_ABI,
        "partners",
        [p.id]
      );
      log.kv(`  ${p.id} ${p.name}`, `${active ? "active" : "inactive"}, signer ${signer}, up to ${maxFeeBps} bps`);
    }
  }
  for (const c of allChains(cfg).filter((c) => vmOf(c) === "svm" && c.key !== cfg.homeChain.key)) {
    const client = new SolanaSwapClient(cfg, new SolanaChain(c));
    const s = await client.partnerSettings();
    log.kv(c.name, `partners ${s.partnerRequired ? "required" : "optional"}, platform fee ${s.platformFeeBps} bps`);
  }
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  if (process.env.DEBUG) console.error(e);
  process.exit(1);
});
