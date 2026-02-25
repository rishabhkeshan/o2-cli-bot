#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { initStrategiesDir, resolveStrategy, loadStrategiesFromDir, saveStrategyToFile } from './config/strategy-loader.js';
import { initDb, closeDb, saveDb } from './db/index.js';
import * as dbQueries from './db/queries.js';
import { WalletManager } from './auth/wallet.js';
import { SessionManager } from './auth/session-manager.js';
import { promptPassword } from './auth/password.js';
import { promptInput, promptSecret, promptChoice, promptMultiChoice, promptConfirm } from './auth/prompt.js';
import { O2RestClient } from './api/rest-client.js';
import { O2WebSocketClient } from './api/ws-client.js';
import { MarketDataService } from './engine/market-data.js';
import { BalanceTracker } from './engine/balance-tracker.js';
import { OrderManager } from './engine/order-manager.js';
import { TradingEngine } from './engine/trading-engine.js';
import { PnLCalculator } from './engine/pnl-calculator.js';
import { NotificationManager } from './notifications/index.js';
import { Dashboard } from './tui/dashboard.js';
import { Logger } from './tui/logger.js';
import type { Market } from './types/market.js';
import type { StrategyConfig } from './types/strategy.js';
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import orderBookAbiJson from './types/contracts/orderbook-abi.json' with { type: 'json' };

const program = new Command();

program
  .name('o2-bot')
  .description('CLI-based automated trading bot for O2 Exchange')
  .version('1.0.2');

program
  .command('start', { isDefault: true })
  .description('Start the trading bot')
  .option('-s, --strategy <name>', 'Strategy preset or JSON file name', 'simple')
  .option('-m, --market <pairs...>', 'Market pairs to trade (e.g., ETH_USDC)', ['ETH_USDC'])
  .option('--no-tui', 'Disable TUI dashboard (console logging only)')
  .option('--password <password>', 'Session encryption password (skips prompt)')
  .option('--config <path>', 'Path to a strategy JSON config file')
  .action(async (opts) => {
    await startBot(opts);
  });

program
  .command('markets')
  .description('List available markets on O2')
  .action(async () => {
    await listMarkets();
  });

program
  .command('history')
  .description('Show trade history')
  .option('-m, --market <id>', 'Filter by market ID')
  .option('-n, --limit <number>', 'Number of trades to show', '20')
  .action(async (opts) => {
    await showHistory(opts);
  });

program
  .command('init')
  .description('Initialize strategies directory with preset files')
  .action(async () => {
    const config = loadConfig();
    initStrategiesDir(config.strategiesDir);
    console.log(`Strategy presets created in: ${config.strategiesDir}`);
    console.log('Files: simple.json, volumeMaximizing.json, profitTaking.json');
    console.log('\nEdit these files to customize your trading strategies.');
  });

program.parse();

// ─── Start Bot ─────────────────────────────────────────────

