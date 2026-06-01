import Decimal from 'decimal.js';
import type { Market, OrderBookDepth } from '../types/market.js';
import type {
  StrategyConfig,
  StrategyExecutionResult,
  OrderExecution,
  ExecutionDiagnostics,
  SkipCategory,
} from '../types/strategy.js';
import type { OrderManager } from './order-manager.js';
import type { MarketDataService } from './market-data.js';
import type { BalanceTracker, MarketBalances } from './balance-tracker.js';
import { roundDownToMarketPrecision, scaleUpAndTruncateToInt, formatPrice, isValidPrice } from '../utils/price-math.js';
import * as dbQueries from '../db/queries.js';
import {
  computeDailyWindowStart,
  ConsecutiveFailureTracker,
  MidPriceHistory,
} from './risk-tracker.js';

/**
 * StrategyExecutor - the heart of the trading logic.
 *
 * Orchestrates a single execution cycle for a given market and strategy config.
 * Handles price calculation (4 price modes), position sizing, spread checks,
 * stop loss, take profit / profit protection, order placement, and all edge cases.
 *
 * Does NOT import from external services -- uses only injected OrderManager,
 * MarketDataService, and BalanceTracker dependencies.
 */
export class StrategyExecutor {
  private orderManager: OrderManager;
  private marketData: MarketDataService;
  private balanceTracker: BalanceTracker;

  // Realized-vol input — accumulated per-market mid prices sampled each cycle.
  private midPriceHistory = new MidPriceHistory(240);

  // Consecutive order-placement failures per market, reset on any successful placement.
  private failureTracker = new ConsecutiveFailureTracker();

  // Last realized-pnl total observed per market — used to attribute deltas to the
  // current daily window when the daily-loss limit is enabled.
  private lastRealizedPnlByMarket: Map<string, number> = new Map();

  /**
   * Hand-off field for the trading-engine agent.
   * When consecutive order failures hit `riskManagement.autoPauseOnConsecutiveFailures`,
   * we set this to a non-null value. The engine should poll this field, act on it
   * (e.g. pause the engine, surface a notification) and call `clearAutoPauseRequest()`
   * to acknowledge.
   */
  public autoPauseRequested: { reason: string; timestamp: number; marketId: string } | null = null;

  /** Public clearer used by the engine after it acts on `autoPauseRequested`. */
  public clearAutoPauseRequest(): void {
    this.autoPauseRequested = null;
  }

  constructor(
    orderManager: OrderManager,
    marketData: MarketDataService,
    balanceTracker: BalanceTracker
  ) {
    this.orderManager = orderManager;
    this.marketData = marketData;
    this.balanceTracker = balanceTracker;
  }

  // =========================================================================
  // MAIN EXECUTION
  // =========================================================================

