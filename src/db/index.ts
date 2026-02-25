import initSqlJs, { Database } from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';

let db: Database | null = null;
let dbPath: string = '';
let saveInterval: ReturnType<typeof setInterval> | null = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    trade_account_id TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    contract_ids TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS session_keys (
    id TEXT PRIMARY KEY,
    encrypted_private_key TEXT NOT NULL,
    salt TEXT NOT NULL,
    iv TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL,
    order_type TEXT NOT NULL,
    price TEXT NOT NULL,
    price_fill TEXT DEFAULT '0',
    quantity TEXT NOT NULL,
    quantity_fill TEXT DEFAULT '0',
    status TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    tx_id TEXT,
    strategy_name TEXT
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL,
    price REAL NOT NULL,
    size REAL NOT NULL,
    fee REAL DEFAULT 0,
    timestamp INTEGER NOT NULL,
    pnl_usdc REAL
  );

  CREATE TABLE IF NOT EXISTS strategy_configs (
    id TEXT PRIMARY KEY,
    market_id TEXT NOT NULL,
    config TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    market_id TEXT,
    base_balance REAL,
    quote_balance REAL,
    current_price REAL,
    realized_pnl REAL DEFAULT 0,
    unrealized_pnl REAL DEFAULT 0,
    session_pnl REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS nonces (
    trade_account_id TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_trades_market ON trades(market_id);
  CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
  CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots(timestamp);
`;

export async function initDb(dataDir: string): Promise<Database> {
  const SQL = await initSqlJs();

  dbPath = resolve(dataDir, 'o2-cli-bot.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Run schema
  db.run(SCHEMA);

  // Auto-save every 10 seconds
  saveInterval = setInterval(() => {
    saveDb();
  }, 10000);

  return db;
}

export function getDb(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function saveDb(): void {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(dbPath, buffer);
  } catch (err) {
    console.error('[DB] Save failed:', err);
  }
}

export function closeDb(): void {
  if (saveInterval) {
    clearInterval(saveInterval);
    saveInterval = null;
  }
  saveDb();
  if (db) {
    db.close();
    db = null;
  }
}
