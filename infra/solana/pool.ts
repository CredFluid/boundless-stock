/**
 * The home-chain venue when Solana is the home chain: an Orca Whirlpool.
 *
 * The Solana counterpart of `infra/modules/04-pool.ts`. Uniswap V3 has no Solana deployment;
 * Whirlpools is the closest design (concentrated liquidity, ticks, fee tiers), so the same
 * config — fee tier, initial price, seed amounts, tick range — maps onto it directly.
 *
 * Locally there is no Orca deployment state, only the program (loaded by `solana:up`), so this
 * creates everything a pool needs: a WhirlpoolsConfig, a fee tier, the pool, the tick arrays
 * across the position's range, and the position. Built with Orca's own SDK.
 *
 * Every tick array in the range is initialised, not only the ones at the position's bounds:
 * a swap reads the arrays in reach of the current price, and the relay's lookup table carries
 * all of them so a delivery can name whichever three it needs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
// Anchor is CommonJS and re-exports BN through a getter that ESM named imports cannot see.
import anchor from "@coral-xyz/anchor";
const { AnchorProvider, BN, Wallet } = anchor;
import Decimal from "decimal.js";
import {
  buildWhirlpoolClient,
  PDAUtil,
  PoolUtil,
  PriceMath,
  TickUtil,
  TICK_ARRAY_SIZE,
  WhirlpoolContext,
  WhirlpoolIx,
  toTx,
} from "@orca-so/whirlpools-sdk";

import type { DeploymentConfig } from "../lib/types.js";
import type { SolanaChain } from "./chain.js";
import { WHIRLPOOL_PROGRAM_ID } from "./ids.js";
import { log } from "../lib/logger.js";

export interface SolanaPoolDeployment {
  whirlpool: string;
  config: string;
  tickSpacing: number;
  mintA: string;
  mintB: string;
  /** Start ticks of every initialised tick array, lowest first. */
  tickArrays: string[];
  position: string;
}

/**
 * Orca tick spacing for a Uniswap-style fee tier: 0.3% → 64, Orca's standard for that fee.
 * The fee itself is set explicitly on the fee tier, in hundredths of a basis point.
 */
const TICK_SPACING = 64;

/** Orca's published localnet admin key, from the vendored program source. */
const ORCA_LOCALNET_ADMIN = resolve(process.cwd(), "solana/vendor/whirlpool/src/auth/localnet/localnet-admin-keypair-0.json");