  /**
   * Execute a single strategy cycle for a market.
   *
   * Flow:
   *  1. Check max session loss (if enabled)
   *  2. Check stop loss
   *  3. Get ticker and orderbook
   *  4. Check spread vs maxSpreadPercent
   *  5. Get balances
   *  6. Check max open orders per side
   *  7. Calculate prices based on priceMode + offset + randomization
   *  8. Place buy order (if enabled)
   *  9. Place sell order (if enabled, with profit protection)
   * 10. Return results
   */
  async execute(
    market: Market,
    config: StrategyConfig
  ): Promise<StrategyExecutionResult> {
    const orders: OrderExecution[] = [];
    const pair = `${market.base.symbol}/${market.quote.symbol}`;

    // Calculate next run time at the start
    const minInterval = config.timing.cycleIntervalMinMs;
    const maxInterval = config.timing.cycleIntervalMaxMs;
    const executionStartTime = Date.now();
    const nextRunAt = executionStartTime + minInterval + Math.random() * (maxInterval - minInterval);

    // Diagnostics object accumulated through the cycle and attached to every result.
    const diagnostics: ExecutionDiagnostics = {};

    try {
      // ---------------------------------------------------------------
      // 0. DAILY LOSS WINDOW BOOKKEEPING (opt-in)
      // ---------------------------------------------------------------
      // We update window-start / dailyRealizedPnl on the live `config` object so
      // it gets persisted via upsertStrategyConfig elsewhere in the system.
      if (config.riskManagement.maxDailyLossEnabled) {
        const resetHour = config.riskManagement.dailyLossResetUtcHour ?? 0;
        const expectedWindowStart = computeDailyWindowStart(executionStartTime, resetHour);

        if (!config.dailyLossWindowStart || config.dailyLossWindowStart < expectedWindowStart) {
          // Crossed into a new daily window — reset bucket.
          config.dailyLossWindowStart = expectedWindowStart;
          config.dailyRealizedPnl = 0;
          // Reset baseline so subsequent deltas attribute correctly.
          this.lastRealizedPnlByMarket.set(
            market.market_id,
            dbQueries.getTradeStats(market.market_id).realizedPnl,
          );
          dbQueries.upsertStrategyConfig(market.market_id, config);
        } else {
          // Within window — accumulate any new realized P&L since last cycle.
          const stats = dbQueries.getTradeStats(market.market_id);
          const lastSeen = this.lastRealizedPnlByMarket.get(market.market_id);
          if (lastSeen === undefined) {
            this.lastRealizedPnlByMarket.set(market.market_id, stats.realizedPnl);
          } else {
            const delta = stats.realizedPnl - lastSeen;
            if (delta !== 0) {
              config.dailyRealizedPnl = (config.dailyRealizedPnl ?? 0) + delta;
              this.lastRealizedPnlByMarket.set(market.market_id, stats.realizedPnl);
              dbQueries.upsertStrategyConfig(market.market_id, config);
            }
          }
        }

        diagnostics.dailyPnlUsd = config.dailyRealizedPnl ?? 0;

        const cap = config.riskManagement.maxDailyLossUsd ?? 0;
        if (cap > 0 && (config.dailyRealizedPnl ?? 0) <= -cap) {
          return this.buildSkipResult(
            nextRunAt,
            `${pair}: Daily loss $${Math.abs(config.dailyRealizedPnl ?? 0).toFixed(2)} hit cap $${cap}, pausing for the rest of the UTC day`,
            'daily_loss_hit',
            diagnostics,
          );
        }
      }

      // ---------------------------------------------------------------
      // 1. CHECK MAX SESSION LOSS
      // ---------------------------------------------------------------
      if (config.riskManagement.maxSessionLossEnabled && config.riskManagement.maxSessionLossUsd > 0) {
        const stats = dbQueries.getTradeStats(market.market_id);
        if (stats.realizedPnl < -config.riskManagement.maxSessionLossUsd) {
          return this.buildSkipResult(
            nextRunAt,
            `${pair}: Session loss $${Math.abs(stats.realizedPnl).toFixed(2)} exceeds max $${config.riskManagement.maxSessionLossUsd}, pausing`,
            'session_loss_hit',
            diagnostics,
          );
        }
      }

      // ---------------------------------------------------------------
      // 2. CHECK STOP LOSS
      // ---------------------------------------------------------------
      const stopLossResult = await this.checkStopLoss(market, config);
      if (stopLossResult.triggered) {
        return {
          executed: stopLossResult.orders.length > 0,
          orders: stopLossResult.orders,
          nextRunAt,
          skipCategory: stopLossResult.orders.length > 0 ? undefined : 'stop_loss_active',
          diagnostics,
        };
      }

      // ---------------------------------------------------------------
      // 3. GET TICKER AND ORDERBOOK
      // ---------------------------------------------------------------
      const ticker = await this.marketData.getTicker(market.market_id);
      if (!ticker) {
        return this.buildSkipResult(
          nextRunAt,
          `${pair}: No ticker data available`,
          'ws_down',
          diagnostics,
        );
      }

      const orderBook = await this.marketData.getOrderBook(market.market_id);

      // Sample a mid-price for the realized-vol history (used by adaptive spread).
      const sampledMid = this.marketData.getMidPrice(market.market_id);
      if (sampledMid && sampledMid > 0) {
        this.midPriceHistory.push(market.market_id, sampledMid);
      }

      // Populate baseline diagnostics (best bid/ask/mid) when computable.
      if (orderBook?.bids?.[0]?.[0] && orderBook?.asks?.[0]?.[0]) {
        const qScale = new Decimal(10).pow(market.quote.decimals);
        const bid = new Decimal(orderBook.bids[0][0]).div(qScale);
        const ask = new Decimal(orderBook.asks[0][0]).div(qScale);
        diagnostics.bestBid = bid.toString();
        diagnostics.bestAsk = ask.toString();
        diagnostics.midPrice = bid.plus(ask).div(2).toString();
      }

      // ---------------------------------------------------------------
      // 4. CHECK SPREAD VS maxSpreadPercent
      // ---------------------------------------------------------------
      if (orderBook && config.orderConfig.maxSpreadPercent > 0) {
        const referenceOrderSizeUsd = config.positionSizing.minOrderSizeUsd || 5;
        const spreadResult = this.calculateEffectiveSpread(orderBook, market, referenceOrderSizeUsd);

        if (spreadResult) {
          diagnostics.effectiveSpreadPercent = spreadResult.spread;
        }

        if (spreadResult && spreadResult.spread > config.orderConfig.maxSpreadPercent) {
          let skipReason: string;
          if (spreadResult.insufficientLiquidity) {
            skipReason = `${pair}: Insufficient liquidity - cannot fill $${referenceOrderSizeUsd} order, skipping`;
          } else {
            const isDepthIssue = spreadResult.spread > spreadResult.topOfBookSpread * 1.1;
            if (isDepthIssue) {
              skipReason = `${pair}: Effective spread ${spreadResult.spread.toFixed(2)}% for $${referenceOrderSizeUsd} order exceeds max ${config.orderConfig.maxSpreadPercent}% (top-of-book: ${spreadResult.topOfBookSpread.toFixed(2)}%), skipping`;
            } else {
              skipReason = `${pair}: Spread ${spreadResult.spread.toFixed(2)}% exceeds max ${config.orderConfig.maxSpreadPercent}%, skipping`;
            }
          }
          return this.buildSkipResult(nextRunAt, skipReason, 'spread_exceeded', diagnostics);
        }
      }

      // ---------------------------------------------------------------
      // 5. GET BALANCES
      // ---------------------------------------------------------------
      this.balanceTracker.clearCache(market.market_id);
      const balances = await this.balanceTracker.getMarketBalances(market.market_id);

      // Early exit: skip if both balances are below minimum order size
      const quoteHuman = new Decimal(balances.quote.unlocked).div(new Decimal(10).pow(market.quote.decimals));
      const baseHuman = new Decimal(balances.base.unlocked).div(new Decimal(10).pow(market.base.decimals));
      const midPrice = this.marketData.getMidPrice(market.market_id) || 0;
      const baseValueUsd = midPrice > 0 ? baseHuman.mul(midPrice).toNumber() : 0;
      const minSize = config.positionSizing.minOrderSizeUsd || 5;

      if (quoteHuman.toNumber() < minSize && baseValueUsd < minSize) {
        return this.buildSkipResult(
          nextRunAt,
          `${pair}: Insufficient balance (${quoteHuman.toFixed(2)} ${market.quote.symbol}, ${baseHuman.toFixed(4)} ${market.base.symbol})`,
          'insufficient_balance',
          diagnostics,
        );
      }

      // Inventory-skew calculation (opt-in). Influences buy/sell offsets later.
      let buySkewPercent = 0;
      let sellSkewPercent = 0;
      if (
        config.orderConfig.inventorySkewEnabled &&
        midPrice > 0
      ) {
        const baseEquity = baseHuman.mul(midPrice);
        const totalEquity = baseEquity.plus(quoteHuman);
        if (totalEquity.gt(0)) {
          const baseRatio = baseEquity.div(totalEquity).toNumber();
          const target = config.orderConfig.inventoryTargetBaseRatio ?? 0.5;
          const cap = config.orderConfig.inventoryMaxSkewPercent ?? 0;
          // Deviation in [-target, 1-target]; normalize to [-1, 1].
          // Long-of-target -> we hold too much base, want to discourage further buys
          // and encourage sells (widen buy, tighten sell).
          const denom = Math.max(target, 1 - target) || 0.5;
          const deviation = (baseRatio - target) / denom;
          const clamped = Math.max(-1, Math.min(1, deviation));
          buySkewPercent = clamped * cap; // positive when long base => widen buy (push lower)
          sellSkewPercent = clamped * cap; // positive when long base => tighten sell (push lower)
          diagnostics.inventoryBaseRatio = baseRatio;
        }
      }

      // ---------------------------------------------------------------
      // 6. CHECK MAX OPEN ORDERS PER SIDE
      // ---------------------------------------------------------------
      let shouldPlaceBuy = true;
      let shouldPlaceSell = true;

      // Pre-fetch open orders once — also used for auto-replace and aggregate cap.
      let openOrdersCached: Awaited<ReturnType<OrderManager['getOpenOrders']>> | null = null;
      const fetchOpenOrders = async () => {
        if (openOrdersCached === null) {
          openOrdersCached = await this.orderManager.getOpenOrders(market);
        }
        return openOrdersCached;
      };

      if (config.orderManagement.maxOpenOrders > 0) {
        const openOrders = await fetchOpenOrders();
        const buyOrders = openOrders.filter((o) => o.side === 'Buy');
        const sellOrders = openOrders.filter((o) => o.side === 'Sell');
        diagnostics.openOrdersBuy = buyOrders.length;
        diagnostics.openOrdersSell = sellOrders.length;

        if (config.orderConfig.side === 'Buy' || config.orderConfig.side === 'Both') {
          if (buyOrders.length >= config.orderManagement.maxOpenOrders) {
            shouldPlaceBuy = false;
          }
        }

        if (config.orderConfig.side === 'Sell' || config.orderConfig.side === 'Both') {
          if (sellOrders.length >= config.orderManagement.maxOpenOrders) {
            shouldPlaceSell = false;
          }
        }

        // Handle order timeouts - cancel stale orders
        if (config.riskManagement.orderTimeoutEnabled && config.riskManagement.orderTimeoutMinutes > 0) {
          const timeoutMs = config.riskManagement.orderTimeoutMinutes * 60 * 1000;
          const now = Date.now();
          for (const order of openOrders) {
            if (now - order.created_at > timeoutMs) {
              try {
                await this.orderManager.cancelOrder(order.order_id, market);
              } catch (err) {
                console.error(`[StrategyExecutor] Failed to cancel timed-out order ${order.order_id}:`, err);
              }
            }
          }
        }
      }

      // ---------------------------------------------------------------
      // 7. CALCULATE PRICES (with optional vol-adaptive + inventory skew)
      // ---------------------------------------------------------------
      let realizedVolPercent = 0;
      if (config.orderConfig.volatilityAdaptiveSpreadEnabled) {
        const lookback = config.orderConfig.volatilityLookbackBars ?? 30;
        realizedVolPercent = this.midPriceHistory.realizedVolPercent(market.market_id, lookback);
        diagnostics.realizedVolPercent = realizedVolPercent;
      }

      const prices = this.calculatePrices(
        market,
        ticker,
        orderBook,
        config.orderConfig,
        { realizedVolPercent, buySkewPercent, sellSkewPercent },
      );

      // Persist computed effective skew offsets.
      if (config.orderConfig.inventorySkewEnabled) {
        diagnostics.buySkewPercent = buySkewPercent;
        diagnostics.sellSkewPercent = sellSkewPercent;
      }

      // ---------------------------------------------------------------
      // 7a. TRAILING STOP CHECK (opt-in, when holding a position)
      // ---------------------------------------------------------------
      if (
        config.riskManagement.trailingStopEnabled &&
        config.riskManagement.trailingStopPercent &&
        config.riskManagement.trailingStopPercent > 0
      ) {
        const baseValueForStop = midPrice > 0 ? baseHuman.mul(midPrice).toNumber() : 0;
        const minNotional = config.positionSizing.minOrderSizeUsd || 5;
        if (baseValueForStop >= minNotional && midPrice > 0) {
          const peakDecimal = config.trailingPeakPrice
            ? new Decimal(config.trailingPeakPrice)
            : (config.averageBuyPrice && config.averageBuyPrice !== '0'
                ? new Decimal(config.averageBuyPrice)
                : new Decimal(midPrice));
          const currentDecimal = new Decimal(midPrice);
          const newPeak = currentDecimal.gt(peakDecimal) ? currentDecimal : peakDecimal;
          if (!newPeak.eq(peakDecimal) || !config.trailingPeakPrice) {
            config.trailingPeakPrice = newPeak.toString();
            dbQueries.upsertStrategyConfig(market.market_id, config);
          }
          diagnostics.trailingPeak = config.trailingPeakPrice;

          const dropThresholdPct = config.riskManagement.trailingStopPercent;
          const exitThreshold = newPeak.mul(1 - dropThresholdPct / 100);
          if (currentDecimal.lt(exitThreshold)) {
            console.log(`[StrategyExecutor] ${pair}: Trailing stop triggered — peak ${newPeak.toFixed(6)}, current ${currentDecimal.toFixed(6)}, threshold ${exitThreshold.toFixed(6)} (-${dropThresholdPct}%)`);
            // Reuse existing stop-loss exit code path: cancel orders and market-sell base.
            const trailingResult = await this.executeTrailingStopExit(market, config, currentDecimal);
            return {
              executed: trailingResult.orders.length > 0,
              orders: trailingResult.orders,
              nextRunAt,
              skipCategory: trailingResult.orders.length > 0 ? undefined : 'stop_loss_active',
              diagnostics,
            };
          }
        } else if (baseValueForStop < minNotional && config.trailingPeakPrice) {
          // Position fully closed — clear trailing peak so next entry starts fresh.
          config.trailingPeakPrice = undefined;
          dbQueries.upsertStrategyConfig(market.market_id, config);
        }
      }

      // ---------------------------------------------------------------
      // 7b. AUTO-REPLACE OPEN ORDERS ON DRIFT (opt-in)
      // ---------------------------------------------------------------
      if (config.orderConfig.autoReplaceOnDriftPercent && config.orderConfig.autoReplaceOnDriftPercent > 0) {
        const driftThreshold = config.orderConfig.autoReplaceOnDriftPercent;
        const open = await fetchOpenOrders();
        if (open.length > 0) {
          const qScale = new Decimal(10).pow(market.quote.decimals);
          for (const o of open) {
            const target = o.side === 'Buy' ? prices.buyPrice : prices.sellPrice;
            if (!target || !target.gt(0)) continue;
            const orderPrice = new Decimal(o.price).div(qScale);
            if (orderPrice.lte(0)) continue;
            const driftPct = orderPrice.minus(target).abs().div(target).mul(100).toNumber();
            if (driftPct > driftThreshold) {
              try {
                await this.orderManager.cancelOrder(o.order_id, market);
                console.log(`[StrategyExecutor] ${pair}: Auto-replace cancel ${o.side} @ ${orderPrice.toFixed(6)} drifted ${driftPct.toFixed(2)}% from ${target.toFixed(6)}`);
              } catch (err) {
                console.error(`[StrategyExecutor] Auto-replace cancel failed for ${o.order_id}:`, err);
              }
            }
          }
        }
      }

      // ---------------------------------------------------------------
      // 7c. AGGREGATE OPEN-NOTIONAL DIAGNOSTIC + PRECHECK
      // ---------------------------------------------------------------
      const aggregateCap = config.positionSizing.maxAggregatePositionUsd;
      let aggregateOpenUsd = 0;
      if (aggregateCap !== undefined && aggregateCap > 0) {
        const open = await fetchOpenOrders();
        const qScale = new Decimal(10).pow(market.quote.decimals);
        const bScale = new Decimal(10).pow(market.base.decimals);
        for (const o of open) {
          const px = new Decimal(o.price).div(qScale);
          const remaining = new Decimal(o.quantity).minus(o.quantity_fill || '0').div(bScale);
          if (remaining.gt(0) && px.gt(0)) {
            aggregateOpenUsd += remaining.mul(px).toNumber();
          }
        }
        diagnostics.aggregateOpenUsd = aggregateOpenUsd;
      }

      const willPlaceBuy = shouldPlaceBuy && (config.orderConfig.side === 'Buy' || config.orderConfig.side === 'Both');
      const willPlaceSell = shouldPlaceSell && (config.orderConfig.side === 'Sell' || config.orderConfig.side === 'Both');

      // ---------------------------------------------------------------
      // 8. PLACE BUY ORDER
      // ---------------------------------------------------------------
      const skipReasons: string[] = [];
      let aggregateCapHit = false;

      if (willPlaceBuy) {
        // Slippage cap precheck for Market orders.
        const slippageSkip = this.checkSlippageCap(
          market, config, prices.buyPrice, 'Buy', orderBook, balances,
        );
        if (slippageSkip) {
          skipReasons.push(slippageSkip);
        } else {
          // Aggregate position cap precheck.
          if (aggregateCap !== undefined && aggregateCap > 0) {
            const projectedNotional = this.estimateBuyNotional(market, config, prices.buyPrice, balances);
            if (aggregateOpenUsd + projectedNotional > aggregateCap) {
              aggregateCapHit = true;
              skipReasons.push(`Buy: aggregate open $${aggregateOpenUsd.toFixed(2)} + new $${projectedNotional.toFixed(2)} exceeds cap $${aggregateCap}`);
            }
          }

          if (!aggregateCapHit) {
            const buyOrder = await this.placeBuyOrder(market, config, prices.buyPrice, balances, ticker, orderBook);
            if (buyOrder) {
              orders.push(buyOrder);
              if (buyOrder.success) {
                this.failureTracker.recordSuccess(market.market_id);
                aggregateOpenUsd += this.estimateBuyNotional(market, config, prices.buyPrice, balances);
              } else {
                this.recordFailureAndMaybePause(market, config, `Buy: ${buyOrder.error ?? 'unknown'}`);
              }
            } else {
              skipReasons.push(this.diagnoseBuySkip(market, config, prices.buyPrice, balances));
            }
          }
        }
      } else if (!shouldPlaceBuy && (config.orderConfig.side === 'Buy' || config.orderConfig.side === 'Both')) {
        skipReasons.push('Buy: max open orders reached');
      }

      // ---------------------------------------------------------------
      // 9. PLACE SELL ORDER (with profit protection)
      // ---------------------------------------------------------------
      if (willPlaceSell) {
        // Re-read config from DB for fresh averageBuyPrice
        // (a buy order placed moments ago may have updated it)
        let configForSell = config;
        const dbConfig = dbQueries.getStrategyConfig(market.market_id);
        if (dbConfig) {
          try {
            const parsed = JSON.parse(dbConfig.config);
            configForSell = {
              ...config,
              averageBuyPrice: parsed.averageBuyPrice || config.averageBuyPrice,
              averageSellPrice: parsed.averageSellPrice || config.averageSellPrice,
              lastFillPrices: parsed.lastFillPrices || config.lastFillPrices,
            };
          } catch (err) {
            console.error(`[StrategyExecutor] Failed to parse DB config for sell:`, err);
          }
        }

        const slippageSkip = this.checkSlippageCap(
          market, configForSell, prices.sellPrice, 'Sell', orderBook, balances,
        );
        if (slippageSkip) {
          skipReasons.push(slippageSkip);
        } else {
          let sellAggregateBreach = false;
          if (aggregateCap !== undefined && aggregateCap > 0) {
            const projectedNotional = this.estimateSellNotional(market, configForSell, prices.sellPrice, balances);
            if (aggregateOpenUsd + projectedNotional > aggregateCap) {
              sellAggregateBreach = true;
              aggregateCapHit = true;
              skipReasons.push(`Sell: aggregate open $${aggregateOpenUsd.toFixed(2)} + new $${projectedNotional.toFixed(2)} exceeds cap $${aggregateCap}`);
            }
          }

          if (!sellAggregateBreach) {
            const sellOrder = await this.placeSellOrder(market, configForSell, prices.sellPrice, balances, ticker, orderBook);
            if (sellOrder) {
              orders.push(sellOrder);
              if (sellOrder.success) {
                this.failureTracker.recordSuccess(market.market_id);
              } else {
                this.recordFailureAndMaybePause(market, config, `Sell: ${sellOrder.error ?? 'unknown'}`);
              }
            } else {
              skipReasons.push(this.diagnoseSellSkip(market, configForSell, prices.sellPrice, balances));
            }
          }
        }
      } else if (!shouldPlaceSell && (config.orderConfig.side === 'Sell' || config.orderConfig.side === 'Both')) {
        skipReasons.push('Sell: max open orders reached');
      }

      // ---------------------------------------------------------------
      // 10. RETURN RESULTS
      // ---------------------------------------------------------------
      const successfulOrders = orders.filter(o => o.success);
      const failedOrders = orders.filter(o => !o.success && o.error);

      const result: StrategyExecutionResult = {
        executed: successfulOrders.length > 0,
        orders,
        nextRunAt,
        diagnostics,
      };

      // Surface reasons when no orders were successfully placed
      if (!result.executed) {
        const allReasons: string[] = [];
        for (const o of failedOrders) {
          allReasons.push(`${o.side}: ${o.error}`);
        }
        allReasons.push(...skipReasons);
        if (allReasons.length > 0) {
          result.skipReason = `${pair}: ${allReasons.join('; ')}`;
        }
        // Pick a stable category. Aggregate-cap takes priority since it's an explicit cap.
        if (aggregateCapHit) {
          result.skipCategory = 'aggregate_cap_hit';
        } else if (skipReasons.some(r => r.includes('max open orders'))) {
          result.skipCategory = 'max_open_orders';
        } else if (skipReasons.some(r => r.toLowerCase().includes('slippage'))) {
          result.skipCategory = 'slippage_exceeded';
        } else if (skipReasons.some(r => r.toLowerCase().includes('insufficient') || r.toLowerCase().includes('balance'))) {
          result.skipCategory = 'insufficient_balance';
        } else if (skipReasons.some(r => r.toLowerCase().includes('avg buy price') || r.toLowerCase().includes('profit protection'))) {
          result.skipCategory = 'profit_floor';
        } else if (allReasons.length > 0) {
          result.skipCategory = 'other';
        }
      }

      return result;
    } catch (error: any) {
      const errMsg = `${pair}: Execution error — ${error.message || error}`;
      console.error(`[StrategyExecutor] ${errMsg}`);
      return {
        executed: false,
        orders: [
          {
            orderId: '',
            side: 'Buy',
            success: false,
            error: error.message,
            errorDetails: error,
          },
        ],
        skipReason: errMsg,
        skipCategory: 'other',
        diagnostics,
      };
    }
  }

