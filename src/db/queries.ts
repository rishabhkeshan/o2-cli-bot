import { getDb, saveDb } from './index.js';
import type { EncryptedData } from '../auth/encryption.js';

// ---- Sessions ----

export interface SessionRow {
  id: string;
  trade_account_id: string;
  owner_address: string;
  contract_ids: string; // JSON array
  expiry: number;
  created_at: number;
  is_active: number;
}

export function upsertSession(session: {
  id: string;
  tradeAccountId: string;
  ownerAddress: string;
  contractIds: string[];
  expiry: number;
  createdAt: number;
}): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO sessions (id, trade_account_id, owner_address, contract_ids, expiry, created_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [session.id, session.tradeAccountId, session.ownerAddress, JSON.stringify(session.contractIds), session.expiry, session.createdAt]
  );
}

export function getActiveSession(ownerAddress: string): SessionRow | null {
  const db = getDb();
  const results = db.exec(
    `SELECT * FROM sessions WHERE owner_address = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1`,
    [ownerAddress]
  );
  if (!results.length || !results[0].values.length) return null;
  const cols = results[0].columns;
  const vals = results[0].values[0];
  const row: any = {};
  cols.forEach((c, i) => { row[c] = vals[i]; });
  return row as SessionRow;
}

export function deactivateSession(sessionId: string): void {
  const db = getDb();
  db.run(`UPDATE sessions SET is_active = 0 WHERE id = ?`, [sessionId]);
}

// ---- Session Keys ----

export function upsertSessionKey(sessionId: string, encrypted: EncryptedData): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO session_keys (id, encrypted_private_key, salt, iv, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [sessionId, encrypted.encryptedData, encrypted.salt, encrypted.iv, Date.now()]
  );
}

export function getSessionKey(sessionId: string): EncryptedData | null {
  const db = getDb();
  const results = db.exec(
    `SELECT encrypted_private_key, salt, iv FROM session_keys WHERE id = ?`,
    [sessionId]
  );
  if (!results.length || !results[0].values.length) return null;
  const [encryptedData, salt, iv] = results[0].values[0] as string[];
  return { encryptedData, salt, iv };
}

// ---- Strategy Configs ----

export interface StrategyConfigRow {
  id: string;
  market_id: string;
  config: string; // JSON
  is_active: number;
  created_at: number;
  updated_at: number;
  version: number;
}

export function upsertStrategyConfig(marketId: string, config: any, isActive = true): void {
  const db = getDb();
  const now = Date.now();
  const existing = getStrategyConfig(marketId);
  const version = existing ? (existing.version || 0) + 1 : 1;

  db.run(
    `INSERT OR REPLACE INTO strategy_configs (id, market_id, config, is_active, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [marketId, marketId, JSON.stringify(config), isActive ? 1 : 0, existing?.created_at || now, now, version]
  );
}

export function getStrategyConfig(marketId: string): StrategyConfigRow | null {
  const db = getDb();
  const results = db.exec(
    `SELECT * FROM strategy_configs WHERE market_id = ? LIMIT 1`,
    [marketId]
  );
  if (!results.length || !results[0].values.length) return null;
  const cols = results[0].columns;
  const vals = results[0].values[0];
  const row: any = {};
  cols.forEach((c, i) => { row[c] = vals[i]; });
  return row as StrategyConfigRow;
}

export function getActiveStrategies(): StrategyConfigRow[] {
  const db = getDb();
  const results = db.exec(`SELECT * FROM strategy_configs WHERE is_active = 1`);
  if (!results.length) return [];
  return results[0].values.map((vals) => {
    const row: any = {};
    results[0].columns.forEach((c, i) => { row[c] = vals[i]; });
    return row as StrategyConfigRow;
  });
}

// ---- Orders ----

export function insertOrder(order: {
  orderId: string;
  marketId: string;
  side: string;
  orderType: string;
  price: string;
  quantity: string;
  status: string;
  txId?: string;
  strategyName?: string;
}): void {
  const db = getDb();
  const now = Date.now();
  db.run(
    `INSERT OR REPLACE INTO orders (order_id, market_id, side, order_type, price, quantity, status, created_at, updated_at, tx_id, strategy_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [order.orderId, order.marketId, order.side, order.orderType, order.price, order.quantity, order.status, now, now, order.txId || null, order.strategyName || null]
  );
}

export function updateOrderStatus(orderId: string, status: string, priceFill?: string, quantityFill?: string): void {
  const db = getDb();
  const now = Date.now();
  if (priceFill && quantityFill) {
    db.run(
      `UPDATE orders SET status = ?, price_fill = ?, quantity_fill = ?, updated_at = ? WHERE order_id = ?`,
      [status, priceFill, quantityFill, now, orderId]
    );
  } else {
    db.run(`UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?`, [status, now, orderId]);
  }
}

export function getRecentOrders(marketId?: string, limit = 50): any[] {
  const db = getDb();
  let query = `SELECT * FROM orders`;
  const params: any[] = [];
  if (marketId) {
    query += ` WHERE market_id = ?`;
    params.push(marketId);
  }
  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);

  const results = db.exec(query, params);
  if (!results.length) return [];
  return results[0].values.map((vals) => {
    const row: any = {};
    results[0].columns.forEach((c, i) => { row[c] = vals[i]; });
    return row;
  });
}

