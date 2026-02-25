import Decimal from 'decimal.js';
import type { Market, OrderBookDepth } from '../types/market.js';
import type { StrategyConfig, StrategyExecutionResult, OrderExecution } from '../types/strategy.js';
import type { OrderManager } from './order-manager.js';
import type { MarketDataService } from './market-data.js';
import type { BalanceTracker, MarketBalances } from './balance-tracker.js';
import { roundDownToMarketPrecision, scaleUpAndTruncateToInt, formatPrice, isValidPrice } from '../utils/price-math.js';
import * as dbQueries from '../db/queries.js';

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

    try {
      // ---------------------------------------------------------------
      // 1. CHECK MAX SESSION LOSS
      // ---------------------------------------------------------------
      if (config.riskManagement.maxSessionLossEnabled && config.riskManagement.maxSessionLossUsd > 0) {
        const stats = dbQueries.getTradeStats(market.market_id);
        if (stats.realizedPnl < -config.riskManagement.maxSessionLossUsd) {
          const skipReason = `${pair}: Session loss $${Math.abs(stats.realizedPnl).toFixed(2)} exceeds max $${config.riskManagement.maxSessionLossUsd}, pausing`;
          return { executed: false, orders: [], nextRunAt, skipReason };
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
        };
      }

      // ---------------------------------------------------------------
      // 3. GET TICKER AND ORDERBOOK
      // ---------------------------------------------------------------
      const ticker = await this.marketData.getTicker(market.market_id);
      if (!ticker) {
        return { executed: false, orders: [], skipReason: `${pair}: No ticker data available` };
      }

      const orderBook = await this.marketData.getOrderBook(market.market_id);

      // ---------------------------------------------------------------
      // 4. CHECK SPREAD VS maxSpreadPercent
      // ---------------------------------------------------------------
      if (orderBook && config.orderConfig.maxSpreadPercent > 0) {
        const referenceOrderSizeUsd = config.positionSizing.minOrderSizeUsd || 5;
        const spreadResult = this.calculateEffectiveSpread(orderBook, market, referenceOrderSizeUsd);

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
          return { executed: false, orders: [], nextRunAt, skipReason };
        }
      }

      // ---------------------------------------------------------------
      // 5. GET BALANCES
      // ---------------------------------------------------------------
      this.balanceTracker.clearCache(market.market_id);
      const balances = await this.balanceTracker.getMarketBalances(market.market_id);

      // ---------------------------------------------------------------
      // 6. CHECK MAX OPEN ORDERS PER SIDE
      // ---------------------------------------------------------------
      let shouldPlaceBuy = true;
      let shouldPlaceSell = true;

      if (config.orderManagement.maxOpenOrders > 0) {
        const openOrders = await this.orderManager.getOpenOrders(market);
        const buyOrders = openOrders.filter((o) => o.side === 'Buy');
        const sellOrders = openOrders.filter((o) => o.side === 'Sell');

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
      // 7. CALCULATE PRICES
      // ---------------------------------------------------------------
      const prices = this.calculatePrices(market, ticker, orderBook, config.orderConfig);

      const willPlaceBuy = shouldPlaceBuy && (config.orderConfig.side === 'Buy' || config.orderConfig.side === 'Both');
      const willPlaceSell = shouldPlaceSell && (config.orderConfig.side === 'Sell' || config.orderConfig.side === 'Both');

      // ---------------------------------------------------------------
      // 8. PLACE BUY ORDER
      // ---------------------------------------------------------------
      if (willPlaceBuy) {
        const buyOrder = await this.placeBuyOrder(market, config, prices.buyPrice, balances, ticker, orderBook);
        if (buyOrder) {
          orders.push(buyOrder);
        }
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

        const sellOrder = await this.placeSellOrder(market, configForSell, prices.sellPrice, balances, ticker, orderBook);
        if (sellOrder) {
          orders.push(sellOrder);
        }
      }

      // ---------------------------------------------------------------
      // 10. RETURN RESULTS
      // ---------------------------------------------------------------
      return {
        executed: orders.length > 0,
        orders,
        nextRunAt,
      };
    } catch (error: any) {
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
      };
    }
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
        'Market',
        sellPriceScaled,
        quantityScaled
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
    orderConfig: StrategyConfig['orderConfig']
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

    // Apply offset: buy BELOW reference (subtract offset), sell ABOVE (add offset)
    let buyPrice = referencePrice.mul(1 - orderConfig.priceOffsetPercent / 100);
    let sellPrice = referencePrice.mul(1 + orderConfig.priceOffsetPercent / 100);

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
        if (config.orderConfig.orderType === 'Spot') {
          // Cap buy price to best ask to avoid immediate crossing for limit orders
          buyPriceHuman = bestAskPrice;
        }
        // For market orders, crossing is expected -- no cap needed
      }
    }

    // Calculate order size
    const isMarketOrder = config.orderConfig.orderType !== 'Spot';
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
      const orderType = config.orderConfig.orderType === 'Spot' ? 'Spot' : 'Market';
      const resp = await this.orderManager.placeOrder(
        market,
        'Buy',
        orderType,
        buyPriceScaled,
        quantityScaled
      );

      // Determine display price -- fallback to ticker if calculated price is invalid
      let displayPrice = buyPriceHuman;
      if (buyPriceHuman.eq(0) || buyPriceHuman.isNaN() || !buyPriceHuman.isFinite()) {
        if (ticker?.last_price) {
          displayPrice = new Decimal(ticker.last_price).div(new Decimal(10).pow(market.quote.decimals));
        }
      }

      const isLimitOrder = config.orderConfig.orderType === 'Spot';
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
      const apiMsg = error.response?.data ? JSON.stringify(error.response.data) : '';
      return {
        orderId: '',
        side: 'Buy',
        success: false,
        error: apiMsg ? `${error.message}: ${apiMsg}` : error.message,
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
    const isSellMarketOrder = !forceLimitOrder && config.orderConfig.orderType !== 'Spot';
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
      // Use Spot (limit) when forcing limit for profit protection, otherwise use configured type
      const orderType = forceLimitOrder
        ? 'Spot'
        : (config.orderConfig.orderType === 'Spot' ? 'Spot' : 'Market');

      const resp = await this.orderManager.placeOrder(
        market,
        'Sell',
        orderType,
        sellPriceScaled,
        quantityScaled
      );

      // Determine display price
      let displayPrice = adjustedSellPrice;
      if (adjustedSellPrice.eq(0) || adjustedSellPrice.isNaN() || !adjustedSellPrice.isFinite()) {
        if (ticker?.last_price) {
          displayPrice = new Decimal(ticker.last_price).div(new Decimal(10).pow(market.quote.decimals));
        }
      }

      const isLimitOrder = forceLimitOrder || config.orderConfig.orderType === 'Spot';
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
      const apiMsg = error.response?.data ? JSON.stringify(error.response.data) : '';
      return {
        orderId: '',
        side: 'Sell',
        success: false,
        error: apiMsg ? `${error.message}: ${apiMsg}` : error.message,
        errorDetails: error,
        marketPair,
      };
    }
  }

  // =========================================================================
  // SPREAD CALCULATION (depth-aware)
  // =========================================================================

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
