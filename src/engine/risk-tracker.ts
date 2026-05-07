/**
 * RiskTracker — small helpers for daily-loss bookkeeping, mid-price history
 * (used for realized-vol calc), and consecutive-failure / auto-pause request state.
 *
 * These are split out of strategy-executor.ts so the executor stays focused on
 * order placement. The executor instantiates a single RiskTracker and threads it
 * through each cycle.
 */

/**
 * Compute the start-of-window epoch ms for the given UTC reset hour.
 * If `now` is before today's reset hour, the window started yesterday at that hour.
 */
export function computeDailyWindowStart(now: number, resetUtcHour: number): number {
  const d = new Date(now);
  const todayResetUtc = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    resetUtcHour,
    0,
    0,
    0,
  );
  if (now >= todayResetUtc) return todayResetUtc;
  // Window actually started yesterday at the reset hour
  return todayResetUtc - 24 * 60 * 60 * 1000;
}

/**
 * In-memory rolling mid-price history per market for realized-vol calculations.
 * We keep at most `maxLen` samples and compute simple stddev of returns.
 */
export class MidPriceHistory {
  private buffers: Map<string, number[]> = new Map();
  private maxLen: number;

  constructor(maxLen = 240) {
    this.maxLen = maxLen;
  }

  push(marketId: string, mid: number): void {
    if (!Number.isFinite(mid) || mid <= 0) return;
    let buf = this.buffers.get(marketId);
    if (!buf) {
      buf = [];
      this.buffers.set(marketId, buf);
    }
    buf.push(mid);
    if (buf.length > this.maxLen) buf.shift();
  }

  /**
   * Compute realized volatility (stddev of log returns) over the last `lookback` samples,
   * expressed as a percentage. Returns 0 if insufficient data.
   */
  realizedVolPercent(marketId: string, lookback: number): number {
    const buf = this.buffers.get(marketId);
    if (!buf || buf.length < 3) return 0;
    const start = Math.max(0, buf.length - lookback - 1);
    const slice = buf.slice(start);
    if (slice.length < 3) return 0;
    const returns: number[] = [];
    for (let i = 1; i < slice.length; i++) {
      const a = slice[i - 1];
      const b = slice[i];
      if (a > 0 && b > 0) returns.push(Math.log(b / a));
    }
    if (returns.length < 2) return 0;
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdev = Math.sqrt(variance);
    return stdev * 100; // convert log-return stddev to percent
  }
}

/**
 * Track consecutive order-placement failures per market. Reset on any success.
 */
export class ConsecutiveFailureTracker {
  private counts: Map<string, number> = new Map();

  recordSuccess(marketId: string): void {
    this.counts.set(marketId, 0);
  }

  recordFailure(marketId: string): number {
    const next = (this.counts.get(marketId) ?? 0) + 1;
    this.counts.set(marketId, next);
    return next;
  }

  get(marketId: string): number {
    return this.counts.get(marketId) ?? 0;
  }
}