// ---- Trades ----

export function insertTrade(trade: {
  orderId: string;
  marketId: string;
  side: string;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
  pnlUsdc?: number;
}): void {
  const db = getDb();
  db.run(
    `INSERT INTO trades (order_id, market_id, side, price, size, fee, timestamp, pnl_usdc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [trade.orderId, trade.marketId, trade.side, trade.price, trade.size, trade.fee, trade.timestamp, trade.pnlUsdc ?? null]
  );
}

export function getRecentTrades(marketId?: string, limit = 50): any[] {
  const db = getDb();
  let query = `SELECT * FROM trades`;
  const params: any[] = [];
  if (marketId) {
    query += ` WHERE market_id = ?`;
    params.push(marketId);
  }
  query += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  const results = db.exec(query, params);
  if (!results.length) return [];
  return results[0].values.map((vals) => {
    const row: any = {};
    results[0].columns.forEach((c, i) => { row[c] = vals[i]; });
    return row;
  });
}

export function getTradeStats(marketId?: string): {
  totalTrades: number;
  totalVolume: number;
  totalFees: number;
  realizedPnl: number;
  buyCount: number;
  sellCount: number;
} {
  const db = getDb();
  let query = `SELECT
    COUNT(*) as total_trades,
    COALESCE(SUM(price * size), 0) as total_volume,
    COALESCE(SUM(fee), 0) as total_fees,
    COALESCE(SUM(pnl_usdc), 0) as realized_pnl,
    COALESCE(SUM(CASE WHEN UPPER(side) = 'BUY' THEN 1 ELSE 0 END), 0) as buy_count,
    COALESCE(SUM(CASE WHEN UPPER(side) = 'SELL' THEN 1 ELSE 0 END), 0) as sell_count
    FROM trades`;
  const params: any[] = [];
  if (marketId) {
    query += ` WHERE market_id = ?`;
    params.push(marketId);
  }

  const results = db.exec(query, params);
  if (!results.length || !results[0].values.length) {
    return { totalTrades: 0, totalVolume: 0, totalFees: 0, realizedPnl: 0, buyCount: 0, sellCount: 0 };
  }
  const [totalTrades, totalVolume, totalFees, realizedPnl, buyCount, sellCount] = results[0].values[0] as number[];
  return { totalTrades, totalVolume, totalFees, realizedPnl, buyCount, sellCount };
}

// ---- Snapshots ----

export function insertSnapshot(snapshot: {
  marketId?: string;
  baseBalance: number;
  quoteBalance: number;
  currentPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  sessionPnl: number;
}): void {
  const db = getDb();
  db.run(
    `INSERT INTO snapshots (timestamp, market_id, base_balance, quote_balance, current_price, realized_pnl, unrealized_pnl, session_pnl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [Date.now(), snapshot.marketId || null, snapshot.baseBalance, snapshot.quoteBalance, snapshot.currentPrice, snapshot.realizedPnl, snapshot.unrealizedPnl, snapshot.sessionPnl]
  );
}

// ---- Nonces ----

export function upsertNonce(tradeAccountId: string, nonce: string): void {
  const db = getDb();
  db.run(
    `INSERT OR REPLACE INTO nonces (trade_account_id, nonce, updated_at) VALUES (?, ?, ?)`,
    [tradeAccountId, nonce, Date.now()]
  );
}

export function getNonce(tradeAccountId: string): string | null {
  const db = getDb();
  const results = db.exec(`SELECT nonce FROM nonces WHERE trade_account_id = ?`, [tradeAccountId]);
  if (!results.length || !results[0].values.length) return null;
  return results[0].values[0][0] as string;
}
