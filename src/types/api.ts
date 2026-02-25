export type Identity = { Address: string } | { ContractId: string };

export type Signature = { Secp256k1: string };

export interface SessionAction {
  CreateOrder?: {
    side: string;
    order_type: string;
    price: string;
    quantity: string;
  };
  CancelOrder?: {
    order_id: string;
  };
  SettleBalance?: {
    to: Identity;
  };
}

export interface SessionActionsRequest {
  nonce: string;
  session_id: Identity;
  trade_account_id: string;
  signature: Signature;
  actions: Array<{
    market_id: string;
    actions: SessionAction[];
  }>;
  variable_outputs: number;
  min_gas_limit?: string;
  collect_orders?: boolean;
}

export interface SessionActionsResponse {
  tx_id: string;
  orders?: Array<{ order_id: string }>;
}

export interface CreateSessionRequest {
  nonce: string;
  contract_id: string;
  contract_ids: string[];
  session_id: Identity;
  signature: Signature;
  expiry: string;
  min_gas_limit?: string;
}

export interface GetAccountResponse {
  trade_account_id: string;
  trade_account?: {
    nonce: string;
  };
}

export interface BalanceResponse {
  order_books: Record<string, { locked: string; unlocked: string }>;
  total_fee?: string;
  total_locked: string;
  total_unlocked: string;
  trading_account_balance: string;
}

export interface WsMessage {
  action?: string;
  orders?: any[];
  balance?: any[];
  market_id?: string;
  view?: {
    buys: Array<{ price: string; quantity: string }>;
    sells: Array<{ price: string; quantity: string }>;
  };
  trades?: any[];
}
