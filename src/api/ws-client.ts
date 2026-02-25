import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Identity, WsMessage } from '../types/api.js';

export interface WsConfig {
  url: string;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  pingInterval?: number;
}

export class O2WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: Required<WsConfig>;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private currentReconnectDelay: number;
  private shouldReconnect = true;
  private subscriptions: Array<{ action: string; payload: any }> = [];

  constructor(config: WsConfig) {
    super();
    this.config = {
      url: config.url,
      reconnectDelay: config.reconnectDelay || 1000,
      maxReconnectDelay: config.maxReconnectDelay || 30000,
      pingInterval: config.pingInterval || 15000,
    };
    this.currentReconnectDelay = this.config.reconnectDelay;
  }

  connect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
    }

    const wsUrl = `${this.config.url}/v1/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.currentReconnectDelay = this.config.reconnectDelay;
      this.emit('connected');
      // Re-subscribe to all previous subscriptions
      for (const sub of this.subscriptions) {
        this.send(sub.payload);
      }
      // Start heartbeat
      this.startPing();
    });

    this.ws.on('message', (data) => {
      try {
        const msg: WsMessage = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        // Ignore parse errors
      }
    });

    this.ws.on('close', () => {
      this.emit('disconnected');
      this.stopPing();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  private handleMessage(msg: WsMessage): void {
    if (!msg.action) return;

    switch (msg.action) {
      case 'subscribe_depth_view':
        if (msg.view) {
          this.emit('depth', {
            marketId: msg.market_id,
            bids: msg.view.buys?.map((b: any) => [b.price, b.quantity]) || [],
            asks: msg.view.sells?.map((a: any) => [a.price, a.quantity]) || [],
          });
        }
        break;
      case 'subscribe_orders':
        if (msg.orders) {
          this.emit('orders', msg.orders);
        }
        break;
      case 'subscribe_trades':
        if (msg.trades) {
          this.emit('trades', { marketId: msg.market_id, trades: msg.trades });
        }
        break;
      case 'subscribe_balances':
        if (msg.balance) {
          this.emit('balances', msg.balance);
        }
        break;
      case 'ping':
        // Pong received
        break;
    }
  }

  // Subscription methods
  subscribeDepth(marketIds: string[], precision = 100, frequency = '500ms'): void {
    const payload = { action: 'subscribe_depth_view', market_ids: marketIds, precision, frequency };
    this.addSubscription('depth', payload);
    this.send(payload);
  }

  subscribeOrders(identities: Identity[]): void {
    const payload = { action: 'subscribe_orders', identities };
    this.addSubscription('orders', payload);
    this.send(payload);
  }

  subscribeTrades(marketIds: string[]): void {
    const payload = { action: 'subscribe_trades', market_ids: marketIds };
    this.addSubscription('trades', payload);
    this.send(payload);
  }

  subscribeBalances(identities: Identity[]): void {
    const payload = { action: 'subscribe_balances', identities };
    this.addSubscription('balances', payload);
    this.send(payload);
  }

  private addSubscription(action: string, payload: any): void {
    // Remove existing subscription of same type
    this.subscriptions = this.subscriptions.filter((s) => s.action !== action);
    this.subscriptions.push({ action, payload });
  }

  private send(payload: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ action: 'ping' });
    }, this.config.pingInterval);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      // Exponential backoff
      this.currentReconnectDelay = Math.min(
        this.currentReconnectDelay * 2,
        this.config.maxReconnectDelay
      );
    }, this.currentReconnectDelay);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.subscriptions = [];
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
