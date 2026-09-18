import { parseUnits, formatUnits, maxUint256, type Address } from "viem";
import type { DeploymentConfig, Manifest, PoolDeployment } from "../lib/types.js";
import { Chain } from "../lib/chains.js";
import { forgeArtifact, packageArtifact } from "../lib/artifacts.js";
import { setContract, recordStep, getContract } from "../lib/manifest.js";
import { priceToSqrtPriceX96, tickSpacingFor, sqrtPriceX96ToTick, nearestUsableTick } from "../lib/uniswap.js";
import { log } from "../lib/logger.js";

const UNI = {
  factory: "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json",
  pool: "@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json",
  router: "@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json",
  nfpm: "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json",
};

/**
 * MODULE 4 — pool deployment and liquidity seeding. HOME CHAIN ONLY.
 *
 * This is where the claim's counterweight gets built: the one place in the entire deployment
 * where liquidity exists. Everything the mirror chains do routes back here.
 *
 * Uniswap's own published bytecode is used rather than a reimplementation, so the price
 * discovery being proven is real V3 tick math. On a live chain the factory / router /
 * position manager already exist and come from config; locally they are deployed from the
 * same artifacts, which keeps the two environments behaviourally identical.
 */
export async function deployPool(
  cfg: DeploymentConfig,
  chains: Map<string, Chain>,
  manifest: Manifest
): Promise<PoolDeployment> {
  log.step("Module 4 — Uniswap V3 pool + seed liquidity (home chain)");

  const home = chains.get(cfg.homeChain.key)!;
  const base = getContract(manifest, home.key, "TokenizedStock") as Address;
  const quote = getContract(manifest, home.key, "QuoteAsset") as Address;

  const factoryArtifact = packageArtifact(UNI.factory);
  const routerArtifact = packageArtifact(UNI.router);
  const nfpmArtifact = packageArtifact(UNI.nfpm);
  const poolArtifact = packageArtifact(UNI.pool);

  // ---------------------------------------------------------------- infrastructure

  const uni = cfg.homeChain.uniswap ?? {};
  let weth9 = uni.weth9 as Address | undefined;
  let factory = uni.factory as Address | undefined;
  let router = uni.swapRouter as Address | undefined;
  let nfpm = uni.positionManager as Address | undefined;

  if (!factory || !router || !nfpm) {
    if (uni.deployIfMissing === false) {
      throw new Error(
        `Uniswap V3 addresses are incomplete for ${home.name} and deployIfMissing is false. ` +
          `Supply factory/swapRouter/positionManager in config, or enable deployIfMissing.`
      );
    }
    log.group(`${home.name} — deploying Uniswap V3 infrastructure`);

    if (!weth9) {
      weth9 = await home.deploy(forgeArtifact("WETH9"));
      log.kv("WETH9", weth9);
    }
    if (!factory) {
      factory = await home.deploy(factoryArtifact);
      log.kv("UniswapV3Factory", factory);
    }
    if (!router) {
      router = await home.deploy(routerArtifact, [factory, weth9]);
      log.kv("SwapRouter", router);
    }
    if (!nfpm) {
      // Descriptor is only used by tokenURI(), which nothing here calls.
      nfpm = await home.deploy(nfpmArtifact, [factory, weth9, "0x0000000000000000000000000000000000000000"]);
      log.kv("NonfungiblePositionManager", nfpm);
    }
    log.groupEnd();
  } else {
    log.ok(`Using existing Uniswap V3 deployment on ${home.name}`);
    log.kv("factory", factory);
    log.kv("router", router);
  }

  setContract(manifest, home.key, "UniswapV3Factory", factory!);
  setContract(manifest, home.key, "SwapRouter", router!);
  setContract(manifest, home.key, "NonfungiblePositionManager", nfpm!);
  if (weth9) setContract(manifest, home.key, "WETH9", weth9);

  // ---------------------------------------------------------------- price + ordering

  const { sqrtPriceX96, baseIsToken0 } = priceToSqrtPriceX96({
    priceQuotePerBase: cfg.pool.initialPrice,
    baseToken: base,
    quoteToken: quote,
    baseDecimals: cfg.token.decimals,
    quoteDecimals: cfg.quoteAsset.decimals,
  });

  const token0 = baseIsToken0 ? base : quote;
  const token1 = baseIsToken0 ? quote : base;

  log.group("pool parameters");
  log.kv("token0", `${token0} ${baseIsToken0 ? cfg.token.symbol : cfg.quoteAsset.symbol}`);
  log.kv("token1", `${token1} ${baseIsToken0 ? cfg.quoteAsset.symbol : cfg.token.symbol}`);
  log.kv("fee tier", `${cfg.pool.feeTier} (${cfg.pool.feeTier / 10000}%)`);
  log.kv("initial price", `${cfg.pool.initialPrice} ${cfg.quoteAsset.symbol} per ${cfg.token.symbol}`);
  log.kv("sqrtPriceX96", sqrtPriceX96.toString());
  log.groupEnd();

  // ---------------------------------------------------------------- create + initialize

  await home.write(nfpm! as Address, nfpmArtifact.abi, "createAndInitializePoolIfNecessary", [
    token0,
    token1,
    cfg.pool.feeTier,
    sqrtPriceX96,
  ]);

  const poolAddress = await home.read<Address>(factory! as Address, factoryArtifact.abi, "getPool", [
    token0,
    token1,
    cfg.pool.feeTier,
  ]);
  if (!poolAddress || poolAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("Pool creation reported success but the factory returns the zero address.");
  }
  log.ok(`pool deployed: ${poolAddress}`);

  // ---------------------------------------------------------------- seed liquidity

  const baseAmount = parseUnits(cfg.pool.baseLiquidity, cfg.token.decimals);
  const quoteAmount = parseUnits(cfg.pool.quoteLiquidity, cfg.quoteAsset.decimals);
  const amount0Desired = baseIsToken0 ? baseAmount : quoteAmount;
  const amount1Desired = baseIsToken0 ? quoteAmount : baseAmount;

  const erc20Abi = forgeArtifact("USDCMock").abi;
  await home.write(base, erc20Abi, "approve", [nfpm, maxUint256]);
  await home.write(quote, erc20Abi, "approve", [nfpm, maxUint256]);

  const spacing = tickSpacingFor(cfg.pool.feeTier);
  const currentTick = sqrtPriceX96ToTick(sqrtPriceX96);
  const halfWidth = cfg.pool.tickHalfWidth ?? 60000;
  const tickLower = nearestUsableTick(currentTick - halfWidth, spacing);
  const tickUpper = nearestUsableTick(currentTick + halfWidth, spacing);

  log.group("seeding liquidity");
  log.kv("current tick", String(currentTick));
  log.kv("range", `[${tickLower}, ${tickUpper}]`);
  log.kv("base offered", `${cfg.pool.baseLiquidity} ${cfg.token.symbol}`);
  log.kv("quote offered", `${cfg.pool.quoteLiquidity} ${cfg.quoteAsset.symbol}`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const mintReceipt = await home.write(nfpm! as Address, nfpmArtifact.abi, "mint", [
    {
      token0,
      token1,
      fee: cfg.pool.feeTier,
      tickLower,
      tickUpper,
      amount0Desired,
      amount1Desired,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: home.deployer,
      deadline,
    },
  ]);
  log.groupEnd();

  // ---------------------------------------------------------------- read back reality

  const slot0 = await home.read<readonly [bigint, number, ...unknown[]]>(poolAddress, poolArtifact.abi, "slot0");
  const liquidity = await home.read<bigint>(poolAddress, poolArtifact.abi, "liquidity");
  const baseReserve = await home.read<bigint>(base, erc20Abi, "balanceOf", [poolAddress]);
  const quoteReserve = await home.read<bigint>(quote, erc20Abi, "balanceOf", [poolAddress]);

  if (liquidity === 0n) {
    throw new Error("Pool was created but reports zero liquidity — seeding did not take effect.");
  }

  log.ok("pool live, reserves confirmed on-chain");
  log.kv("pool", poolAddress);
  log.kv("liquidity (L)", liquidity.toString());
  log.kv("reserve base", `${formatUnits(baseReserve, cfg.token.decimals)} ${cfg.token.symbol}`);
  log.kv("reserve quote", `${formatUnits(quoteReserve, cfg.quoteAsset.decimals)} ${cfg.quoteAsset.symbol}`);
  log.kv("mint gas used", mintReceipt.gasUsed.toString());

  const poolDeployment: PoolDeployment = {
    address: poolAddress,
    token0,
    token1,
    feeTier: cfg.pool.feeTier,
    initialPrice: cfg.pool.initialPrice,
    sqrtPriceX96: slot0[0].toString(),
    liquidity: liquidity.toString(),
    reserves: {
      base: formatUnits(baseReserve, cfg.token.decimals),
      quote: formatUnits(quoteReserve, cfg.quoteAsset.decimals),
    },
  };

  manifest.pool = poolDeployment;
  setContract(manifest, home.key, "Pool", poolAddress);
  recordStep(manifest, "04-pool", "ok", `L=${liquidity}`);

  return poolDeployment;
}
