import { EventEmitter } from 'events';
import type { O2RestClient } from '../api/rest-client.js';
import type { O2WebSocketClient } from '../api/ws-client.js';
import type { Market } from '../types/market.js';

export interface MarketBalances {
  base: { unlocked: string; locked: string; total: string };
  quote: { unlocked: string; locked: string; total: string };
  lastUpdated: number;
}

export class BalanceTracker extends EventEmitter {
  private restClient: O2RestClient;
  private wsClient: O2WebSocketClient;
  private balances: Map<string, MarketBalances> = new Map();
  private tradeAccountId: string = '';
  private ownerAddress: string = '';
  private markets: Map<string, Market> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private cacheTtlMs = 3000;

  constructor(restClient: O2RestClient, wsClient: O2WebSocketClient) {
    super();
    this.restClient = restClient;
    this.wsClient = wsClient;
    this.setupWsListeners();
  }

  private setupWsListeners(): void {
    this.wsClient.on('balances', (balanceUpdates: any[]) => {
      for (const bal of balanceUpdates) {
        // Match asset_id to markets
        for (const [marketId, market] of this.markets) {
          let updated = false;
          const existing = this.balances.get(marketId) || this.emptyBalance();

          if (bal.asset_id === market.base.asset) {
            existing.base = {
              unlocked: bal.total_unlocked || '0',
              locked: bal.total_locked || '0',
              total: String(BigInt(bal.total_unlocked || '0') + BigInt(bal.total_locked || '0')),
            };
            updated = true;
          }
          if (bal.asset_id === market.quote.asset) {
            existing.quote = {
              unlocked: bal.total_unlocked || '0',
              locked: bal.total_locked || '0',
              total: String(BigInt(bal.total_unlocked || '0') + BigInt(bal.total_locked || '0')),
            };
            updated = true;
          }

          if (updated) {
            existing.lastUpdated = Date.now();
            this.balances.set(marketId, existing);
            this.emit('balanceUpdate', marketId, existing);
          }
        }
      }
    });
  }

  init(tradeAccountId: string, ownerAddress: string, markets: Market[]): void {
    this.tradeAccountId = tradeAccountId;
    this.ownerAddress = ownerAddress;
    for (const m of markets) {
      this.markets.set(m.market_id, m);
    }

    // Subscribe to balance updates via WebSocket
    this.wsClient.subscribeBalances([{ ContractId: tradeAccountId }]);
  }

  async getMarketBalances(marketId: string): Promise<MarketBalances> {
    const cached = this.balances.get(marketId);
    if (cached && Date.now() - cached.lastUpdated < this.cacheTtlMs) {
      return cached;
    }

    const market = this.markets.get(marketId);
    if (!market) throw new Error(`Unknown market: ${marketId}`);

    // Fetch from REST
    const [baseResp, quoteResp] = await Promise.all([
      this.restClient.getBalance(market.base.asset, this.tradeAccountId, this.ownerAddress),
      this.restClient.getBalance(market.quote.asset, this.tradeAccountId, this.ownerAddress),
    ]);

    const balances: MarketBalances = {
      base: {
        unlocked: baseResp.total_unlocked || '0',
        locked: baseResp.total_locked || '0',
        total: String(BigInt(baseResp.total_unlocked || '0') + BigInt(baseResp.total_locked || '0')),
      },
      quote: {
        unlocked: quoteResp.total_unlocked || '0',
        locked: quoteResp.total_locked || '0',
        total: String(BigInt(quoteResp.total_unlocked || '0') + BigInt(quoteResp.total_locked || '0')),
      },
      lastUpdated: Date.now(),
    };

    this.balances.set(marketId, balances);
    return balances;
  }

  getBaseBalanceHuman(marketId: string): number {
    const cached = this.balances.get(marketId);
    const market = this.markets.get(marketId);
    if (!cached || !market) return 0;
    return parseFloat(cached.base.unlocked) / 10 ** market.base.decimals;
  }

  getQuoteBalanceHuman(marketId: string): number {
    const cached = this.balances.get(marketId);
    const market = this.markets.get(marketId);
    if (!cached || !market) return 0;
    return parseFloat(cached.quote.unlocked) / 10 ** market.quote.decimals;
  }

  clearCache(marketId?: string): void {
    if (marketId) {
      this.balances.delete(marketId);
    } else {
      this.balances.clear();
    }
  }

  startPolling(intervalMs = 10000): void {
    this.stopPolling();
    this.pollInterval = setInterval(async () => {
      for (const marketId of this.markets.keys()) {
        await this.getMarketBalances(marketId).catch(() => {});
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private emptyBalance(): MarketBalances {
    return {
      base: { unlocked: '0', locked: '0', total: '0' },
      quote: { unlocked: '0', locked: '0', total: '0' },
      lastUpdated: 0,
    };
  }

  shutdown(): void {
    this.stopPolling();
  }
}
