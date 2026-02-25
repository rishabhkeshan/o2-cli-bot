export interface MarketAsset {
  symbol: string;
  asset: string; // Asset ID (B256)
  decimals: number;
  min_precision: number;
  max_precision: number;
}

export interface Market {
  market_id: string;
  contract_id: string;
  taker_fee: string;
  maker_fee: string;
  min_order: string;
  dust?: string;
  base: MarketAsset;
  quote: MarketAsset;
  tick_size?: string;
  step_size?: string;
}

export interface MarketsResponse {
  markets: Market[];
  books_whitelist_id?: string;
  accounts_registry_id?: string;
  trade_account_oracle_id?: string;
}

export interface MarketTicker {
  last_price: string;
  bid: string;
  ask: string;
  base_volume: string;
  high: string;
  low: string;
  change: string;
  percentage: string;
}

export interface OrderBookDepth {
  bids: Array<[string, string]>; // [price, quantity]
  asks: Array<[string, string]>;
  timestamp?: number;
}

export interface Bar {
  open: string;
  close: string;
  high: string;
  low: string;
  buy_volume: string;
  sell_volume: string;
  timestamp: string;
}

export interface MarketInfo {
  marketId: string;
  contractId: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseAssetId: string;
  quoteAssetId: string;
  makerFee: number;
  takerFee: number;
  minOrder: number;
}