async function interactiveSetup(opts: {
  strategy: string;
  market: string[];
  password?: string;
}): Promise<{
  privateKey: string;
  walletType: 'fuel' | 'evm';
  password: string;
  markets: string[];
  strategy: string;
}> {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      O2 Trading Bot — Setup Wizard       ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // 1. Private key
  const privateKey = await promptSecret('Enter your wallet private key');
  if (!privateKey) { console.error('Private key is required.'); process.exit(1); }

  // 2. Wallet type
  const walletType = await promptChoice('Select wallet type:', ['fuel', 'evm'], 0) as 'fuel' | 'evm';

  // 3. Password
  const password = await promptSecret('Set a session encryption password');
  if (!password) { console.error('Password is required.'); process.exit(1); }

  // 4. Discover markets to let user pick
  console.log('\nFetching available markets...');
  const apiUrl = process.env.O2_API_URL || 'https://api.o2.app';
  const tempClient = new O2RestClient(apiUrl);
  let marketPairs: string[] = [];
  try {
    const resp = await tempClient.getMarkets();
    marketPairs = resp.markets.map(m => `${m.base.symbol}_${m.quote.symbol}`);
  } catch {
    console.error('Could not fetch markets. Using default ETH_USDC.');
    marketPairs = ['ETH_USDC'];
  }

  let selectedMarkets: string[];
  if (marketPairs.length > 1) {
    selectedMarkets = await promptMultiChoice('Select markets to trade:', marketPairs, ['ETH_USDC']);
  } else {
    selectedMarkets = marketPairs;
    console.log(`\nMarket: ${marketPairs[0]}`);
  }

  // 5. Strategy
  const strategies = ['simple', 'volumeMaximizing', 'profitTaking'];
  const strategy = await promptChoice('Select a strategy:', strategies, 0);

  // 6. Offer to save as .env
  const envPath = resolve(process.cwd(), '.env');
  let saveEnv = false;
  if (existsSync(envPath)) {
    console.log('\nWARNING: A .env file already exists.');
    saveEnv = await promptConfirm('Overwrite it?', false);
  } else {
    console.log('\nWARNING: Private key and password will be saved in PLAINTEXT.');
    saveEnv = await promptConfirm('Save settings to .env for future runs?', false);
  }
  if (saveEnv) {
    const lines = [
      `O2_PRIVATE_KEY=${privateKey}`,
      `O2_WALLET_TYPE=${walletType}`,
      `O2_SESSION_PASSWORD=${password}`,
      `O2_API_URL=${apiUrl}`,
      `O2_NETWORK_URL=${process.env.O2_NETWORK_URL || 'https://mainnet.fuel.network/v1/graphql'}`,
      `O2_DATA_DIR=./data`,
      `O2_STRATEGIES_DIR=./strategies`,
      `O2_MARKETS=${selectedMarkets.join(',')}`,
      `O2_STRATEGY=${strategy}`,
    ];
    writeFileSync(envPath, lines.join('\n') + '\n');
    console.log(`Saved to ${envPath}`);
  }
  // Set env vars for this run regardless of save
  process.env.O2_PRIVATE_KEY = privateKey;
  process.env.O2_WALLET_TYPE = walletType;
  process.env.O2_SESSION_PASSWORD = password;

  console.log('\n Starting bot...\n');

  return { privateKey, walletType, password, markets: selectedMarkets, strategy };
}

