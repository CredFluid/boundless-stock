/**
 * Uniswap V3 fixed-point helpers.
 *
 * Only the pieces the pool module needs, implemented in BigInt so there is no float rounding
 * anywhere near a price. Deliberately kept separate from the module so it can be unit-tested
 * and reasoned about on its own.
 */

export const Q96 = 2n ** 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const TICK_SPACINGS: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

/** Integer square root (Newton's method). */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) throw new Error("sqrt of negative");
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/**
 * sqrt(amount1 / amount0) * 2^96, computed without leaving integer arithmetic.
 * @param amount1 Raw units of token1.
 * @param amount0 Raw units of token0.
 */
export function encodeSqrtPriceX96(amount1: bigint, amount0: bigint): bigint {
  if (amount0 === 0n) throw new Error("encodeSqrtPriceX96: amount0 is zero");
  return sqrtBigInt((amount1 << 192n) / amount0);
}

/** Approximate tick for a sqrt price. Uses logs; only ever used to pick a range, never a price. */
export function sqrtPriceX96ToTick(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  return Math.floor(Math.log(ratio ** 2) / Math.log(1.0001));
}

/** sqrt(1.0001^tick) * 2^96. */
export function tickToSqrtPriceX96(tick: number): bigint {
  const ratio = Math.pow(1.0001, tick / 2);
  // Scale through a high-precision intermediate to keep the Q96 conversion exact enough for
  // range endpoints (a few wei of drift on a boundary is harmless; on a price it would not be).
  const scaled = BigInt(Math.floor(ratio * 1e18));
  return (scaled * Q96) / 10n ** 18n;
}

export function nearestUsableTick(tick: number, spacing: number): number {
  const rounded = Math.round(tick / spacing) * spacing;
  if (rounded < MIN_TICK) return Math.ceil(MIN_TICK / spacing) * spacing;
  if (rounded > MAX_TICK) return Math.floor(MAX_TICK / spacing) * spacing;
  return rounded;
}

export function tickSpacingFor(feeTier: number): number {
  const s = TICK_SPACINGS[feeTier];
  if (!s) throw new Error(`Unsupported Uniswap V3 fee tier: ${feeTier}. Use 100, 500, 3000 or 10000.`);
  return s;
}

/**
 * Human price (quote units per 1 base unit) -> sqrtPriceX96 in the pool's token0/token1 terms.
 *
 * Uniswap prices are always token1-per-token0 in *raw* units, and token ordering is decided by
 * address, not by which asset anyone thinks of as the quote. Getting this backwards produces a
 * pool that is live, funded, and quoting the reciprocal price — so the conversion is done in
 * one place, here.
 */
export function priceToSqrtPriceX96(params: {
  priceQuotePerBase: string;
  baseToken: string;
  quoteToken: string;
  baseDecimals: number;
  quoteDecimals: number;
}): { sqrtPriceX96: bigint; baseIsToken0: boolean } {
  const { priceQuotePerBase, baseToken, quoteToken, baseDecimals, quoteDecimals } = params;

  const baseIsToken0 = baseToken.toLowerCase() < quoteToken.toLowerCase();

  // Represent the price as an exact rational to avoid float error on values like 0.1.
  const [whole, frac = ""] = priceQuotePerBase.split(".");
  const scale = 10n ** BigInt(frac.length);
  const priceNum = BigInt(whole + frac); // price * scale
  const priceDen = scale;

  // one base unit, in raw terms
  const oneBase = 10n ** BigInt(baseDecimals);
  // the quote raw amount that one base unit is worth
  const quoteAmount = (priceNum * 10n ** BigInt(quoteDecimals)) / priceDen;

  const sqrtPriceX96 = baseIsToken0
    ? encodeSqrtPriceX96(quoteAmount, oneBase) // token0 = base, token1 = quote
    : encodeSqrtPriceX96(oneBase, quoteAmount); // token0 = quote, token1 = base

  return { sqrtPriceX96, baseIsToken0 };
}