export async function deploySolanaPool(
  cfg: DeploymentConfig,
  chain: SolanaChain,
  base: { mint: PublicKey; decimals: number },
  quote: { mint: PublicKey; decimals: number }
): Promise<SolanaPoolDeployment> {
  log.step("Orca Whirlpool — pool + seed liquidity (home chain)");
  const provider = new AnchorProvider(chain.connection, new Wallet(chain.payer), { commitment: "confirmed" });
  const ctx = WhirlpoolContext.withProvider(provider, undefined, undefined, undefined, new PublicKey(WHIRLPOOL_PROGRAM_ID));
  const client = buildWhirlpoolClient(ctx);
  const payer = chain.payer.publicKey;

  // ---- config and fee tier: this deployment's own, since a local validator has none.
  //
  // Only Orca's admin keys may create a config. A localnet build accepts two published,
  // non-confidential test keys (`src/auth/admin.rs`); the first funds the config here. On
  // devnet or mainnet the pool would be created under an existing Orca config instead.
  const orcaAdmin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ORCA_LOCALNET_ADMIN, "utf8"))));
  await chain.connection.confirmTransaction(await chain.connection.requestAirdrop(orcaAdmin.publicKey, 2e9), "confirmed");
  const configKp = Keypair.generate();
  await toTx(
    ctx,
    WhirlpoolIx.initializeConfigIx(ctx.program, {
      whirlpoolsConfigKeypair: configKp,
      feeAuthority: payer,
      collectProtocolFeesAuthority: payer,
      rewardEmissionsSuperAuthority: payer,
      defaultProtocolFeeRate: 0,
      funder: orcaAdmin.publicKey,
    })
  )
    .addSigner(orcaAdmin)
    .buildAndExecute();

  const feeTierPda = PDAUtil.getFeeTier(ctx.program.programId, configKp.publicKey, TICK_SPACING);
  await toTx(
    ctx,
    WhirlpoolIx.initializeFeeTierIx(ctx.program, {
      whirlpoolsConfig: configKp.publicKey,
      feeTierPda,
      tickSpacing: TICK_SPACING,
      // Uniswap's fee tier is in hundredths of a bip (3000 = 0.3%); so is Orca's fee rate.
      defaultFeeRate: cfg.pool.feeTier,
      feeAuthority: payer,
      funder: payer,
    })
  ).buildAndExecute();
  log.ok(`config ${configKp.publicKey.toBase58()}, fee tier ${cfg.pool.feeTier / 10_000}% (tick spacing ${TICK_SPACING})`);

  // ---- the pool. Orca orders the pair by mint address; the price is B per A.
  const [mintA, mintB] = PoolUtil.orderMints(base.mint, quote.mint).map((m) => new PublicKey(m));
  const baseIsA = mintA.equals(base.mint);
  const [decA, decB] = baseIsA ? [base.decimals, quote.decimals] : [quote.decimals, base.decimals];
  const quotePerBase = new Decimal(cfg.pool.initialPrice);
  const price = baseIsA ? quotePerBase : new Decimal(1).div(quotePerBase);
  const initialTick = PriceMath.priceToInitializableTickIndex(price, decA, decB, TICK_SPACING);

  const { poolKey, tx } = await client.createPool(configKp.publicKey, mintA, mintB, TICK_SPACING, initialTick, payer);
  await tx.buildAndExecute();
  const pool = await client.getPool(poolKey);
  log.ok(`pool ${poolKey.toBase58()} at ${cfg.pool.initialPrice} ${cfg.quoteAsset.symbol}/${cfg.token.symbol}`);

  // ---- every tick array across the range
  const halfWidth = Math.floor((cfg.pool.tickHalfWidth ?? 60_000) / TICK_SPACING) * TICK_SPACING;
  const lower = TickUtil.getInitializableTickIndex(initialTick - halfWidth, TICK_SPACING);
  const upper = TickUtil.getInitializableTickIndex(initialTick + halfWidth, TICK_SPACING);
  const span = TICK_ARRAY_SIZE * TICK_SPACING;
  const starts: number[] = [];
  for (let s = TickUtil.getStartTickIndex(lower, TICK_SPACING); s <= upper; s += span) starts.push(s);
  // A handful per transaction keeps each under the size limit.
  for (let i = 0; i < starts.length; i += 4) {
    const init = await pool.initTickArrayForTicks(starts.slice(i, i + 4), payer, undefined, "fixed");
    if (init) await init.buildAndExecute();
  }
  log.ok(`${starts.length} tick arrays initialised across ticks [${lower}, ${upper}]`);

  // ---- the position, seeded with the configured amounts at the current price
  const raw = (amount: string, decimals: number) => new BN(new Decimal(amount).mul(new Decimal(10).pow(decimals)).toFixed(0));
  const baseRaw = raw(cfg.pool.baseLiquidity, base.decimals);
  const quoteRaw = raw(cfg.pool.quoteLiquidity, quote.decimals);
  const sqrtPrice = pool.getData().sqrtPrice;
  const { positionMint, tx: posTx } = await pool.openPosition(lower, upper, {
    tokenMaxA: baseIsA ? baseRaw : quoteRaw,
    tokenMaxB: baseIsA ? quoteRaw : baseRaw,
    minSqrtPrice: sqrtPrice.muln(99).divn(100),
    maxSqrtPrice: sqrtPrice.muln(101).divn(100),
  });
  await posTx.buildAndExecute();
  const refreshed = await client.getPool(poolKey, { maxAge: 0 });
  log.ok(`position ${positionMint.toBase58()}; pool liquidity ${refreshed.getData().liquidity.toString()}`);

  return {
    whirlpool: poolKey.toBase58(),
    config: configKp.publicKey.toBase58(),
    tickSpacing: TICK_SPACING,
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    tickArrays: starts.map((s) => PDAUtil.getTickArray(ctx.program.programId, poolKey, s).publicKey.toBase58()),
    position: positionMint.toBase58(),
  };
}