  // =========================================================================
  // RESULT / DIAGNOSTICS HELPERS
  // =========================================================================

  /** Build a uniform "skipped" result with structured category + diagnostics. */
  private buildSkipResult(
    nextRunAt: number,
    skipReason: string,
    skipCategory: SkipCategory,
    diagnostics: ExecutionDiagnostics,
  ): StrategyExecutionResult {
    return {
      executed: false,
      orders: [],
      nextRunAt,
      skipReason,
      skipCategory,
      diagnostics,
    };
  }

  /**
   * Tracks consecutive failures for a market and, on threshold hit, sets
   * `this.autoPauseRequested` for the trading-engine agent to consume.
   */
  private recordFailureAndMaybePause(
    market: Market,
    config: StrategyConfig,
    reason: string,
  ): void {
    const threshold = config.riskManagement.autoPauseOnConsecutiveFailures;
    const count = this.failureTracker.recordFailure(market.market_id);
    if (threshold && threshold > 0 && count >= threshold) {
      // Hand-off — the trading-engine agent reads `autoPauseRequested` and acts.
      this.autoPauseRequested = {
        reason: `${market.base.symbol}/${market.quote.symbol}: ${count} consecutive order failures — ${reason}`,
        timestamp: Date.now(),
        marketId: market.market_id,
      };
    }
  }

