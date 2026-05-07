import { EventEmitter } from 'events';
import type { Market } from '../types/market.js';
import type { StrategyConfig, StrategyExecutionResult, StrategyPreset } from '../types/strategy.js';
import { getPresetStrategyConfig } from '../types/strategy.js';
import type { MarketDataService } from './market-data.js';
import type { BalanceTracker } from './balance-tracker.js';
import type { OrderManager } from './order-manager.js';
import type { CompetitionTracker } from './competition-tracker.js';
import { StrategyExecutor } from './strategy-executor.js';
import { watchStrategiesDir } from '../config/strategy-loader.js';
import * as dbQueries from '../db/queries.js';

interface MarketSchedule {
  market: Market;
  config: StrategyConfig;
  nextRunAt: number;
  lastResult?: StrategyExecutionResult;
  paused: boolean;
}

export interface TradingContext {
  marketId: string;
  pair: string;
  strategy: string;
  isActive: boolean;
  lastResult?: StrategyExecutionResult;
  baseBalance: number;
  quoteBalance: number;
  currentPrice: number;
  spread: number | null;
  openOrders: number;
}

/** Pluggable boost provider (optional dependency for boost-aware scheduling). */
export interface BoostProvider {
  getBoostForMarket: (marketId: string) => number;
}

export class TradingEngine extends EventEmitter {
  private marketData: MarketDataService;
  private balanceTracker: BalanceTracker;
  private orderManager: OrderManager;
  private executor: StrategyExecutor;
  private competitionTracker?: CompetitionTracker;
  private schedules: Map<string, MarketSchedule> = new Map();
  private running = false;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;

  // Active preset name per market. Markets configured from a custom JSON
  // (no preset name) are absent from this map and skipped on hot reload.
  private currentPresetByMarket: Map<string, string> = new Map();

  // Hot-reload watcher handle (null when disabled).
  private hotReloadWatcher: { close: () => void } | null = null;

  // Optional boost provider — set via setBoostProvider() or auto-derived from competitionTracker.
  private boostProvider: BoostProvider | null = null;

  // WS-down auto-pause tracking: time when we first observed disconnection.
  private wsDownSince: number | null = null;

  constructor(
    marketData: MarketDataService,
    balanceTracker: BalanceTracker,
    orderManager: OrderManager
  ) {
    super();
    this.marketData = marketData;
    this.balanceTracker = balanceTracker;
    this.orderManager = orderManager;
    this.executor = new StrategyExecutor(orderManager, marketData, balanceTracker);
  }

  setCompetitionTracker(tracker: CompetitionTracker): void {
    this.competitionTracker = tracker;
    // If no explicit boost provider was set, derive one from the competition tracker.
    if (!this.boostProvider) {
      this.boostProvider = {
        getBoostForMarket: (marketId: string) => {
          const market = this.marketData.getMarket(marketId);
          const contractId = market?.contract_id ?? marketId;
          return tracker.getBoostForMarket(contractId);
        },
      };
    }
  }

  /** Inject an explicit boost provider (overrides the competition-tracker derived one). */
  setBoostProvider(provider: BoostProvider): void {
    this.boostProvider = provider;
  }

  addMarket(market: Market, config: StrategyConfig): void {
    this.schedules.set(market.market_id, {
      market,
      config,
      nextRunAt: Date.now(),
      paused: false,
    });
    this.emit('marketAdded', market.market_id);
  }

  removeMarket(marketId: string): void {
    this.schedules.delete(marketId);
    this.currentPresetByMarket.delete(marketId);
    this.emit('marketRemoved', marketId);
  }

