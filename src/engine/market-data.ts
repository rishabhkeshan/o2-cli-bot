import { EventEmitter } from 'events';
import type { O2RestClient } from '../api/rest-client.js';
import type { O2WebSocketClient } from '../api/ws-client.js';
import type { Market, MarketTicker, OrderBookDepth, MarketInfo } from '../types/market.js';

export class MarketDataService extends EventEmitter {
  private restClient: O2RestClient;
  private wsClient: O2WebSocketClient;
  private markets: Map<string, Market> = new Map();
  private marketInfos: Map<string, MarketInfo> = new Map();
  private tickers: Map<string, MarketTicker> = new Map();
  private orderBooks: Map<string, OrderBookDepth> = new Map();
  private tickerPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(restClient: O2RestClient, wsClient: O2WebSocketClient) {
    super();
    this.restClient = restClient;
    this.wsClient = wsClient;
    this.setupWsListeners();
  }

  private setupWsListeners(): void {
    this.wsClient.on('depth', (data: { marketId: string; bids: any[]; asks: any[] }) => {
      const book: OrderBookDepth = {
        bids: data.bids,
        asks: data.asks,
        timestamp: Date.now(),
      };
      this.orderBooks.set(data.marketId, book);
      this.emit('depth', data.marketId, book);
    });
  }

  async discoverMarkets(): Promise<Market[]> {
    const resp = await this.restClient.getMarkets();
    for (const market of resp.markets) {
      this.markets.set(market.market_id, market);
      this.marketInfos.set(market.market_id, {
        marketId: market.market_id,
        contractId: market.contract_id,
        baseSymbol: market.base.symbol,
        quoteSymbol: market.quote.symbol,
        baseDecimals: market.base.decimals,
        quoteDecimals: market.quote.decimals,
        baseAssetId: market.base.asset,
        quoteAssetId: market.quote.asset,
        makerFee: parseFloat(market.maker_fee) / 1_000_000,
        takerFee: parseFloat(market.taker_fee) / 1_000_000,
        minOrder: parseFloat(market.min_order),
      });
    }
    return resp.markets;
  }

  getMarket(marketId: string): Market | undefined {
    return this.markets.get(marketId);
  }

  getMarketInfo(marketId: string): MarketInfo | undefined {
    return this.marketInfos.get(marketId);
  }

  getMarketBySymbol(baseSymbol: string, quoteSymbol: string): Market | undefined {
    for (const market of this.markets.values()) {
      if (market.base.symbol === baseSymbol && market.quote.symbol === quoteSymbol) {
        return market;
      }
    }
    return undefined;
  }

  getAllMarkets(): Market[] {
    return Array.from(this.markets.values());
  }

  // Subscribe to real-time depth for specific markets
  subscribeDepth(marketIds: string[]): void {
    this.wsClient.subscribeDepth(marketIds);
  }

  // Get cached or fetch fresh ticker
  async getTicker(marketId: string): Promise<MarketTicker | null> {
    // Always try REST for ticker (WS doesn't provide ticker data)
    const ticker = await this.restClient.getTicker(marketId);
    if (ticker) {
      this.tickers.set(marketId, ticker);
    }
    return this.tickers.get(marketId) || null;
  }

  // Return cached ticker without network call (for TUI rendering)
  getCachedTicker(marketId: string): MarketTicker | null {
    return this.tickers.get(marketId) || null;
  }

  // Get cached orderbook (from WS) or fetch from REST
  async getOrderBook(marketId: string): Promise<OrderBookDepth | null> {
    const cached = this.orderBooks.get(marketId);
    if (cached && cached.timestamp && Date.now() - cached.timestamp < 5000) {
      return cached;
    }
    // Fallback to REST
    const book = await this.restClient.getDepth(marketId);
    if (book) {
      this.orderBooks.set(marketId, { ...book, timestamp: Date.now() });
    }
    return book ? { ...book, timestamp: Date.now() } : null;
  }

  // Return cached orderbook without network call (for TUI rendering)
  getCachedOrderBook(marketId: string): OrderBookDepth | null {
    return this.orderBooks.get(marketId) || null;
  }

  getBestBid(marketId: string): number | null {
    const book = this.orderBooks.get(marketId);
    if (!book || !book.bids.length) return null;
    const market = this.markets.get(marketId);
    if (!market) return null;
    const rawPrice = parseFloat(Array.isArray(book.bids[0]) ? book.bids[0][0] : (book.bids[0] as any).price);
    return rawPrice / 10 ** market.quote.decimals;
  }

  getBestAsk(marketId: string): number | null {
    const book = this.orderBooks.get(marketId);
    if (!book || !book.asks.length) return null;
    const market = this.markets.get(marketId);
    if (!market) return null;
    const rawPrice = parseFloat(Array.isArray(book.asks[0]) ? book.asks[0][0] : (book.asks[0] as any).price);
    return rawPrice / 10 ** market.quote.decimals;
  }

  getMidPrice(marketId: string): number | null {
    const bid = this.getBestBid(marketId);
    const ask = this.getBestAsk(marketId);
    if (bid === null || ask === null) return null;
    return (bid + ask) / 2;
  }

  getSpreadPercent(marketId: string): number | null {
    const bid = this.getBestBid(marketId);
    const ask = this.getBestAsk(marketId);
    if (!bid || !ask) return null;
    const mid = (bid + ask) / 2;
    return ((ask - bid) / mid) * 100;
  }

  // Start periodic ticker polling for active markets
  startTickerPolling(marketIds: string[], intervalMs = 5000): void {
    this.stopTickerPolling();
    this.tickerPollInterval = setInterval(async () => {
      for (const id of marketIds) {
        await this.getTicker(id).catch(() => {});
      }
    }, intervalMs);
  }

  stopTickerPolling(): void {
    if (this.tickerPollInterval) {
      clearInterval(this.tickerPollInterval);
      this.tickerPollInterval = null;
    }
  }

  shutdown(): void {
    this.stopTickerPolling();
  }
}