  /**
   * Estimate slippage for a market order by walking the relevant orderbook side via
   * the existing VWAP helpers. Returns a populated skip-reason string when over cap,
   * or null when within cap (or feature disabled).
   */
  private checkSlippageCap(
    market: Market,
    config: StrategyConfig,
    price: Decimal,
    side: 'Buy' | 'Sell',
    orderBook: OrderBookDepth | null,
    balances: MarketBalances,
  ): string | null {
    const cap = config.orderConfig.slippageMaxPercent;
    if (cap === undefined || cap <= 0) return null;
    if (!this.isMarketableOrderType(config.orderConfig.orderType)) return null;
    if (!orderBook) return null;

    const isMarketOrder = true;
    const orderSize = this.calculateOrderSize(
      market,
      config.positionSizing,
      balances,
      side === 'Buy' ? 'buy' : 'sell',
      price,
      isMarketOrder,
    );
    if (!orderSize || orderSize.quantity.lte(0)) return null;

    const levels = side === 'Buy' ? orderBook.asks : orderBook.bids;
    const vwap = this.calculateVWAP(
      levels,
      orderSize.quantity,
      market.quote.decimals,
      market.base.decimals,
    );
    if (!vwap || vwap.lte(0)) return null;

    // Reference price = top of opposing book for that side (best ask for buy, best bid for sell).
    const top = levels?.[0]?.[0];
    if (!top) return null;
    const reference = new Decimal(top).div(new Decimal(10).pow(market.quote.decimals));
    if (reference.lte(0)) return null;

    const slippagePct = vwap.minus(reference).abs().div(reference).mul(100).toNumber();
    if (slippagePct > cap) {
      return `${side}: estimated slippage ${slippagePct.toFixed(3)}% exceeds cap ${cap}%`;
    }
    return null;
  }

  /** Reuse the stop-loss exit path for trailing-stop triggers. */
  private async executeTrailingStopExit(
    market: Market,
    config: StrategyConfig,
    currentPrice: Decimal,
  ): Promise<{ orders: OrderExecution[] }> {
    const orders: OrderExecution[] = [];
    try {
      await this.orderManager.cancelAllOrders(market);
    } catch (err) {
      console.error(`[StrategyExecutor] Trailing stop: failed to cancel orders:`, err);
    }

    this.balanceTracker.clearCache(market.market_id);
    const balances = await this.balanceTracker.getMarketBalances(market.market_id);
    const baseBalanceHuman = new Decimal(balances.base.unlocked).div(new Decimal(10).pow(market.base.decimals));
    if (baseBalanceHuman.lte(0)) return { orders };

    const orderValueUsd = baseBalanceHuman.mul(currentPrice).toNumber();
    if (orderValueUsd < config.positionSizing.minOrderSizeUsd) return { orders };

    try {
      const quantityRounded = roundDownToMarketPrecision(baseBalanceHuman, market);
      const quantityScaled = quantityRounded.mul(new Decimal(10).pow(market.base.decimals)).toFixed(0);
      const sellPriceTruncated = scaleUpAndTruncateToInt(
        currentPrice,
        market.quote.decimals,
        market.quote.max_precision,
        market.tick_size,
      );
      const sellPriceScaled = sellPriceTruncated.toFixed(0);

      const resp = await this.orderManager.placeOrder(
        market,
        'Sell',
        'BoundedMarket',
        sellPriceScaled,
        quantityScaled,
        config.orderConfig.boundedSlippagePercent,
      );

      const marketPair = `${market.base.symbol}/${market.quote.symbol}`;
      const quantityPrecision = Math.min(market.base.decimals, 8);
      const orderId = resp.orders?.[0]?.order_id || '';
      orders.push({
        orderId,
        side: 'Sell',
        success: true,
        price: sellPriceScaled,
        quantity: quantityScaled,
        priceHuman: formatPrice(currentPrice),
        quantityHuman: quantityRounded.toFixed(quantityPrecision).replace(/\.?0+$/, ''),
        marketPair,
      });

      // Clear runtime state after exit.
      const updatedConfig = { ...config };
      updatedConfig.averageBuyPrice = '0';
      updatedConfig.trailingPeakPrice = undefined;
      updatedConfig.lastFillPrices = {
        buy: [],
        sell: config.lastFillPrices?.sell || [],
      };
      dbQueries.upsertStrategyConfig(market.market_id, updatedConfig);
    } catch (error: any) {
      const marketPair = `${market.base.symbol}/${market.quote.symbol}`;
      orders.push({
        orderId: '',
        side: 'Sell',
        success: false,
        error: `Trailing stop sell failed: ${error.message}`,
        errorDetails: error,
        marketPair,
      });
    }

    return { orders };
  }

  /** Estimate USD notional of a prospective buy order (used for aggregate-cap precheck). */
  private estimateBuyNotional(
    market: Market,
    config: StrategyConfig,
    price: Decimal,
    balances: MarketBalances,
  ): number {
    if (!isValidPrice(price)) return 0;
    const isMarketOrder = config.orderConfig.orderType !== 'Spot';
    const sz = this.calculateOrderSize(market, config.positionSizing, balances, 'buy', price, isMarketOrder);
    if (!sz) return 0;
    const qty = roundDownToMarketPrecision(sz.quantity, market);
    return qty.mul(price).toNumber();
  }

