export enum OrderSide {
  Buy = 'Buy',
  Sell = 'Sell',
}

export enum OrderType {
  Spot = 'Spot',
  Market = 'Market',
  Limit = 'Limit',
  FillOrKill = 'FillOrKill',
  PostOnly = 'PostOnly',
}

export enum OrderStatus {
  Open = 'open',
  Filled = 'filled',
  Cancelled = 'cancelled',
  Failed = 'failed',
  Pending = 'pending',
  PartiallyFilled = 'partially_filled',
}

export interface Order {
  order_id: string;
  market_id: string;
  side: OrderSide;
  order_type: OrderType;
  price: string;
  price_fill: string;
  quantity: string;
  quantity_fill: string;
  status: OrderStatus;
  cancel: boolean;
  close: boolean;
  partially_filled: boolean;
  created_at: number;
  updated_at: number;
  tx_id?: string;
}

export interface Trade {
  trade_id: string;
  market_id: string;
  price: string;
  quantity: string;
  side: string;
  timestamp: string;
  total: string;
}
