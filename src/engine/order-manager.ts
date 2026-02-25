import { EventEmitter } from 'events';
import type { SessionManager } from '../auth/session-manager.js';
import type { O2RestClient } from '../api/rest-client.js';
import type { O2WebSocketClient } from '../api/ws-client.js';
import type { Market } from '../types/market.js';
import type { Order } from '../types/order.js';
import type { SessionAction, SessionActionsResponse } from '../types/api.js';
import { normalizeB256 } from '../utils/price-math.js';
import * as dbQueries from '../db/queries.js';

export interface FillEvent {
  orderId: string;
  marketId: string;
  side: string;
  price: number;
  sizeBase: number;
  timestamp: number;
  fee: number;
}

export class OrderManager extends EventEmitter {
  private sessionManager: SessionManager;
  private restClient: O2RestClient;
  private wsClient: O2WebSocketClient;
  private previousFilledQty: Map<string, number> = new Map();
  private pollingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(
    sessionManager: SessionManager,
    restClient: O2RestClient,
    wsClient: O2WebSocketClient
  ) {
    super();
    this.sessionManager = sessionManager;
    this.restClient = restClient;
    this.wsClient = wsClient;
    this.setupWsListeners();
  }

  private setupWsListeners(): void {
    this.wsClient.on('orders', (orders: any[]) => {
      this.handleOrderUpdates(orders);
    });
  }

  // Subscribe to order updates for our trade account
  subscribeOrders(): void {
    const tradeAccountId = this.sessionManager.tradeAccount;
    if (tradeAccountId) {
      this.wsClient.subscribeOrders([{ ContractId: tradeAccountId }]);
    }
  }

  // Seed the fill tracker with existing orders to prevent false fill detection
  async seedFillTracker(markets: Market[]): Promise<void> {
    for (const market of markets) {
      try {
        const orders = await this.restClient.getOrders({
          market_id: market.market_id,
          contract: this.sessionManager.tradeAccount,
          count: 50,
          direction: 'desc',
        });
        for (const order of orders) {
          const filledQty = parseFloat(order.quantity_fill || '0');
          if (filledQty > 0) {
            this.previousFilledQty.set(order.order_id, filledQty);
          }
        }
      } catch (err) {
        console.error(`[OrderManager] Failed to seed fill tracker for ${market.base.symbol}/${market.quote.symbol}:`, err);
      }
    }
  }

  // Place an order with SettleBalance sandwich
  async placeOrder(
    market: Market,
    side: string,
    orderType: string,
    priceScaled: string,
    quantityScaled: string
  ): Promise<SessionActionsResponse> {
    const tradeAccountId = this.sessionManager.tradeAccount;
    const actions: SessionAction[] = [
      { SettleBalance: { to: { ContractId: tradeAccountId } } },
      {
        CreateOrder: {
          side,
          order_type: orderType,
          price: priceScaled,
          quantity: quantityScaled,
        },
      },
      { SettleBalance: { to: { ContractId: tradeAccountId } } },
    ];

    const resp = await this.sessionManager.submitActions(
      market.market_id,
      market,
      actions
    );

    // Record in DB
    if (resp.orders) {
      for (const o of resp.orders) {
        if (o.order_id) {
          dbQueries.insertOrder({
            orderId: normalizeB256(o.order_id),
            marketId: market.market_id,
            side,
            orderType,
            price: priceScaled,
            quantity: quantityScaled,
            status: 'open',
            txId: resp.tx_id,
          });
        }
      }
    }

    return resp;
  }

  // Cancel a single order
  async cancelOrder(orderId: string, market: Market): Promise<void> {
    const actions: SessionAction[] = [
      { CancelOrder: { order_id: orderId } },
    ];
    await this.sessionManager.submitActions(market.market_id, market, actions);
    dbQueries.updateOrderStatus(orderId, 'cancelled');
  }

  // Cancel all open orders for a market
  async cancelAllOrders(market: Market): Promise<void> {
    const openOrders = await this.getOpenOrders(market);
    if (openOrders.length === 0) return;

    // Cancel in batches of 5
    for (let i = 0; i < openOrders.length; i += 5) {
      const batch = openOrders.slice(i, i + 5);
      const actions: SessionAction[] = batch.map((o) => ({
        CancelOrder: { order_id: o.order_id },
      }));
      try {
        await this.sessionManager.submitActions(market.market_id, market, actions);
        for (const o of batch) {
          dbQueries.updateOrderStatus(o.order_id, 'cancelled');
        }
      } catch (err) {
        console.error(`[OrderManager] Cancel batch failed:`, err);
      }
    }
  }

  // Get open orders for a market
  async getOpenOrders(market: Market): Promise<Order[]> {
    return this.restClient.getOrders({
      market_id: market.market_id,
      contract: this.sessionManager.tradeAccount,
      count: 100,
      direction: 'desc',
      is_open: true,
    });
  }

  // Handle order updates from WebSocket or polling
  private handleOrderUpdates(orders: any[]): void {
    for (const order of orders) {
      const isFilled = order.close === true;
      const isPartiallyFilled = order.partially_filled === true;

      if (!isFilled && !isPartiallyFilled) continue;

      const cumulativeFilledQty = parseFloat(order.quantity_fill || '0');
      if (cumulativeFilledQty <= 0) continue;

      const previousQty = this.previousFilledQty.get(order.order_id) ?? 0;
      const incrementalQty = cumulativeFilledQty - previousQty;

      if (incrementalQty <= 0) continue;

      this.previousFilledQty.set(order.order_id, cumulativeFilledQty);

      const fillPrice = parseFloat(order.price_fill || order.price);

      // Normalize side to capitalized form
      const normalizedSide = (order.side === 'buy' || order.side === 'Buy') ? 'Buy' : 'Sell';

      const fill: FillEvent = {
        orderId: order.order_id,
        marketId: order.market_id || '',
        side: normalizedSide,
        price: fillPrice,
        sizeBase: incrementalQty,
        timestamp: parseInt(order.timestamp) || Date.now(),
        fee: 0, // Estimated by PnL calculator from market fee rates
      };

      this.emit('fill', fill);

      // Update DB
      const status = isFilled ? 'filled' : 'partially_filled';
      dbQueries.updateOrderStatus(
        order.order_id,
        status,
        order.price_fill,
        String(cumulativeFilledQty)
      );
    }
  }

  // Start REST polling fallback for fill detection
  startPolling(markets: Market[], intervalMs = 2000): void {
    for (const market of markets) {
      if (this.pollingIntervals.has(market.market_id)) continue;
      const interval = setInterval(async () => {
        try {
          const orders = await this.restClient.getOrders({
            market_id: market.market_id,
            contract: this.sessionManager.tradeAccount,
            count: 20,
            direction: 'desc',
          });
          if (orders.length > 0) {
            this.handleOrderUpdates(orders);
          }
        } catch (err) {
          console.error(`[OrderManager] Poll failed for ${market.base.symbol}/${market.quote.symbol}:`, err);
        }
      }, intervalMs);
      this.pollingIntervals.set(market.market_id, interval);
    }
  }

  stopPolling(): void {
    for (const [, interval] of this.pollingIntervals) {
      clearInterval(interval);
    }
    this.pollingIntervals.clear();
  }

  shutdown(): void {
    this.stopPolling();
  }
}