  /**
   * Returns true when the configured order type will cross the spread (and thus
   * needs the calculateOrderSize slippage buffer). PostOnly is non-marketable.
   */
  private isMarketableOrderType(orderType: StrategyConfig['orderConfig']['orderType']): boolean {
    return orderType === 'BoundedMarket' || orderType === 'Market' || orderType === 'IOC' || orderType === 'FOK';
  }

  /** Estimate USD notional of a prospective sell order (used for aggregate-cap precheck). */
  private estimateSellNotional(
    market: Market,
    config: StrategyConfig,
    price: Decimal,
    balances: MarketBalances,
  ): number {
    if (!isValidPrice(price)) return 0;
    const isMarketOrder = config.orderConfig.orderType !== 'Spot';
    const sz = this.calculateOrderSize(market, config.positionSizing, balances, 'sell', price, isMarketOrder);
    if (!sz) return 0;
    const qty = roundDownToMarketPrecision(sz.quantity, market);
    return qty.mul(price).toNumber();
  }

  // =========================================================================
  // STOP LOSS
  // =========================================================================

  /**
   * Check if stop loss has been triggered.
   * Compares current market price vs averageBuyPrice * (1 - stopLossPercent/100).
   * If triggered, cancels all open orders and places a market sell for entire base balance.
   */
  async checkStopLoss(
    market: Market,
    config: StrategyConfig
  ): Promise<{ triggered: boolean; orders: OrderExecution[] }> {
    const orders: OrderExecution[] = [];

    if (!config.riskManagement?.stopLossEnabled || !config.riskManagement?.stopLossPercent) {
      return { triggered: false, orders };
    }

    if (!config.averageBuyPrice || config.averageBuyPrice === '0') {
      return { triggered: false, orders };
    }

    // Get current market price
    const ticker = await this.marketData.getTicker(market.market_id);
    if (!ticker || !ticker.last_price) {
      return { triggered: false, orders };
    }

    const currentPrice = new Decimal(ticker.last_price).div(new Decimal(10).pow(market.quote.decimals));
    const avgBuyPrice = new Decimal(config.averageBuyPrice);
    const stopLossPercent = config.riskManagement.stopLossPercent;

    // Calculate stop loss threshold: avgBuyPrice * (1 - stopLossPercent/100)
    const stopLossThreshold = avgBuyPrice.mul(1 - stopLossPercent / 100);

    if (currentPrice.gte(stopLossThreshold)) {
      return { triggered: false, orders };
    }

    // --- STOP LOSS TRIGGERED ---

    // 1. Cancel all open orders
    try {
      await this.orderManager.cancelAllOrders(market);
    } catch (err) {
      console.error(`[StrategyExecutor] Stop loss: failed to cancel orders:`, err);
    }

    // 2. Clear balance cache and get fresh data
    this.balanceTracker.clearCache(market.market_id);
    const balances = await this.balanceTracker.getMarketBalances(market.market_id);
    const baseBalanceHuman = new Decimal(balances.base.unlocked).div(new Decimal(10).pow(market.base.decimals));

    if (baseBalanceHuman.lte(0)) {
      return { triggered: true, orders };
    }

    // Check minimum order size
    const orderValueUsd = baseBalanceHuman.mul(currentPrice).toNumber();
    if (orderValueUsd < config.positionSizing.minOrderSizeUsd) {
      return { triggered: true, orders };
    }

    // 3. Place market sell order for entire base balance
    try {
      const quantityRounded = roundDownToMarketPrecision(baseBalanceHuman, market);
      const quantityScaled = quantityRounded.mul(new Decimal(10).pow(market.base.decimals)).toFixed(0);

      const sellPriceTruncated = scaleUpAndTruncateToInt(
        currentPrice,
        market.quote.decimals,
        market.quote.max_precision,
        market.tick_size
      );
      const sellPriceScaled = sellPriceTruncated.toFixed(0);

      const resp = await this.orderManager.placeOrder(
        market,
        'Sell',
        'BoundedMarket',
        sellPriceScaled,
        quantityScaled,
        config.orderConfig.boundedSlippagePercent
      );

      const marketPair = `${market.base.symbol}/${market.quote.symbol}`;
      const quantityPrecision = Math.min(market.base.decimals, 8);
      const orderId = resp.orders?.[0]?.order_id || '';

      orders.push({
        orderId,
        side: 'Sell',
        success: true,
        price: sellPriceScaled,
        quantity: quantityScaled,
        priceHuman: formatPrice(currentPrice),
        quantityHuman: quantityRounded.toFixed(quantityPrecision).replace(/\.?0+$/, ''),
        marketPair,
      });

      // 4. Clear the average buy price since we exited the position
      const updatedConfig = { ...config };
      updatedConfig.averageBuyPrice = '0';
      updatedConfig.lastFillPrices = {
        buy: [],
        sell: config.lastFillPrices?.sell || [],
      };
      dbQueries.upsertStrategyConfig(market.market_id, updatedConfig);
    } catch (error: any) {
      const marketPair = `${market.base.symbol}/${market.quote.symbol}`;
      orders.push({
        orderId: '',
        side: 'Sell',
        success: false,
        error: `Stop loss sell failed: ${error.message}`,
        errorDetails: error,
        marketPair,
      });
    }

    return { triggered: true, orders };
  }

  // =========================================================================
  // PRICE CALCULATION
  // =========================================================================

  /**
   * Calculate buy and sell prices based on the configured price mode.
   *
   * Supports 4 modes:
   *  - offsetFromMid:     mid price from orderbook, fall back to ticker last_price
   *  - offsetFromBestBid: best bid from orderbook, fall back to ticker
   *  - offsetFromBestAsk: best ask from orderbook, fall back to ticker
   *  - market:            ticker last_price (for market orders)
   *
   * After determining the reference price, applies:
   *  - priceOffsetPercent (buy below, sell above)
   *  - optional priceRandomization per side
   */
  calculatePrices(
    market: Market,
    ticker: { last_price: string; bid?: string; ask?: string },
    orderBook: OrderBookDepth | null,
    orderConfig: StrategyConfig['orderConfig'],
    adjustments?: {
      realizedVolPercent?: number;
      buySkewPercent?: number;
      sellSkewPercent?: number;
    },
  ): { buyPrice: Decimal; sellPrice: Decimal } {
    let referencePrice: Decimal;
    const quoteScale = new Decimal(10).pow(market.quote.decimals);

    switch (orderConfig.priceMode) {
      case 'market':
        referencePrice = new Decimal(ticker.last_price).div(quoteScale);
        break;

      case 'offsetFromBestBid':
        if (orderBook?.bids?.length && orderBook.bids[0]?.[0]) {
          referencePrice = new Decimal(orderBook.bids[0][0]).div(quoteScale);
        } else {
          referencePrice = new Decimal(ticker.last_price).div(quoteScale);
        }
        break;

      case 'offsetFromBestAsk':
        if (orderBook?.asks?.length && orderBook.asks[0]?.[0]) {
          referencePrice = new Decimal(orderBook.asks[0][0]).div(quoteScale);
        } else {
          referencePrice = new Decimal(ticker.last_price).div(quoteScale);
        }
        break;

      case 'offsetFromMid':
      default:
        if (
          orderBook?.bids?.length && orderBook.bids[0]?.[0] &&
          orderBook?.asks?.length && orderBook.asks[0]?.[0]
        ) {
          const bestBid = new Decimal(orderBook.bids[0][0]).div(quoteScale);
          const bestAsk = new Decimal(orderBook.asks[0][0]).div(quoteScale);
          referencePrice = bestBid.plus(bestAsk).div(2);
        } else {
          referencePrice = new Decimal(ticker.last_price).div(quoteScale);
        }
        break;
    }

    // Compute the effective per-side offset, applying optional vol-adaptive scaling.
    const baseOffsetPercent = orderConfig.priceOffsetPercent;

    let effectiveOffsetPercent = baseOffsetPercent;
    if (
      orderConfig.volatilityAdaptiveSpreadEnabled &&
      adjustments?.realizedVolPercent !== undefined
    ) {
      const mult = orderConfig.volatilitySpreadMultiplier ?? 0;
      const vol = adjustments.realizedVolPercent;
      // offset_effective = offset * (1 + multiplier * realizedVolPercent)
      effectiveOffsetPercent = baseOffsetPercent * (1 + mult * vol);
    }

    // Apply optional inventory skew (asymmetric):
    //   - When holding too much base (deviation > 0): widen buy (push price down)
    //     by adding to the buy offset, tighten sell (push price down toward reference)
    //     by subtracting from the sell offset.
    //   - When holding too little base (deviation < 0): the signs flip naturally
    //     because buySkewPercent / sellSkewPercent are signed.
    let buyOffsetPercent = effectiveOffsetPercent;
    let sellOffsetPercent = effectiveOffsetPercent;
    if (orderConfig.inventorySkewEnabled) {
      const buySkew = adjustments?.buySkewPercent ?? 0;
      const sellSkew = adjustments?.sellSkewPercent ?? 0;
      buyOffsetPercent = effectiveOffsetPercent + buySkew;
      sellOffsetPercent = effectiveOffsetPercent - sellSkew;
      // Guard against non-positive offsets that could invert prices.
      if (buyOffsetPercent < 0) buyOffsetPercent = 0;
      if (sellOffsetPercent < 0) sellOffsetPercent = 0;
    }

    // Apply offset: buy BELOW reference (subtract offset), sell ABOVE (add offset)
    let buyPrice = referencePrice.mul(1 - buyOffsetPercent / 100);
    let sellPrice = referencePrice.mul(1 + sellOffsetPercent / 100);

    // Apply price randomization if enabled
    if (orderConfig.priceRandomizationEnabled && orderConfig.priceRandomizationRangePercent) {
      const range = orderConfig.priceRandomizationRangePercent / 100;
      const buyRandomFactor = 1 + (Math.random() * 2 - 1) * range;
      const sellRandomFactor = 1 + (Math.random() * 2 - 1) * range;
      buyPrice = buyPrice.mul(buyRandomFactor);
      sellPrice = sellPrice.mul(sellRandomFactor);
    }

    return { buyPrice, sellPrice };
  }

