import { EventEmitter } from 'events';
import type { Market } from '../types/market.js';
import type { StrategyConfig, StrategyExecutionResult } from '../types/strategy.js';
import type { MarketDataService } from './market-data.js';
import type { BalanceTracker } from './balance-tracker.js';
import type { OrderManager } from './order-manager.js';
import { StrategyExecutor } from './strategy-executor.js';
import * as dbQueries from '../db/queries.js';

interface MarketSchedule {
  market: Market;
  config: StrategyConfig;
  nextRunAt: number;
  lastResult?: StrategyExecutionResult;
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

export class TradingEngine extends EventEmitter {
  private marketData: MarketDataService;
  private balanceTracker: BalanceTracker;
  private orderManager: OrderManager;
  private executor: StrategyExecutor;
  private schedules: Map<string, MarketSchedule> = new Map();
  private running = false;
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;

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

  addMarket(market: Market, config: StrategyConfig): void {
    this.schedules.set(market.market_id, {
      market,
      config,
      nextRunAt: Date.now(),
    });
    this.emit('marketAdded', market.market_id);
  }

  removeMarket(marketId: string): void {
    this.schedules.delete(marketId);
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

  private scheduleNext(): void {
    if (!this.running) return;

    // Find the next market to execute
    let earliest: MarketSchedule | null = null;
    let earliestId: string = '';
    const now = Date.now();

    for (const [id, schedule] of this.schedules) {
      if (!schedule.config.isActive) continue;
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

  private async executeMarket(marketId: string): Promise<void> {
    if (!this.running) return;

    const schedule = this.schedules.get(marketId);
    if (!schedule || !schedule.config.isActive) {
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
      schedule.nextRunAt = result.nextRunAt || this.calculateNextRun(schedule.config);

      this.emit('cycle', marketId, result);
    } catch (err: any) {
      this.emit('error', marketId, err);
      // Use normal cycle interval — no artificial delay on error
      schedule.nextRunAt = this.calculateNextRun(schedule.config);
    }

    this.scheduleNext();
  }

  private calculateNextRun(config: StrategyConfig): number {
    const min = config.timing.cycleIntervalMinMs;
    const max = config.timing.cycleIntervalMaxMs;
    return Date.now() + min + Math.random() * (max - min);
  }

  async cancelAllOrders(): Promise<void> {
    for (const [, schedule] of this.schedules) {
      try {
        await this.orderManager.cancelAllOrders(schedule.market);
      } catch (err) {
        console.error(`[TradingEngine] Failed to cancel orders for ${schedule.market.base.symbol}/${schedule.market.quote.symbol}:`, err);
      }
    }
  }

  shutdown(): void {
    this.stop();
  }
}
