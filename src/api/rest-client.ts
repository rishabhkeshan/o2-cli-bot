import axios, { AxiosInstance, AxiosError } from 'axios';
import type { Market, MarketsResponse, MarketTicker, OrderBookDepth, Bar } from '../types/market.js';
import type { Order, OrderStatus, Trade } from '../types/order.js';
import type {
  SessionActionsRequest, SessionActionsResponse,
  CreateSessionRequest, GetAccountResponse, BalanceResponse
} from '../types/api.js';
import type { Competition, LeaderboardResponse, SubRankings, PrizePool } from '../types/competition.js';

export class O2RestClient {
  private http: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Rate limit retry interceptor: on 429, exponential backoff (1s, 2s, 4s), max 3 retries
    this.http.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const config = error.config as any;
        if (error.response?.status === 429 && (!config._retryCount || config._retryCount < 3)) {
          config._retryCount = (config._retryCount || 0) + 1;
          const delay = Math.min(1000 * Math.pow(2, config._retryCount - 1), 5000);
          await new Promise((r) => setTimeout(r, delay));
          return this.http(config);
        }
        throw error;
      }
    );
  }

  // Markets
  async getMarkets(): Promise<MarketsResponse> {
    const { data } = await this.http.get<MarketsResponse>('/v1/markets');
    return data;
  }

  async getTicker(marketId: string): Promise<MarketTicker | null> {
    try {
      const { data } = await this.http.get('/v1/markets/ticker', {
        params: { market_id: marketId },
      });
      // API returns array, take first element
      const ticker = Array.isArray(data) ? data[0] : data;
      if (!ticker) return null;
      return {
        last_price: ticker.last || ticker.last_price || '0',
        bid: ticker.bid || '0',
        ask: ticker.ask || '0',
        base_volume: ticker.base_volume || '0',
        high: ticker.high || '0',
        low: ticker.low || '0',
        change: ticker.change || '0',
        percentage: ticker.percentage || '0',
      };
    } catch {
      return null;
    }
  }

  async getDepth(marketId: string, precision = 100): Promise<OrderBookDepth | null> {
    try {
      const { data } = await this.http.get('/v1/depth', {
        params: { market_id: marketId, precision },
      });
      // Handle both formats: {bids, asks} and {orders: {buys, sells}}
      let bids: Array<[string, string]> = [];
      let asks: Array<[string, string]> = [];
      if (data.bids && data.asks) {
        bids = data.bids;
        asks = data.asks;
      } else if (data.orders) {
        // API returns {price, quantity} objects — normalize to [price, quantity] tuples
        const rawBuys = data.orders.buys || [];
        const rawSells = data.orders.sells || [];
        bids = rawBuys.map((b: any) => Array.isArray(b) ? b : [b.price, b.quantity]);
        asks = rawSells.map((a: any) => Array.isArray(a) ? a : [a.price, a.quantity]);
      }
      return { bids, asks, timestamp: data.timestamp };
    } catch {
      return null;
    }
  }

  async getTrades(marketId: string, count = 20): Promise<Trade[]> {
    try {
      const { data } = await this.http.get('/v1/trades', {
        params: { market_id: marketId, count, direction: 'desc' },
      });
      return data.trades || [];
    } catch {
      return [];
    }
  }

  // Bars (OHLC candlestick data)
  async getBars(marketId: string, resolution = '5m', countBack = 50): Promise<Bar[]> {
    try {
      const now = Date.now();
      const from = now - countBack * this.resolutionToMs(resolution);
      const { data } = await this.http.get('/v1/bars', {
        params: {
          market_id: marketId,
          from: from.toString(),
          to: now.toString(),
          resolution,
          count_back: countBack,
        },
      });
      return data.bars || [];
    } catch {
      return [];
    }
  }

  private resolutionToMs(resolution: string): number {
    const map: Record<string, number> = {
      '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000,
      '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000,
    };
    return map[resolution] || 300000;
  }

  // Account
  async createTradingAccount(ownerAddress: string): Promise<string> {
    try {
      const { data } = await this.http.post('/v1/accounts', {
        identity: { Address: ownerAddress },
      });
      return data.trade_account_id;
    } catch (err: any) {
      // 409 = account already exists
      if (err?.response?.status === 409 || err?.response?.data?.trade_account_id) {
        return err.response.data.trade_account_id;
      }
      throw err;
    }
  }

  async getAccount(tradeAccountId: string, ownerId: string): Promise<GetAccountResponse> {
    const { data } = await this.http.get<GetAccountResponse>('/v1/accounts', {
      params: { trade_account_id: tradeAccountId },
      headers: { 'O2-Owner-Id': ownerId },
    });
    return data;
  }

  async getAccountByOwner(ownerAddress: string): Promise<GetAccountResponse> {
    const { data } = await this.http.get<GetAccountResponse>('/v1/accounts', {
      params: { owner: ownerAddress },
    });
    return data;
  }

  // Session
  async createSession(request: CreateSessionRequest, ownerId: string): Promise<any> {
    const { data } = await this.http.put('/v1/session', request, {
      headers: { 'O2-Owner-Id': ownerId },
    });
    return data;
  }

  // Session Actions (orders, cancellations)
  async submitSessionActions(
    request: SessionActionsRequest,
    ownerId: string
  ): Promise<SessionActionsResponse> {
    const { data } = await this.http.post<SessionActionsResponse>('/v1/session/actions', request, {
      headers: { 'O2-Owner-Id': ownerId },
      timeout: 10000,
    });
    return data;
  }

  // Orders
  async getOrders(params: {
    market_id: string;
    contract: string;
    direction?: string;
    count?: number;
    is_open?: boolean;
    start_timestamp?: string;
    start_order_id?: string;
  }): Promise<Order[]> {
    try {
      const { data } = await this.http.get('/v1/orders', { params });
      return (data.orders || []).map((o: any) => this.mapOrder(o));
    } catch {
      return [];
    }
  }

  async getOrder(orderId: string, marketId: string): Promise<Order | null> {
    try {
      const { data } = await this.http.get('/v1/order', {
        params: { order_id: orderId, market_id: marketId },
      });
      return data.order ? this.mapOrder(data.order) : null;
    } catch {
      return null;
    }
  }

  // Balance
  async getBalance(assetId: string, contractId: string, ownerId?: string): Promise<BalanceResponse> {
    const headers: Record<string, string> = {};
    if (ownerId) headers['O2-Owner-Id'] = ownerId;
    const { data } = await this.http.get<BalanceResponse>('/v1/balance', {
      params: { asset_id: assetId, contract: contractId },
      headers,
    });
    return data;
  }

  // Competition / Leaderboard
  async getCompetitions(): Promise<Competition[]> {
    try {
      const { data } = await this.http.get('/analytics/v1/competition/list');
      const raw: any[] = data.competitions || data || [];
      return raw.map((c: any) => ({
        competitionId: c.competitionId || c.competition_id || '',
        slug: c.slug || '',
        title: c.title || '',
        subtitle: c.subtitle || '',
        startDate: c.startDate || c.start_date || '',
        endDate: c.endDate || c.end_date || '',
        totalTraders: c.totalTraders ?? c.total_traders ?? 0,
        totalVolume: String(c.totalVolume ?? c.total_volume ?? '0'),
        layout: c.assets?.layout || c.layout || 'standard',
        marketBoosts: c.marketBoosts || c.market_boosts || undefined,
        streakConfig: c.streakConfig || c.streak_config || undefined,
        placeholderVolumeTarget: c.placeholderVolumeTarget != null ? String(c.placeholderVolumeTarget) : undefined,
      }));
    } catch {
      return [];
    }
  }

  async getLeaderboard(competitionId: string, walletAddress: string): Promise<LeaderboardResponse | null> {
    try {
      // Normalize: strip Fuel B256 zero-padding (0x000...{24 zeros}...addr) back to EVM 0x{40} format
      let addr = walletAddress.toLowerCase();
      const clean = addr.replace('0x', '');
      if (clean.length === 64 && clean.startsWith('000000000000000000000000')) {
        addr = '0x' + clean.slice(24);
      }
      const { data } = await this.http.get('/analytics/v1/competition/leaderboard', {
        params: {
          competition_id: competitionId,
          current_address: addr,
        },
      });
      if (!data) return null;

      const raw = data.currentUser;
      const currentUser = raw ? {
        rank: parseInt(raw.rank) || 0,
        score: String(raw.score ?? '0'),
        volume: String(raw.volume ?? '0'),
        volume24h: String(raw.volume24h ?? raw.volume_24h ?? '0'),
        boostedVolume: raw.boostedVolume != null ? String(raw.boostedVolume) : undefined,
        pnl: String(raw.pnl ?? '0'),
        realizedPnl: String(raw.realizedPnl ?? raw.realized_pnl ?? '0'),
        referralVolume: String(raw.referralVolume ?? raw.referral_volume ?? '0'),
        superBoostStatus: raw.superBoostStatus ?? raw.super_boost_status ?? undefined,
        streak: raw.streak || undefined,
        lottery: raw.lottery || undefined,
      } : null;

      const subRankings: SubRankings = {};
      if (data.currentUserSubRankingTaker) {
        subRankings.taker = {
          rank: parseInt(data.currentUserSubRankingTaker.rank) || 0,
          volume: String(data.currentUserSubRankingTaker.volume ?? '0'),
          score: String(data.currentUserSubRankingTaker.score ?? '0'),
        };
      }
      if (data.currentUserSubRankingMaker) {
        subRankings.maker = {
          rank: parseInt(data.currentUserSubRankingMaker.rank) || 0,
          volume: String(data.currentUserSubRankingMaker.volume ?? '0'),
          score: String(data.currentUserSubRankingMaker.score ?? '0'),
        };
      }
      if (data.currentUserSubRankingPnl) {
        subRankings.pnl = {
          rank: parseInt(data.currentUserSubRankingPnl.rank) || 0,
          pnl: String(data.currentUserSubRankingPnl.realizedPnl ?? data.currentUserSubRankingPnl.pnl ?? data.currentUserSubRankingPnl.score ?? '0'),
          score: String(data.currentUserSubRankingPnl.score ?? '0'),
        };
      }
      if (data.currentUserDailyRace) {
        subRankings.lottery = {
          rank: parseInt(data.currentUserDailyRace.rank) || 0,
          tickets: data.currentUserDailyRace.dailyTicketsEarned ?? data.currentUserDailyRace.tickets ?? 0,
          wins: data.currentUserDailyRace.wins ?? 0,
        };
      }

      // Parse prize pool
      let prizePool: PrizePool | undefined;
      if (data.prizePool?.milestones) {
        prizePool = {
          milestones: data.prizePool.milestones.map((m: any) => ({
            targetVolume: String(m.targetVolume ?? '0'),
            rewardPool: String(m.rewardPool ?? '0'),
          })),
          activeMilestone: {
            targetVolume: String(data.prizePool.activeMilestone?.targetVolume ?? '0'),
            rewardPool: String(data.prizePool.activeMilestone?.rewardPool ?? '0'),
          },
        };
      }

      return {
        title: data.title || '',
        currentUser,
        subRankings: Object.keys(subRankings).length > 0 ? subRankings : undefined,
        totalTraders: parseInt(data.totalTraders) || 0,
        totalVolume: String(data.totalVolume ?? '0'),
        prizePool,
        marketBoosts: data.marketBoosts || undefined,
        streakConfig: data.streakConfig || undefined,
      };
    } catch {
      return null;
    }
  }

  // Map API order format to internal Order type
  private mapOrder(o: any): Order {
    let status: OrderStatus;
    if (o.status) {
      // Direct status string from some endpoints
      status = o.status as OrderStatus;
    } else {
      // Derive from boolean flags
      if (o.cancel) status = 'cancelled' as OrderStatus;
      else if (o.close && !o.partially_filled) status = 'filled' as OrderStatus;
      else if (o.partially_filled) status = 'partially_filled' as OrderStatus;
      else status = 'open' as OrderStatus;
    }

    return {
      order_id: o.order_id || '',
      market_id: o.market_id || '',
      side: o.side === 'buy' || o.side === 'Buy' ? 'Buy' : 'Sell',
      order_type: o.order_type || 'Market',
      price: o.price || '0',
      price_fill: o.price_fill || '0',
      quantity: o.quantity || '0',
      quantity_fill: o.quantity_fill || '0',
      status,
      cancel: o.cancel || false,
      close: o.close || false,
      partially_filled: o.partially_filled || false,
      created_at: parseInt(o.timestamp || o.created_at || '0'),
      updated_at: parseInt(o.updated_at || o.timestamp || '0'),
      tx_id: o.tx_id,
    } as Order;
  }
}