  // =========================================================================
  // ORDER SIZE CALCULATION
  // =========================================================================

  /**
   * Calculate order size based on position sizing config.
   *
   * Supports two modes:
   *  - percentageOfBalance: uses quoteBalancePercentage (buy) or baseBalancePercentage (sell)
   *  - fixedUsd: uses fixedUsdAmount
   *
   * Applies:
   *  - maxOrderSizeUsd cap (if configured)
   *  - slippage buffer for market orders (2%)
   *  - balance availability checks
   */
  calculateOrderSize(
    market: Market,
    positionSizing: StrategyConfig['positionSizing'],
    balances: MarketBalances,
    side: 'buy' | 'sell',
    price: Decimal,
    isMarketOrder: boolean = false
  ): { quantity: Decimal; valueUsd: number } | null {
    if (!isValidPrice(price)) {
      return null;
    }

    // For market orders, apply 2% slippage buffer to avoid over-spending
    const MARKET_ORDER_SLIPPAGE_BUFFER = isMarketOrder ? 0.98 : 1.0;

    // ----- Fixed USD mode -----
    if (positionSizing.sizeMode === 'fixedUsd') {
      const fixedAmount = positionSizing.fixedUsdAmount || 0;
      if (fixedAmount <= 0) return null;

      let orderValue = new Decimal(fixedAmount);
      if (positionSizing.maxOrderSizeUsd && orderValue.gt(positionSizing.maxOrderSizeUsd)) {
        orderValue = new Decimal(positionSizing.maxOrderSizeUsd);
      }

      const quantity = orderValue.div(price);

      if (side === 'buy') {
        const quoteBalanceHuman = new Decimal(balances.quote.unlocked).div(new Decimal(10).pow(market.quote.decimals));
        const effectiveBalance = quoteBalanceHuman.mul(MARKET_ORDER_SLIPPAGE_BUFFER);
        const requiredQuote = quantity.mul(price);
        if (requiredQuote.gt(effectiveBalance)) {
          const maxQuantity = effectiveBalance.div(price);
          return { quantity: maxQuantity, valueUsd: maxQuantity.mul(price).toNumber() };
        }
      } else {
        const baseBalanceHuman = new Decimal(balances.base.unlocked).div(new Decimal(10).pow(market.base.decimals));
        const effectiveBalance = baseBalanceHuman.mul(MARKET_ORDER_SLIPPAGE_BUFFER);
        if (quantity.gt(effectiveBalance)) {
          return { quantity: effectiveBalance, valueUsd: effectiveBalance.mul(price).toNumber() };
        }
      }

      return { quantity, valueUsd: orderValue.toNumber() };
    }

    // ----- Percentage-based sizing -----
    let balancePercentage: number;
    if (side === 'buy') {
      balancePercentage = (positionSizing.quoteBalancePercentage !== undefined)
        ? positionSizing.quoteBalancePercentage / 100
        : positionSizing.balancePercentage / 100;
    } else {
      balancePercentage = (positionSizing.baseBalancePercentage !== undefined)
        ? positionSizing.baseBalancePercentage / 100
        : positionSizing.balancePercentage / 100;
    }

    if (side === 'buy') {
      const quoteBalanceHuman = new Decimal(balances.quote.unlocked).div(new Decimal(10).pow(market.quote.decimals));
      const effectiveBalance = quoteBalanceHuman.mul(MARKET_ORDER_SLIPPAGE_BUFFER);
      let orderValue = effectiveBalance.mul(balancePercentage);

      if (positionSizing.maxOrderSizeUsd && orderValue.gt(positionSizing.maxOrderSizeUsd)) {
        orderValue = new Decimal(positionSizing.maxOrderSizeUsd);
      }
      // Ensure we never exceed available balance
      if (orderValue.gt(effectiveBalance)) {
        orderValue = effectiveBalance;
      }

      const quantity = orderValue.div(price);
      return { quantity, valueUsd: orderValue.toNumber() };
    } else {
      const baseBalanceHuman = new Decimal(balances.base.unlocked).div(new Decimal(10).pow(market.base.decimals));
      const effectiveBalance = baseBalanceHuman.mul(MARKET_ORDER_SLIPPAGE_BUFFER);
      let quantity = effectiveBalance.mul(balancePercentage);
      let orderValue = quantity.mul(price);

      if (positionSizing.maxOrderSizeUsd && orderValue.gt(positionSizing.maxOrderSizeUsd)) {
        orderValue = new Decimal(positionSizing.maxOrderSizeUsd);
        quantity = orderValue.div(price);
      }
      // Ensure we never exceed available balance
      if (quantity.gt(effectiveBalance)) {
        quantity = effectiveBalance;
        orderValue = quantity.mul(price);
      }

      return { quantity, valueUsd: orderValue.toNumber() };
    }
  }

  // =========================================================================
  // BUY ORDER
  // =========================================================================