async function startBot(opts: {
  strategy: string;
  market: string[];
  tui: boolean;
  password?: string;
  config?: string;
}): Promise<void> {
  let config = loadConfig();

  // If no private key configured, run interactive setup
  if (!config.wallet.privateKey) {
    const setup = await interactiveSetup(opts);
    // Apply setup values
    config = loadConfig(); // reload after .env write
    if (!config.wallet.privateKey) {
      // .env wasn't saved, apply manually
      config.wallet.privateKey = setup.privateKey;
      config.wallet.type = setup.walletType;
      config.session.password = setup.password;
    }
    opts.market = setup.markets;
    opts.strategy = setup.strategy;
    opts.password = setup.password;
  }

  // Apply saved markets/strategy from .env if user didn't override via CLI flags
  const cliDefaults = { strategy: 'simple', market: ['ETH_USDC'] };
  if (process.env.O2_MARKETS && opts.market.join(',') === cliDefaults.market.join(',')) {
    opts.market = process.env.O2_MARKETS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (process.env.O2_STRATEGY && opts.strategy === cliDefaults.strategy) {
    opts.strategy = process.env.O2_STRATEGY;
  }

  // Initialize logger
  const logger = new Logger(config.dataDir, 'info');
  logger.info('Starting O2 CLI Trading Bot...', 'Boot');

  // Initialize database
  logger.info('Initializing database...', 'Boot');
  await initDb(config.dataDir);

  // Initialize strategies directory
  initStrategiesDir(config.strategiesDir);

  // Get password for session encryption
  let password = opts.password || config.session.password || '';
  if (!password) {
    password = await promptPassword('Enter session encryption password: ');
    if (!password) {
      console.error('Password is required for session key encryption.');
      process.exit(1);
    }
  }

  // Initialize wallet
  logger.info(`Initializing ${config.wallet.type} wallet...`, 'Boot');
  const walletManager = new WalletManager(config.wallet.privateKey, config.wallet.type);
  await walletManager.init(config.o2.networkUrl);
  logger.info(`Owner address: ${walletManager.ownerAddress}`, 'Boot');

  // Initialize REST client
  const restClient = new O2RestClient(config.o2.apiUrl);

  // Initialize WebSocket client
  const wsClient = new O2WebSocketClient({ url: config.o2.wsUrl });

  // Initialize session manager
  const sessionManager = new SessionManager({
    walletManager,
    restClient,
    password,
    sessionExpiryMs: config.session.expiryMs,
  });

  // Set up session persistence callbacks
  sessionManager.onSessionCreated = async (info, encryptedKey) => {
    dbQueries.upsertSession({
      id: info.sessionId,
      tradeAccountId: info.tradeAccountId,
      ownerAddress: info.ownerAddress,
      contractIds: info.contractIds,
      expiry: info.expiry,
      createdAt: info.createdAt,
    });
    dbQueries.upsertSessionKey(info.sessionId, encryptedKey);
    saveDb();
  };

  sessionManager.onNonceUpdate = async (tradeAccountId, nonce) => {
    dbQueries.upsertNonce(tradeAccountId, nonce);
  };

  // Load OrderBook ABI (imported as JSON module so it works in bun compiled binaries)
  const orderBookAbi = orderBookAbiJson;

  // Initialize session
  logger.info('Setting up trade account and session...', 'Boot');
  await sessionManager.initialize(orderBookAbi);
  logger.info(`Trade account: ${sessionManager.tradeAccount}`, 'Boot');

  // Discover markets
  logger.info('Discovering markets...', 'Boot');
  const marketData = new MarketDataService(restClient, wsClient);
  const allMarkets = await marketData.discoverMarkets();
  logger.info(`Found ${allMarkets.length} markets`, 'Boot');

  // Resolve requested markets
  const requestedMarkets: Market[] = [];
  for (const pair of opts.market) {
    const [base, quote] = pair.split('_');
    const market = marketData.getMarketBySymbol(base, quote);
    if (market) {
      requestedMarkets.push(market);
      logger.info(`Market: ${base}/${quote} (${market.market_id.slice(0, 10)}...)`, 'Boot');
    } else {
      logger.warn(`Market ${pair} not found, skipping`, 'Boot');
    }
  }

  if (requestedMarkets.length === 0) {
    console.error('No valid markets found. Available markets:');
    for (const m of allMarkets) {
      console.log(`  ${m.base.symbol}_${m.quote.symbol}`);
    }
    process.exit(1);
  }

  // Try to restore session or create new one
  const existingSession = dbQueries.getActiveSession(walletManager.ownerAddress);
  let sessionRestored = false;

  if (existingSession) {
    const encryptedKey = dbQueries.getSessionKey(existingSession.id);
    if (encryptedKey) {
      // Check if the session's contract IDs cover the requested markets
      const sessionContracts = new Set<string>(JSON.parse(existingSession.contract_ids));
      const allMarketsInSession = requestedMarkets.every(m => sessionContracts.has(m.contract_id));

      if (!allMarketsInSession) {
        logger.warn('Session does not cover all requested markets, creating new session', 'Boot');
        dbQueries.deactivateSession(existingSession.id);
      } else {
        logger.info('Found existing session, attempting restore...', 'Boot');
        sessionRestored = await sessionManager.restoreSession(
          existingSession.id,
          encryptedKey,
          {
            sessionId: existingSession.id,
            tradeAccountId: existingSession.trade_account_id,
            ownerAddress: existingSession.owner_address,
            contractIds: JSON.parse(existingSession.contract_ids),
            expiry: existingSession.expiry,
            createdAt: existingSession.created_at,
          }
        );
        if (sessionRestored) {
          logger.info('Session restored successfully', 'Boot');
        } else {
          logger.warn('Session restore failed (expired?), creating new session', 'Boot');
          dbQueries.deactivateSession(existingSession.id);
        }
      }
    }
  }

  if (!sessionRestored) {
    logger.info('Creating new session...', 'Boot');
    const sessionInfo = await sessionManager.createNewSession(requestedMarkets);
    logger.info(`Session created: ${sessionInfo.sessionId.slice(0, 10)}...`, 'Boot');
  }

  // Initialize market contracts for order encoding
  for (const market of requestedMarkets) {
    sessionManager.initMarketContract(market);
  }

  // Start session expiry monitoring (auto-renews before expiry)
  sessionManager.startExpiryMonitor();

  // Connect WebSocket
  logger.info('Connecting WebSocket...', 'Boot');
  wsClient.connect();

  // Initialize balance tracker
  const balanceTracker = new BalanceTracker(restClient, wsClient);
  balanceTracker.init(sessionManager.tradeAccount, walletManager.ownerAddress, requestedMarkets);
  balanceTracker.startPolling();

  // Initialize order manager
  const orderManager = new OrderManager(sessionManager, restClient, wsClient);
  orderManager.subscribeOrders();
  await orderManager.seedFillTracker(requestedMarkets);
  orderManager.startPolling(requestedMarkets);

  // Subscribe to depth for all markets
  marketData.subscribeDepth(requestedMarkets.map((m) => m.market_id));
  marketData.startTickerPolling(requestedMarkets.map((m) => m.market_id));

  // Initialize P&L calculator
  const pnlCalc = new PnLCalculator();
  pnlCalc.startSnapshotting();

  // Wire fill events to P&L (estimate fees from market fee rates)
  orderManager.on('fill', (fill) => {
    const market = marketData.getMarket(fill.marketId);
    if (market) {
      // Estimate fee: market orders pay taker fee, limit orders pay maker fee
      const feeRate = parseFloat(market.taker_fee) / 1_000_000; // taker fee as fraction
      const priceHuman = fill.price / 10 ** market.quote.decimals;
      const sizeHuman = fill.sizeBase / 10 ** market.base.decimals;
      fill.fee = priceHuman * sizeHuman * feeRate;
      pnlCalc.recordFill(fill, market.base.decimals, market.quote.decimals);
    }
  });

  // Initialize trading engine
  const engine = new TradingEngine(marketData, balanceTracker, orderManager);

  // Load strategies for each market
  for (const market of requestedMarkets) {
    let strategyConfig: StrategyConfig;

    // Check if there's a persisted config in DB
    const dbConfig = dbQueries.getStrategyConfig(market.market_id);
    if (dbConfig) {
      try {
        strategyConfig = JSON.parse(dbConfig.config);
        logger.info(`Loaded persisted strategy for ${market.base.symbol}/${market.quote.symbol}`, 'Boot');
      } catch {
        strategyConfig = resolveStrategy(
          opts.config || opts.strategy,
          market.market_id,
          config.strategiesDir
        );
      }
    } else {
      strategyConfig = resolveStrategy(
        opts.config || opts.strategy,
        market.market_id,
        config.strategiesDir
      );
    }

    // Persist strategy config
    dbQueries.upsertStrategyConfig(market.market_id, strategyConfig);

    engine.addMarket(market, strategyConfig);
    logger.info(
      `Strategy "${strategyConfig.name}" loaded for ${market.base.symbol}/${market.quote.symbol}`,
      'Boot'
    );
  }

  // Initialize notifications
  const notifications = new NotificationManager(config);

  // Wire engine events to notifications
  let shuttingDown = false;

  engine.on('started', () => {
    notifications.notify('BOT_STARTED', 'Trading bot started');
  });
  engine.on('stopped', () => {
    if (!shuttingDown) notifications.notify('BOT_STOPPED', 'Trading bot stopped');
  });
  engine.on('error', (marketId: string, err: Error) => {
    logger.error(`${err.message}`, marketId.slice(0, 8));
    notifications.notify('ERROR', `Market ${marketId}: ${err.message}`);
  });
  orderManager.on('fill', (fill) => {
    const market = marketData.getMarket(fill.marketId);
    if (market) {
      const priceHuman = fill.price / 10 ** market.quote.decimals;
      const sizeHuman = fill.sizeBase / 10 ** market.base.decimals;
      const pair = `${market.base.symbol}/${market.quote.symbol}`;
      logger.info(`FILLED ${fill.side} ${sizeHuman.toFixed(6)} ${market.base.symbol} @ $${priceHuman.toFixed(4)} (${pair})`, 'Fill');
      notifications.notify(
        'ORDER_FILLED',
        `${fill.side} ${sizeHuman.toFixed(6)} ${market.base.symbol} @ $${priceHuman.toFixed(4)}`
      );
    }
  });

  // Initialize TUI Dashboard
  const dashboard = new Dashboard({
    engine,
    pnlCalc,
    marketData,
    balanceTracker,
    restClient,
    orderManager,
    logger,
    noTui: !opts.tui,
    onQuit: () => shutdown(),
    markets: requestedMarkets,
  });

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down...', 'Shutdown');
    await notifications.notify('BOT_STOPPED', 'Trading bot shutting down');

    // Stop trading
    engine.shutdown();

    // Cancel all open orders
    logger.info('Cancelling open orders...', 'Shutdown');
    try {
      await engine.cancelAllOrders();
    } catch (err) {
      logger.error(`Failed to cancel orders: ${err}`, 'Shutdown');
    }

    // Cleanup
    orderManager.shutdown();
    balanceTracker.shutdown();
    marketData.shutdown();
    pnlCalc.shutdown();
    wsClient.disconnect();
    await sessionManager.shutdown();
    dashboard.shutdown();
    closeDb();

    logger.info('Shutdown complete', 'Shutdown');
    process.exit(0);
  }

  // Signal handlers — ensure async shutdown completes before exit
  const signalHandler = () => { shutdown().catch(() => process.exit(1)); };
  process.on('SIGINT', signalHandler);
  process.on('SIGTERM', signalHandler);
  process.on('SIGHUP', signalHandler);

  // Fetch initial balances
  logger.info('Fetching initial balances...', 'Boot');
  for (const market of requestedMarkets) {
    try {
      const balances = await balanceTracker.getMarketBalances(market.market_id);
      const baseHuman = parseFloat(balances.base.unlocked) / 10 ** market.base.decimals;
      const quoteHuman = parseFloat(balances.quote.unlocked) / 10 ** market.quote.decimals;
      logger.info(
        `${market.base.symbol}/${market.quote.symbol}: ${baseHuman.toFixed(6)} ${market.base.symbol}, ${quoteHuman.toFixed(2)} ${market.quote.symbol}`,
        'Balance'
      );
    } catch {
      logger.warn(`Failed to fetch balances for ${market.base.symbol}/${market.quote.symbol}`, 'Balance');
    }
  }

  // Start dashboard
  dashboard.start();

  // Start trading!
  logger.info('Starting trading engine...', 'Boot');
  engine.start();

  logger.info('Bot is running. Press q to quit, p to pause/resume.', 'Boot');
}