  updateConfig(marketId: string, config: StrategyConfig): void {
    const schedule = this.schedules.get(marketId);
    if (schedule) {
      // Preserve runtime tracking state from old config
      config.averageBuyPrice = schedule.config.averageBuyPrice;
      config.averageSellPrice = schedule.config.averageSellPrice;
      config.lastFillPrices = schedule.config.lastFillPrices;
      schedule.config = config;
      // Persist to DB
      dbQueries.upsertStrategyConfig(marketId, config);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.emit('started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.emit('stopped');
  }

  get isRunning(): boolean {
    return this.running;
  }

  // =========================================================================
  // PER-MARKET PAUSE / RESUME
  // =========================================================================

  /** Pause a single market. Global pause/stop is unaffected. Idempotent. */
  pauseMarket(marketId: string): void {
    const schedule = this.schedules.get(marketId);
    if (!schedule) return;
    if (schedule.paused) return;
    schedule.paused = true;
    this.emit('marketPaused', marketId);
  }

  /** Resume a single market and reschedule it for the next tick. Idempotent. */
  resumeMarket(marketId: string): void {
    const schedule = this.schedules.get(marketId);
    if (!schedule) return;
    if (!schedule.paused) return;
    schedule.paused = false;
    schedule.nextRunAt = Date.now();
    this.emit('marketResumed', marketId);

    // If the global engine is running, kick the scheduler so a paused-only
    // backlog doesn't leave us idling on a 1s recheck.
    if (this.running) {
      if (this.schedulerTimer) {
        clearTimeout(this.schedulerTimer);
        this.schedulerTimer = null;
      }
      this.scheduleNext();
    }
  }

  isMarketPaused(marketId: string): boolean {
    return this.schedules.get(marketId)?.paused ?? false;
  }

  getPausedMarkets(): string[] {
    const out: string[] = [];
    for (const [id, s] of this.schedules) {
      if (s.paused) out.push(id);
    }
    return out;
  }

  // =========================================================================
  // INTROSPECTION
  // =========================================================================

  getContexts(): TradingContext[] {
    const contexts: TradingContext[] = [];
    for (const [marketId, schedule] of this.schedules) {
      const market = schedule.market;
      contexts.push({
        marketId,
        pair: `${market.base.symbol}/${market.quote.symbol}`,
        strategy: schedule.config.name || 'Custom',
        isActive: schedule.config.isActive,
        lastResult: schedule.lastResult,
        baseBalance: this.balanceTracker.getBaseBalanceHuman(marketId),
        quoteBalance: this.balanceTracker.getQuoteBalanceHuman(marketId),
        currentPrice: this.marketData.getMidPrice(marketId) || 0,
        spread: this.marketData.getSpreadPercent(marketId),
        openOrders: 0,
      });
    }
    return contexts;
  }

  getStrategyConfig(marketId: string): StrategyConfig | null {
    const schedule = this.schedules.get(marketId);
    return schedule ? schedule.config : null;
  }

  getNextRunTime(marketId: string): number | null {
    const schedule = this.schedules.get(marketId);
    if (!schedule || !schedule.config.isActive) return null;
    return schedule.nextRunAt;
  }

  /** Most recent execution result the executor returned for this market. */
  getLastExecutionResult(marketId: string): StrategyExecutionResult | undefined {
    return this.schedules.get(marketId)?.lastResult;
  }

  /** Active preset name for this market (undefined if running a custom config). */
  getStrategyPresetName(marketId: string): string | undefined {
    return this.currentPresetByMarket.get(marketId);
  }

  /**
   * Record which preset a market is currently using WITHOUT rebuilding the
   * config. Used at startup so hot-reload can map preset-file changes back to
   * the markets that need updating, without overwriting any persisted
   * customizations the user made through the editor modal or `updateConfig`.
   * Pass `undefined` to clear (mark as 'custom').
   */
  recordStrategyPresetName(marketId: string, presetName: string | undefined): void {
    if (!presetName || presetName === 'custom') {
      this.currentPresetByMarket.delete(marketId);
    } else {
      this.currentPresetByMarket.set(marketId, presetName);
    }
  }

  /**
   * Convenience wrapper: load a preset for a market and apply it via updateConfig.
   * Preserves runtime state (averageBuyPrice, lastFillPrices, dailyLossWindowStart, etc).
   */
  async setStrategyPreset(marketId: string, preset: StrategyPreset): Promise<void> {
    const schedule = this.schedules.get(marketId);
    if (!schedule) return;
    const fresh = getPresetStrategyConfig(marketId, preset);
    // Preserve runtime tracking state explicitly (updateConfig also preserves
    // averageBuyPrice/averageSellPrice/lastFillPrices, but daily-loss window is
    // not covered there — we copy it here so it survives preset switches).
    fresh.dailyLossWindowStart = schedule.config.dailyLossWindowStart;
    fresh.dailyRealizedPnl = schedule.config.dailyRealizedPnl;
    fresh.trailingPeakPrice = schedule.config.trailingPeakPrice;
    this.updateConfig(marketId, fresh);
    if (preset === 'custom') {
      this.currentPresetByMarket.delete(marketId);
    } else {
      this.currentPresetByMarket.set(marketId, preset);
    }
  }

  // =========================================================================
  // HOT RELOAD
  // =========================================================================

  /**
   * Watch the strategies directory for JSON changes. When a preset's file
   * changes, every market currently using that preset is updated in place.
   * Markets on a custom config (no preset name) are skipped.
   */
  enableHotReload(strategiesDir: string): void {
    if (this.hotReloadWatcher) return;
    this.hotReloadWatcher = watchStrategiesDir(strategiesDir, (presetName, config) => {
      for (const [marketId, currentPreset] of this.currentPresetByMarket) {
        if (currentPreset !== presetName) continue;
        const schedule = this.schedules.get(marketId);
        if (!schedule) continue;
        // Re-merge for this market: clone config and stamp the correct marketId.
        const merged: StrategyConfig = { ...config, marketId };
        this.updateConfig(marketId, merged);
        this.emit('configReloaded', marketId, presetName);
      }
    });
  }

  disableHotReload(): void {
    if (this.hotReloadWatcher) {
      this.hotReloadWatcher.close();
      this.hotReloadWatcher = null;
    }
  }

  // =========================================================================
  // SCHEDULER
  // =========================================================================

  private scheduleNext(): void {
    if (!this.running) return;

    // Run cheap per-tick auto-pause checks before deciding what to run next.
    this.runAutoPauseChecks();
    if (!this.running) return; // ws_down may have triggered a global stop

    // Build iteration order: optionally sort by boost so boosted markets get
    // first crack at being the "earliest" tick. We still pick the earliest
    // nextRunAt overall, but ties / equal-due markets prefer boosted ones.
    const ids = this.getOrderedMarketIds();

    // Find the next market to execute
    let earliest: MarketSchedule | null = null;
    let earliestId: string = '';
    const now = Date.now();

    for (const id of ids) {
      const schedule = this.schedules.get(id);
      if (!schedule) continue;
      if (!schedule.config.isActive) continue;
      if (schedule.paused) continue; // per-market pause: skip without stopping global timer
      if (!earliest || schedule.nextRunAt < earliest.nextRunAt) {
        earliest = schedule;
        earliestId = id;
      }
    }

    if (!earliest) {
      // No active markets, check again in 1s
      this.schedulerTimer = setTimeout(() => this.scheduleNext(), 1000);
      return;
    }

    const delay = Math.max(0, earliest.nextRunAt - now);
    this.schedulerTimer = setTimeout(() => this.executeMarket(earliestId), delay);
  }

  /**
   * Iterate market ids, sorted with boosted markets first when at least one
   * market opts in via `preferBoostedMarkets` and a boost provider is wired.
   * Returns Map insertion order if neither condition is met.
   */
  private getOrderedMarketIds(): string[] {
    const ids = Array.from(this.schedules.keys());
    if (!this.boostProvider) return ids;

    let anyPrefersBoost = false;
    for (const s of this.schedules.values()) {
      if (s.config.preferBoostedMarkets) { anyPrefersBoost = true; break; }
    }
    if (!anyPrefersBoost) return ids;

    const provider = this.boostProvider;
    return ids.slice().sort((a, b) => {
      const ba = provider.getBoostForMarket(a) || 0;
      const bb = provider.getBoostForMarket(b) || 0;
      return bb - ba; // descending: highest boost first
    });
  }

  private async executeMarket(marketId: string): Promise<void> {
    if (!this.running) return;

    const schedule = this.schedules.get(marketId);
    if (!schedule || !schedule.config.isActive) {
      this.scheduleNext();
      return;
    }
    if (schedule.paused) {
      // Defensive: if a market got paused between scheduling and execution, skip it.
      this.scheduleNext();
      return;
    }

    try {
      // Re-read config from DB for fresh averageBuyPrice etc
      const dbConfig = dbQueries.getStrategyConfig(marketId);
      if (dbConfig) {
        try {
          const parsed = JSON.parse(dbConfig.config);
          // Merge runtime state from DB into current config
          schedule.config.averageBuyPrice = parsed.averageBuyPrice || schedule.config.averageBuyPrice;
          schedule.config.averageSellPrice = parsed.averageSellPrice || schedule.config.averageSellPrice;
          schedule.config.lastFillPrices = parsed.lastFillPrices || schedule.config.lastFillPrices;
        } catch (err) {
          console.error(`[TradingEngine] Failed to parse DB config for ${marketId}:`, err);
        }
      }

      const result = await this.executor.execute(schedule.market, schedule.config);
      schedule.lastResult = result;
      schedule.nextRunAt = result.nextRunAt || this.calculateNextRun(schedule.config, marketId);

      this.emit('cycle', marketId, result);
    } catch (err: any) {
      this.emit('error', marketId, err);
      // Use normal cycle interval — no artificial delay on error
      schedule.nextRunAt = this.calculateNextRun(schedule.config, marketId);
    }

    this.scheduleNext();
  }

  private calculateNextRun(config: StrategyConfig, marketId?: string): number {
    const min = config.timing.cycleIntervalMinMs;
    const max = config.timing.cycleIntervalMaxMs;
    let interval = min + Math.random() * (max - min);

    if (this.competitionTracker && marketId) {
      // Boost factor: 10000 bp = 1.0x, 15000 bp = 1.5x
      const market = this.marketData.getMarket(marketId);
      const contractId = market?.contract_id ?? marketId;
      const boostBp = this.competitionTracker.getBoostForMarket(contractId);
      if (boostBp > 10000) {
        const boostMultiplier = boostBp / 10000;
        interval = interval / boostMultiplier;
      }

      // Streak urgency: reduce interval when behind on daily target
      const streak = this.competitionTracker.getStreakInfo();
      if (streak?.currentPeriodProgress && !streak.currentPeriodProgress.met) {
        const volNum = parseFloat(streak.currentPeriodProgress.volume) || 0;
        const tgtNum = parseFloat(streak.currentPeriodProgress.target) || 0;
        if (tgtNum > 0) {
          const pctDone = volNum / tgtNum;
          if (pctDone < 0.7) {
            const urgency = Math.max(0.5, 1.0 - (1.0 - pctDone) * 0.5);
            interval = interval * urgency;
          }
        }
      }
    }

    return Date.now() + Math.max(interval, 500);
  }

  // =========================================================================
  // AUTO-PAUSE MONITOR (per-tick, cheap)
  // =========================================================================

  /**
   * Cheap per-tick checks called from `scheduleNext()`. Two responsibilities:
   *   1. Drain `executor.autoPauseRequested` → per-market pause.
   *   2. Detect prolonged WS disconnection → global stop.
   * Resume from auto-pause is a manual action (we never auto-resume to avoid
   * pause/resume oscillation).
   */
  private runAutoPauseChecks(): void {
    // 1. Strategy-level auto-pause requests from the executor.
    // The executor exposes a public field; clear it after consuming.
    const exec = this.executor as unknown as {
      autoPauseRequested: { reason: string; timestamp: number } | null;
    };
    const req = exec.autoPauseRequested;
    if (req) {
      // Reset before acting so a re-trigger inside pauseMarket can be observed next tick.
      exec.autoPauseRequested = null;
      // We don't have a per-market signal from the executor field alone, so
      // pause every active market that isn't already paused. The reason is
      // shared on the event for observers.
      for (const [marketId, schedule] of this.schedules) {
        if (schedule.config.isActive && !schedule.paused) {
          this.pauseMarket(marketId);
          this.emit('autoPaused', { marketId, reason: req.reason });
          console.warn(`[TradingEngine] Auto-paused ${marketId}: ${req.reason}`);
        }
      }
    }

    // 2. WS-down detection (engine-wide). Use the strictest configured
    // threshold across markets (smallest non-zero seconds).
    let strictestSeconds: number | null = null;
    for (const s of this.schedules.values()) {
      const v = s.config.riskManagement?.autoPauseOnWsDownSeconds;
      if (v && v > 0) {
        if (strictestSeconds == null || v < strictestSeconds) strictestSeconds = v;
      }
    }

    const wsConnected = this.getWsConnected();
    const now = Date.now();
    if (!wsConnected) {
      if (this.wsDownSince == null) this.wsDownSince = now;
      if (strictestSeconds != null) {
        const elapsedSec = (now - this.wsDownSince) / 1000;
        if (elapsedSec >= strictestSeconds) {
          console.warn(`[TradingEngine] WS down ${elapsedSec.toFixed(0)}s — global stop (auto-pause)`);
          this.emit('autoPaused', { marketId: '*', reason: 'ws_down' });
          this.stop();
          // Reset the timestamp so a future reconnect+disconnect cycle re-triggers cleanly.
          this.wsDownSince = null;
        }
      }
    } else {
      this.wsDownSince = null;
    }
  }

  /** Read the WS connection flag the way the dashboard does. */
  private getWsConnected(): boolean {
    // MarketDataService holds a reference to the WS client (private), but the
    // engine is constructed with the same MarketDataService that exposes
    // connection state via depth subscriptions. We probe a best-effort
    // accessor here without coupling to a new dependency.
    const md = this.marketData as unknown as {
      wsClient?: { isConnected?: boolean };
      isWsConnected?: () => boolean;
    };
    if (typeof md.isWsConnected === 'function') {
      try { return !!md.isWsConnected(); } catch { /* fall through */ }
    }
    if (md.wsClient && typeof md.wsClient.isConnected === 'boolean') {
      return md.wsClient.isConnected;
    }
    // If we can't determine WS state, assume connected (fail-open: never
    // trigger ws_down auto-pause from a missing accessor).
    return true;
  }

  // =========================================================================
  // CANCEL / SHUTDOWN
  // =========================================================================

  async cancelAllOrders(): Promise<void> {
    for (const [, schedule] of this.schedules) {
      try {
        await this.orderManager.cancelAllOrders(schedule.market);
      } catch (err) {
        console.error(`[TradingEngine] Failed to cancel orders for ${schedule.market.base.symbol}/${schedule.market.quote.symbol}:`, err);
      }
    }
  }

  // Submit a SettleBalance per active market on graceful shutdown so any
  // settled-but-not-withdrawn trade proceeds end up back in the trade
  // account instead of being stranded in the orderbook contract. Cheap
  // no-op when there's nothing pending; tolerant of per-market failure.
  async settleAllBalances(): Promise<void> {
    for (const [, schedule] of this.schedules) {
      try {
        await this.orderManager.settleBalance(schedule.market);
      } catch (err) {
        console.error(`[TradingEngine] settleBalance failed for ${schedule.market.base.symbol}/${schedule.market.quote.symbol}:`, err);
      }
    }
  }

  shutdown(): void {
    this.disableHotReload();
    this.stop();
  }
}