  /**
   * Place a buy order.
   *
   * - For Spot (limit) orders, caps buy price to best ask to prevent immediate
   *   market execution at an unfavorable price.
   * - Checks minimum order size in USD.
   */
  private async placeBuyOrder(
    market: Market,
    config: StrategyConfig,
    buyPriceHuman: Decimal,
    balances: MarketBalances,
    ticker: { last_price: string },
    orderBook: OrderBookDepth | null
  ): Promise<OrderExecution | null> {
    // Validate and cap buy price against orderbook best ask for limit orders
    if (orderBook?.asks?.length && orderBook.asks[0]?.[0]) {
      const bestAskPrice = new Decimal(orderBook.asks[0][0]).div(new Decimal(10).pow(market.quote.decimals));
      if (buyPriceHuman.gt(bestAskPrice)) {
        // Cap buy price to best ask for any non-marketable / limit-style order type
        // to avoid immediate unfavorable crossing. PostOnly must never cross either.
        if (config.orderConfig.orderType === 'Spot' || config.orderConfig.orderType === 'PostOnly') {
          buyPriceHuman = bestAskPrice;
        }
        // For Market / IOC / FOK, crossing is expected — no cap needed.
      }
    }

    // Calculate order size — slippage buffer only applies to marketable order types.
    const isMarketOrder = this.isMarketableOrderType(config.orderConfig.orderType);
    const orderSize = this.calculateOrderSize(market, config.positionSizing, balances, 'buy', buyPriceHuman, isMarketOrder);
    if (!orderSize || orderSize.quantity.eq(0)) {
      return null;
    }

    // Truncate price to tick size / max_precision
    const buyPriceTruncated = scaleUpAndTruncateToInt(
      buyPriceHuman,
      market.quote.decimals,
      market.quote.max_precision,
      market.tick_size
    );
    const buyPriceScaled = buyPriceTruncated.toFixed(0);

    // Round quantity to market precision
    const quantityRounded = roundDownToMarketPrecision(orderSize.quantity, market);
    const quantityScaled = quantityRounded.mul(new Decimal(10).pow(market.base.decimals)).toFixed(0);

    // Check minimum order size
    const orderValueUsd = quantityRounded.mul(buyPriceHuman).toNumber();
    if (orderValueUsd < config.positionSizing.minOrderSizeUsd) {
      return null;
    }

    const marketPair = `${market.base.symbol}/${market.quote.symbol}`;

    try {
      // Map strategy-level order types to order-manager order types. Existing
      // 'Market'/'Spot' code paths are preserved; new 'PostOnly'|'IOC'|'FOK'
      // are forwarded as-is to OrderManager which maps to the contract enum.
      const cfgType = config.orderConfig.orderType;
      let orderType: string;
      if (cfgType === 'Spot') orderType = 'Spot';
      else if (cfgType === 'PostOnly' || cfgType === 'IOC' || cfgType === 'FOK') orderType = cfgType;
      else orderType = 'BoundedMarket';

      const resp = await this.orderManager.placeOrder(
        market,
        'Buy',
        orderType,
        buyPriceScaled,
        quantityScaled,
        config.orderConfig.boundedSlippagePercent
      );

      // Determine display price -- fallback to ticker if calculated price is invalid
      let displayPrice = buyPriceHuman;
      if (buyPriceHuman.eq(0) || buyPriceHuman.isNaN() || !buyPriceHuman.isFinite()) {
        if (ticker?.last_price) {
          displayPrice = new Decimal(ticker.last_price).div(new Decimal(10).pow(market.quote.decimals));
        }
      }

      // PostOnly behaves like a limit order from the user's perspective;
      // IOC/FOK execute immediately like Market but at the specified price cap.
      const isLimitOrder = config.orderConfig.orderType === 'Spot' || config.orderConfig.orderType === 'PostOnly';
      const quantityPrecision = Math.min(market.base.decimals, 8);
      const orderId = resp.orders?.[0]?.order_id || '';

      return {
        orderId,
        side: 'Buy',
        success: true,
        price: buyPriceScaled,
        quantity: quantityScaled,
        priceHuman: formatPrice(displayPrice),
        quantityHuman: quantityRounded.toFixed(quantityPrecision).replace(/\.?0+$/, ''),
        marketPair,
        isLimitOrder,
      };
    } catch (error: any) {
      const formattedError = this.formatError(error);
      console.error(`[StrategyExecutor] Buy order failed (${marketPair}): ${formattedError}`);
      return {
        orderId: '',
        side: 'Buy',
        success: false,
        error: formattedError,
        errorDetails: error,
        marketPair,
      };
    }
  }

  // =========================================================================
  // SELL ORDER (with profit protection)
  // =========================================================================

  /**
   * Place a sell order with full profit protection logic.
   *
   * When onlySellAboveBuyPrice is enabled and we have an averageBuyPrice:
   *  - Calculates a minimum profitable sell price using takeProfitPercent
   *  - If the current market sell price is below that floor, the order is
   *    placed as a Spot (limit) order at the profitable price instead
   *  - This prevents selling at a loss while still participating in the market
   */
  private async placeSellOrder(
    market: Market,
    config: StrategyConfig,
    sellPriceHuman: Decimal,
    balances: MarketBalances,
    ticker: { last_price: string },
    orderBook: OrderBookDepth | null
  ): Promise<OrderExecution | null> {
    const takeProfitRate = (config.riskManagement?.takeProfitPercent ?? 0.02) / 100;

    let adjustedSellPrice = sellPriceHuman;
    let forceLimitOrder = false;

    // ----- Profit protection -----
    if (config.orderManagement.onlySellAboveBuyPrice && config.averageBuyPrice && config.averageBuyPrice !== '0') {
      const avgBuyPriceDecimal = new Decimal(config.averageBuyPrice);
      const minProfitablePrice = avgBuyPriceDecimal.mul(1 + takeProfitRate);

      if (sellPriceHuman.lt(minProfitablePrice)) {
        adjustedSellPrice = minProfitablePrice;
        forceLimitOrder = true;
      }
    }

    // If profit protection is enabled but we have NO average buy price tracked yet,
    // skip selling (we don't know our cost basis)
    if (config.orderManagement.onlySellAboveBuyPrice) {
      if (!config.averageBuyPrice || config.averageBuyPrice === '0') {
        // No cost basis -- skip sell to avoid selling at unknown P&L
        return null;
      }
    }

    // Calculate order size (no slippage buffer for forced limit orders)
    const isSellMarketOrder = !forceLimitOrder && this.isMarketableOrderType(config.orderConfig.orderType);
    const orderSize = this.calculateOrderSize(market, config.positionSizing, balances, 'sell', adjustedSellPrice, isSellMarketOrder);
    if (!orderSize || orderSize.quantity.eq(0)) {
      return null;
    }

    // Truncate price to tick size / max_precision
    const sellPriceTruncated = scaleUpAndTruncateToInt(
      adjustedSellPrice,
      market.quote.decimals,
      market.quote.max_precision,
      market.tick_size
    );
    const sellPriceScaled = sellPriceTruncated.toFixed(0);

    // Round quantity to market precision
    const quantityRounded = roundDownToMarketPrecision(orderSize.quantity, market);
    const quantityScaled = quantityRounded.mul(new Decimal(10).pow(market.base.decimals)).toFixed(0);

    // Check minimum order size
    const orderValueUsd = quantityRounded.mul(adjustedSellPrice).toNumber();
    if (orderValueUsd < config.positionSizing.minOrderSizeUsd) {
      return null;
    }

    const marketPair = `${market.base.symbol}/${market.quote.symbol}`;

    try {
      // Use Spot (limit) when forcing limit for profit protection, otherwise use configured type.
      // Forward extended types (PostOnly | IOC | FOK) to OrderManager which maps to the contract enum.
      let orderType: string;
      if (forceLimitOrder) {
        orderType = 'Spot';
      } else {
        const cfgType = config.orderConfig.orderType;
        if (cfgType === 'Spot') orderType = 'Spot';
        else if (cfgType === 'PostOnly' || cfgType === 'IOC' || cfgType === 'FOK') orderType = cfgType;
        else orderType = 'BoundedMarket';
      }

      const resp = await this.orderManager.placeOrder(
        market,
        'Sell',
        orderType,
        sellPriceScaled,
        quantityScaled,
        config.orderConfig.boundedSlippagePercent
      );

      // Determine display price
      let displayPrice = adjustedSellPrice;
      if (adjustedSellPrice.eq(0) || adjustedSellPrice.isNaN() || !adjustedSellPrice.isFinite()) {
        if (ticker?.last_price) {
          displayPrice = new Decimal(ticker.last_price).div(new Decimal(10).pow(market.quote.decimals));
        }
      }

      const isLimitOrder = forceLimitOrder
        || config.orderConfig.orderType === 'Spot'
        || config.orderConfig.orderType === 'PostOnly';
      const quantityPrecision = Math.min(market.base.decimals, 8);
      const orderId = resp.orders?.[0]?.order_id || '';

      return {
        orderId,
        side: 'Sell',
        success: true,
        price: sellPriceScaled,
        quantity: quantityScaled,
        priceHuman: formatPrice(displayPrice),
        quantityHuman: quantityRounded.toFixed(quantityPrecision).replace(/\.?0+$/, ''),
        marketPair,
        isLimitOrder,
      };
    } catch (error: any) {
      const formattedError = this.formatError(error);
      console.error(`[StrategyExecutor] Sell order failed (${marketPair}): ${formattedError}`);
      return {
        orderId: '',
        side: 'Sell',
        success: false,
        error: formattedError,
        errorDetails: error,
        marketPair,
      };
    }
  }

  // =========================================================================
  // SPREAD CALCULATION (depth-aware)
  // =========================================================================

