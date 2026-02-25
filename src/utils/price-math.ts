import Decimal from 'decimal.js';
import type { Market } from '../types/market.js';

/**
 * Rounds down a quantity to market's allowed precision.
 * Uses market's step_size if available, otherwise uses base.max_precision.
 */
export function roundDownToMarketPrecision(quantity: Decimal, market: Market): Decimal {
  if (market.step_size) {
    const stepSize = new Decimal(market.step_size);
    if (!stepSize.isZero()) {
      return quantity.div(stepSize).floor().mul(stepSize);
    }
  }

  const maxPrecision = market.base.max_precision ?? Math.min(market.base.decimals, 6);
  const multiplier = new Decimal(10).pow(maxPrecision);
  return quantity.mul(multiplier).floor().div(multiplier);
}

/**
 * Scales up a Decimal by a given number of decimals and truncates it
 * according to the maximum precision or tick size.
 */
export function scaleUpAndTruncateToInt(
  amount: Decimal,
  decimals: number,
  maxPrecision: number,
  tickSize?: string
): Decimal {
  if (tickSize) {
    const tickSizeDecimal = new Decimal(tickSize);
    if (!tickSizeDecimal.isZero()) {
      const tickAlignedPrice = amount.div(tickSizeDecimal).floor().mul(tickSizeDecimal);
      return tickAlignedPrice.mul(new Decimal(10).pow(decimals)).floor();
    }
  }

  const effectivePrecision = maxPrecision !== undefined && maxPrecision >= 0 ? maxPrecision : decimals;
  const priceInt = amount.mul(new Decimal(10).pow(decimals));
  const truncateFactor = new Decimal(10).pow(decimals - effectivePrecision);

  if (truncateFactor.lte(1)) {
    return priceInt.floor();
  }

  return priceInt.div(truncateFactor).floor().mul(truncateFactor);
}

/**
 * Format price with appropriate decimal places based on value.
 */
export function formatPrice(price: Decimal): string {
  if (price.isZero() || price.isNaN() || !price.isFinite()) {
    return '0';
  }

  const absPrice = price.abs();
  let decimals: number;

  if (absPrice.gte(10000)) decimals = 0;
  else if (absPrice.gte(1000)) decimals = 1;
  else if (absPrice.gte(1)) decimals = 2;
  else if (absPrice.gte(0.01)) decimals = 4;
  else if (absPrice.gte(0.0001)) decimals = 6;
  else decimals = 8;

  if (absPrice.lt(1) && absPrice.gt(0)) {
    const magnitude = Math.floor(Math.log10(absPrice.toNumber()));
    const neededDecimals = -magnitude + 1;
    decimals = Math.max(decimals, Math.min(neededDecimals, 8));
  }

  const formatted = price.toFixed(decimals);
  return formatted.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * Validates that a price is valid for order calculations.
 */
export function isValidPrice(price: Decimal): boolean {
  return !price.isZero() && !price.isNaN() && price.isFinite() && price.gt(0);
}

/**
 * Round a scaled price to the market's required tick size.
 * Buy prices round down, sell prices round up.
 */
export function roundPrice(rawScaledPrice: number, market: Market, side: string): number {
  const maxPrec = market.quote.max_precision;
  const tick = Math.pow(10, market.base.decimals - maxPrec);
  if (tick <= 1) {
    return Math.round(rawScaledPrice);
  } else if (side === 'Buy') {
    return Math.floor(rawScaledPrice / tick) * tick;
  } else {
    return Math.ceil(rawScaledPrice / tick) * tick;
  }
}

/**
 * Normalize a B256 hex string (0x + 64 hex chars).
 */
export function normalizeB256(value: string): string {
  if (!value) return value;
  let hex = value.startsWith('0x') ? value.slice(2) : value;
  hex = hex.padStart(64, '0');
  return '0x' + hex;
}
