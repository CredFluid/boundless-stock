#!/usr/bin/env tsx
/**
 * Supply report — where every unit of each omnichain asset currently lives.
 *
 * The question this answers, which comes up immediately for anyone operating an omnichain
 * token: "my home chain says totalSupply is less than I minted — where did the rest go?"
 *
 * An OFT's `totalSupply()` is **per chain**, not global. A bridge burns on the source and
 * mints on the destination, so each chain's figure is just the portion currently sitting
 * there. Only the sum across the whole chain set is invariant — and even that dips while a
 * message is in flight, because the tokens have been burned on the source and not yet minted
 * on the destination.
 *
 *   npm run supply -- --config config/localnet.json
 */
import { formatUnits, type Address } from "viem";
import { loadConfig, allChains } from "./lib/config.js";
import { buildChains } from "./lib/chains.js";
import { loadManifest } from "./lib/manifest.js";
import { forgeArtifact } from "./lib/artifacts.js";
import { log } from "./lib/logger.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const cfg = loadConfig(arg("config", "config/localnet.json"));
  const manifest = loadManifest(cfg.name);
  if (!manifest) throw new Error(`No manifest for "${cfg.name}" — run the deployment first.`);

  const chains = buildChains(allChains(cfg));
  const abi = forgeArtifact("OmniToken").abi;

  log.banner(`Supply report — ${manifest.name}`);

  for (const [contract, meta] of [
    ["TokenizedStock", manifest.token],
    ["QuoteAsset", manifest.quoteAsset],
  ] as const) {
    log.step(`${meta.name} (${meta.symbol}) — minted ${meta.initialSupply} at launch`);

    let total = 0n;
    let adapted = false;
    const rows: { name: string; role: string; supply: bigint; pool?: bigint; note?: string }[] = [];

    for (const cd of Object.values(manifest.chains)) {
      const chain = chains.get(cd.key);
      if (!chain) continue;
      const addr = cd.contracts[contract] as Address | undefined;
      const oftAddr = cd.contracts[`${contract}Oft`] as Address | undefined;
      if (!addr) continue;

      // ADAPTED ASSET. The token's own totalSupply on this chain includes every coin that has
      // never been near this system, so it is NOT the omnichain figure. What backs the mirror
      // chains is the amount locked in the adapter.
      const isAdapter = !!oftAddr && oftAddr.toLowerCase() !== addr.toLowerCase();
      let counted: bigint;
      let note: string | undefined;

      counted = await chain.read<bigint>(addr, abi, "totalSupply");
      if (isAdapter) {
        adapted = true;
        const locked = await chain.read<bigint>(addr, abi, "balanceOf", [oftAddr!]);
        counted -= locked; // backing representations that live on other chains
        note =
          `${formatUnits(locked, meta.decimals)} locked in the adapter, backing the ` +
          `representations on other chains`;
      }
      total += counted;

      const poolAddr = manifest.pool?.address as Address | undefined;
      const inPool =
        cd.role === "home" && poolAddr
          ? await chain.read<bigint>(addr, abi, "balanceOf", [poolAddr])
          : undefined;

      rows.push({ name: cd.name, role: cd.role, supply: counted, pool: inPool, note });
    }

    for (const r of rows) {
      const pct = total === 0n ? 0 : Number((r.supply * 10000n) / total) / 100;
      log.kv(
        `${r.name} (${r.role})`,
        `${formatUnits(r.supply, meta.decimals).padStart(22)} ${meta.symbol}  ${pct.toFixed(2).padStart(6)}%` +
          (r.pool !== undefined ? `   [pool holds ${formatUnits(r.pool, meta.decimals)}]` : "")
      );
      if (r.note) log.dim(`      ${r.note}`);
    }

    log.kv("ACROSS ALL CHAINS", `${formatUnits(total, meta.decimals)} ${meta.symbol}`);
    if (adapted) {
      log.dim("ADAPTED asset: the home figure excludes what is locked in the adapter, because that");
      log.dim("backing already appears as representations on the other chains. Summing raw");
      log.dim("totalSupply would double-count it.");
    } else {
      log.dim("this sum is the invariant — individual chains rise and fall as users bridge");
    }
  }
}

main().catch((e) => {
  log.fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