  /**
   * Extract a short, readable error message from API errors.
   */
  private formatError(error: any): string {
    const raw = error.response?.data ? JSON.stringify(error.response.data) : error.message || '';
    // Extract known error patterns
    const notEnough = raw.match(/NotEnoughBalance/);
    if (notEnough) return 'NotEnoughBalance';
    const nonceErr = raw.match(/Nonce in the request\((\d+)\) is less than.*database\((\d+)\)/);
    if (nonceErr) return `Nonce stale (local:${nonceErr[1]} server:${nonceErr[2]})`;
    // Look for Fuel VM panic/revert reasons
    const panicMatch = raw.match(/PanicInstruction\s*\{\s*reason:\s*(\w+)/);
    if (panicMatch) return `VM panic: ${panicMatch[1]}`;
    const revertMatch = raw.match(/Revert\((\d+)\)/);
    if (revertMatch) return `Revert(${revertMatch[1]})`;
    // Look for receipt-level errors
    const receiptPanic = raw.match(/"reason_str":"([^"]+)"/);
    if (receiptPanic) return receiptPanic[1].slice(0, 100);
    // Look for specific O2 error messages
    const invalidSession = raw.match(/Invalid session/i);
    if (invalidSession) return 'Invalid session';
    const reasonMatch = raw.match(/"reason":"([^"]{1,120})"/);
    if (reasonMatch) return reasonMatch[1].slice(0, 120);
    // Generic message field - but show more context if it's "Failed to process transaction"
    const msgMatch = raw.match(/"message":"([^"]{1,120})"/);
    if (msgMatch) {
      const msg = msgMatch[1];
      if (msg === 'Failed to process transaction' && raw.length > msg.length + 30) {
        // Show more of the error response for vague messages
        return raw.slice(0, 200);
      }
      return msg.slice(0, 120);
    }
    // Truncate to 200 chars for better debugging
    return (error.message || raw).slice(0, 200);
  }

  /**
   * Diagnose why a buy order was not placed (returned null).
   */
  private diagnoseBuySkip(
    market: Market,
    config: StrategyConfig,
    buyPrice: Decimal,
    balances: MarketBalances
  ): string {
    if (!isValidPrice(buyPrice)) return 'Buy: invalid price (0/NaN)';
    const quoteHuman = new Decimal(balances.quote.unlocked).div(new Decimal(10).pow(market.quote.decimals));
    const orderSize = this.calculateOrderSize(market, config.positionSizing, balances, 'buy', buyPrice, this.isMarketableOrderType(config.orderConfig.orderType));
    if (!orderSize) return `Buy: order size calc failed (quote=${quoteHuman.toFixed(2)}, price=${buyPrice.toFixed(4)})`;
    if (orderSize.quantity.eq(0)) return 'Buy: quantity rounds to 0';
    const quantityRounded = roundDownToMarketPrecision(orderSize.quantity, market);
    const orderValueUsd = quantityRounded.mul(buyPrice).toNumber();
    if (orderValueUsd < config.positionSizing.minOrderSizeUsd) {
      return `Buy: value $${orderValueUsd.toFixed(2)} < min $${config.positionSizing.minOrderSizeUsd}`;
    }
    return 'Buy: order placement failed';
  }

  /**
   * Diagnose why a sell order was not placed (returned null).
   */
  private diagnoseSellSkip(
    market: Market,
    config: StrategyConfig,
    sellPrice: Decimal,
    balances: MarketBalances
  ): string {
    if (config.orderManagement.onlySellAboveBuyPrice) {
      if (!config.averageBuyPrice || config.averageBuyPrice === '0') {
        return 'Sell: no avg buy price (profit protection blocks)';
      }
    }
    if (!isValidPrice(sellPrice)) return 'Sell: invalid price (0/NaN)';
    const baseHuman = new Decimal(balances.base.unlocked).div(new Decimal(10).pow(market.base.decimals));
    const orderSize = this.calculateOrderSize(market, config.positionSizing, balances, 'sell', sellPrice, this.isMarketableOrderType(config.orderConfig.orderType));
    if (!orderSize) return `Sell: order size calc failed (base=${baseHuman.toFixed(6)}, price=${sellPrice.toFixed(4)})`;
    if (orderSize.quantity.eq(0)) return 'Sell: quantity rounds to 0';
    const quantityRounded = roundDownToMarketPrecision(orderSize.quantity, market);
    const orderValueUsd = quantityRounded.mul(sellPrice).toNumber();
    if (orderValueUsd < config.positionSizing.minOrderSizeUsd) {
      return `Sell: value $${orderValueUsd.toFixed(2)} < min $${config.positionSizing.minOrderSizeUsd}`;
    }
    return 'Sell: order placement failed';
  }

  /**
   * Calculate VWAP (Volume-Weighted Average Price) for a given order size.
   * Walks through orderbook levels to find the average price you would pay/receive.
   *
   * @returns VWAP in human-readable format, or null if insufficient liquidity
   */
  private calculateVWAP(
    levels: Array<[string, string]>,
    orderSizeBase: Decimal,
    quoteDecimals: number,
    baseDecimals: number
  ): Decimal | null {
    if (!levels || levels.length === 0) return null;

    let remainingSize = orderSizeBase;
    let totalCost = new Decimal(0);
    let totalFilled = new Decimal(0);

    for (const level of levels) {
      if (remainingSize.lte(0)) break;

      const priceRaw = Array.isArray(level) ? level[0] : (level as any).price;
      const quantityRaw = Array.isArray(level) ? level[1] : (level as any).quantity;

      const price = new Decimal(priceRaw).div(new Decimal(10).pow(quoteDecimals));
      const quantity = new Decimal(quantityRaw).div(new Decimal(10).pow(baseDecimals));

      if (quantity.lte(0) || price.lte(0)) continue;

      const fillSize = Decimal.min(remainingSize, quantity);
      totalCost = totalCost.plus(fillSize.mul(price));
      totalFilled = totalFilled.plus(fillSize);
      remainingSize = remainingSize.minus(fillSize);
    }

    if (remainingSize.gt(0) || totalFilled.lte(0)) return null;

    return totalCost.div(totalFilled);
  }

  /**
   * Calculate effective spread percentage considering orderbook depth.
   *
   * Walks through the orderbook to find what price you would actually pay/receive
   * for a given order size, accounting for thin liquidity at the top of book.
   */
  private calculateEffectiveSpread(
    orderBook: OrderBookDepth,
    market: Market,
    orderSizeUsd: number
  ): {
    spread: number;
    effectiveBid: Decimal;
    effectiveAsk: Decimal;
    midPrice: Decimal;
    topOfBookSpread: number;
    insufficientLiquidity?: boolean;
  } | null {
    if (!orderBook.bids?.length || !orderBook.asks?.length) return null;

    const bestBidEntry = orderBook.bids[0];
    const bestAskEntry = orderBook.asks[0];
    if (!bestBidEntry?.[0] || !bestAskEntry?.[0]) return null;

    const quoteScale = new Decimal(10).pow(market.quote.decimals);
    const bestBid = new Decimal(bestBidEntry[0]).div(quoteScale);
    const bestAsk = new Decimal(bestAskEntry[0]).div(quoteScale);
    const midPrice = bestBid.plus(bestAsk).div(2);

    if (midPrice.lte(0)) return null;

    const topOfBookSpread = bestAsk.minus(bestBid).div(midPrice).mul(100).toNumber();

    // Convert USD order size to base currency
    const orderSizeBase = new Decimal(orderSizeUsd).div(midPrice);

    const effectiveBid = this.calculateVWAP(orderBook.bids, orderSizeBase, market.quote.decimals, market.base.decimals);
    const effectiveAsk = this.calculateVWAP(orderBook.asks, orderSizeBase, market.quote.decimals, market.base.decimals);

    if (!effectiveBid || !effectiveAsk) {
      return {
        spread: 999,
        effectiveBid: bestBid,
        effectiveAsk: bestAsk,
        midPrice,
        topOfBookSpread,
        insufficientLiquidity: true,
      };
    }

    const effectiveSpread = effectiveAsk.minus(effectiveBid).div(midPrice).mul(100);

    return {
      spread: effectiveSpread.toNumber(),
      effectiveBid,
      effectiveAsk,
      midPrice,
      topOfBookSpread,
    };
  }
}