// ─── List Markets ──────────────────────────────────────────

async function listMarkets(): Promise<void> {
  const config = loadConfig();
  const restClient = new O2RestClient(config.o2.apiUrl);

  console.log('Fetching available markets...\n');
  const resp = await restClient.getMarkets();

  console.log('Available Markets:');
  console.log('─'.repeat(70));
  console.log(
    'Pair'.padEnd(15) +
    'Market ID'.padEnd(20) +
    'Maker Fee'.padEnd(12) +
    'Taker Fee'.padEnd(12) +
    'Min Order'
  );
  console.log('─'.repeat(70));

  for (const m of resp.markets) {
    const pair = `${m.base.symbol}/${m.quote.symbol}`;
    const marketId = m.market_id.slice(0, 16) + '...';
    const makerFee = (parseFloat(m.maker_fee) / 1_000_000 * 100).toFixed(3) + '%';
    const takerFee = (parseFloat(m.taker_fee) / 1_000_000 * 100).toFixed(3) + '%';
    const minOrder = m.min_order;
    console.log(
      pair.padEnd(15) +
      marketId.padEnd(20) +
      makerFee.padEnd(12) +
      takerFee.padEnd(12) +
      minOrder
    );
  }
}

// ─── Show History ──────────────────────────────────────────

async function showHistory(opts: { market?: string; limit: string }): Promise<void> {
  const config = loadConfig();
  await initDb(config.dataDir);

  const limit = parseInt(opts.limit) || 20;
  const trades = dbQueries.getRecentTrades(opts.market, limit);
  const stats = dbQueries.getTradeStats(opts.market);

  console.log('\nTrade History:');
  console.log('─'.repeat(80));
  console.log(
    'Time'.padEnd(20) +
    'Side'.padEnd(6) +
    'Price'.padEnd(12) +
    'Size'.padEnd(12) +
    'Fee'.padEnd(10) +
    'P&L'
  );
  console.log('─'.repeat(80));

  for (const t of trades) {
    const time = new Date(t.timestamp).toLocaleString();
    const side = t.side;
    const price = `$${t.price.toFixed(2)}`;
    const size = t.size.toFixed(6);
    const fee = `$${t.fee.toFixed(4)}`;
    const pnl = t.pnl_usdc ? `$${t.pnl_usdc.toFixed(4)}` : '-';
    console.log(
      time.padEnd(20) +
      side.padEnd(6) +
      price.padEnd(12) +
      size.padEnd(12) +
      fee.padEnd(10) +
      pnl
    );
  }

  console.log('─'.repeat(80));
  console.log(`\nSummary:`);
  console.log(`  Total Trades: ${stats.totalTrades} (${stats.buyCount} buys, ${stats.sellCount} sells)`);
  console.log(`  Total Volume: $${stats.totalVolume.toFixed(2)}`);
  console.log(`  Total Fees:   $${stats.totalFees.toFixed(4)}`);
  console.log(`  Realized P&L: $${stats.realizedPnl.toFixed(4)}`);

  closeDb();
}
