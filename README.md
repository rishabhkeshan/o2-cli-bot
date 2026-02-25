# O2 CLI Bot

A CLI-based automated trading bot for [O2 Exchange](https://o2.app) on the Fuel Network. Features a real-time TUI dashboard, multiple trading strategies, session encryption, and multi-market support.

## Install

### Homebrew (macOS / Linux)

```bash
brew install rishabhkeshan/tap/o2-bot
```

### npm

```bash
npm install -g o2-cli-bot
```

### npx (no install)

```bash
npx o2-cli-bot
```

### Binary Download

Download standalone binaries from [GitHub Releases](https://github.com/rishabhkeshan/o2-cli-bot/releases):

| Platform | Binary |
|----------|--------|
| macOS (Apple Silicon) | `o2-bot-macos-arm64` |
| macOS (Intel) | `o2-bot-macos-x64` |
| Linux (x64) | `o2-bot-linux-x64` |

```bash
# Example: download, make executable, and run
curl -L https://github.com/rishabhkeshan/o2-cli-bot/releases/latest/download/o2-bot-macos-arm64 -o o2-bot
chmod +x o2-bot
./o2-bot
```

---

## Quick Start

Run with no arguments to launch the interactive setup wizard:

```bash
o2-bot
```

The wizard walks you through:
1. Entering your wallet private key
2. Selecting wallet type (Fuel or EVM)
3. Setting a session encryption password
4. Choosing which markets to trade
5. Picking a strategy preset
6. Optionally saving config to `.env`

---

## Usage

### Start the Bot

```bash
# Interactive wizard (first run, no .env)
o2-bot

# With specific strategy and market
o2-bot -s simple -m ETH_USDC

# Multiple markets
o2-bot -m ETH_USDC FUEL_USDC BTC_USDC

# Without TUI (log-only mode, good for servers)
o2-bot --no-tui

# Skip password prompt
o2-bot --password mypassword

# Use a custom strategy file
o2-bot --config ./my-strategy.json

# Combine options
o2-bot --no-tui -s volumeMaximizing -m FUEL_USDC --password mypass
```

### Other Commands

```bash
# List all available markets on O2
o2-bot markets

# Show recent trade history
o2-bot history

# Show last 50 trades
o2-bot history -n 50

# Filter history by market
o2-bot history -m ETH_USDC

# Create editable strategy files in ./strategies/
o2-bot init

# Help
o2-bot --help
```

### Start Options Reference

| Flag | Description | Default |
|------|-------------|---------|
| `-s, --strategy <name>` | Strategy preset or JSON file name | `simple` |
| `-m, --market <pairs...>` | Market pairs (space-separated) | `ETH_USDC` |
| `--no-tui` | Disable TUI, use console logging | TUI enabled |
| `--password <password>` | Session encryption password | Prompts interactively |
| `--config <path>` | Path to strategy JSON file | — |

---

## TUI Dashboard

The bot ships with a full-screen terminal dashboard showing real-time data.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ETH/USDC  $1,915.23  +2.1%   RUNNING  Uptime: 01:23:45   │
├──────────────────────────────────┬──────────────────────────┤
│                                  │       ORDER BOOK         │
│        CANDLESTICK CHART         │  Ask: 1915.50  0.5 ETH  │
│         (1m/5m/15m/1h/4h/1d)    │  Ask: 1915.40  1.2 ETH  │
│                                  │  ────────────────────    │
│                                  │  Bid: 1915.20  0.8 ETH  │
│                                  │  Bid: 1915.10  2.1 ETH  │
├──────────────────────────────────┼──────────────────────────┤
│  BALANCES & P&L                  │       ACTIVITY LOG       │
│  ETH: 1.234567  USDC: 2,500.00 │  [12:01] Buy filled ...  │
│  P&L: +$12.34   Trades: 48     │  [12:02] Sell placed ... │
└──────────────────────────────────┴──────────────────────────┘
```

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `q` / `Ctrl+C` | Quit (graceful shutdown) |
| `p` | Pause / resume trading |
| `[` | Previous market |
| `]` | Next market |
| `r` | Cycle chart timeframe (1m → 5m → 15m → 1h → 4h → 1d) |

When trading multiple markets, the header shows your position like `(1/3)`.

### Console Mode

Use `--no-tui` for headless environments (servers, Docker, CI). All events are printed to stdout.

---

## Strategies

### Built-in Presets

| Preset | Style | Order Type | Spread | Profit Target | Speed |
|--------|-------|------------|--------|---------------|-------|
| `simple` | Balanced | Limit | 2% max | Sell above avg buy | 3-5s |
| `volumeMaximizing` | Aggressive | Market | 5% max | None | 1-2s |
| `profitTaking` | Conservative | Limit | 1.5% max | 0.1% min margin | 4-7s |

### Customizing Strategies

Generate editable preset files:

```bash
o2-bot init
```

This creates JSON files in `./strategies/`:

```
strategies/
├── simple.json
├── volumeMaximizing.json
└── profitTaking.json
```

Edit any file, then run with it:

```bash
# By preset name (looks in ./strategies/)
o2-bot -s simple

# By file path
o2-bot --config ./strategies/my-custom.json
```

### Strategy Config Fields

```jsonc
{
  "name": "my-strategy",
  "isActive": true,

  // Order placement
  "orderType": "Spot",                    // "Spot" (limit) or "Market"
  "priceMode": "offsetFromMid",           // "offsetFromMid", "offsetFromBestBid", "offsetFromBestAsk", "market"
  "priceOffsetPercent": 0.1,              // % offset from reference price
  "maxSpreadPercent": 2.0,                // Skip cycle if spread exceeds this
  "side": "Both",                         // "Buy", "Sell", or "Both"

  // Position sizing
  "sizeMode": "percentageOfBalance",      // "percentageOfBalance" or "fixedUsd"
  "baseBalancePercentage": 50,            // % of base balance for sells
  "quoteBalancePercentage": 50,           // % of quote balance for buys
  "fixedUsdAmount": 100,                  // Used when sizeMode is "fixedUsd"
  "minOrderSizeUsd": 5,                   // Minimum order size in USD
  "maxOrderSizeUsd": 1000,               // Maximum order size in USD (optional)

  // Risk management
  "onlySellAboveBuyPrice": true,          // Only sell if price > avg buy price
  "takeProfitPercent": 0.05,              // Minimum profit margin above fees
  "stopLossEnabled": false,               // Enable stop-loss
  "stopLossPercent": 5.0,                 // Sell if price drops this % below avg buy
  "maxOpenOrders": 2,                     // Max open orders per side
  "maxSessionLossEnabled": false,         // Pause if session P&L exceeds loss
  "maxSessionLossUsd": 50,               // Max session loss in USD

  // Order lifecycle
  "orderTimeoutEnabled": false,           // Cancel unfilled orders after timeout
  "orderTimeoutMinutes": 15,             // Minutes before cancelling

  // Timing
  "cycleIntervalMinMs": 3000,            // Min time between order cycles
  "cycleIntervalMaxMs": 5000,            // Max time between order cycles

  // Price randomization
  "priceRandomizationEnabled": false,     // Add random noise to prices
  "priceRandomizationRangePercent": 0.01  // Range of random noise
}
```

---

## Configuration

### Environment Variables

Create a `.env` file in your working directory (or let the setup wizard generate one):

```bash
# Required
O2_PRIVATE_KEY=0xYourPrivateKeyHere

# Wallet
O2_WALLET_TYPE=fuel                # "fuel" or "evm"

# Session
O2_SESSION_PASSWORD=mypassword     # Auto-decrypt session (skips prompt)

# API
O2_API_URL=https://api.o2.app
O2_NETWORK_URL=https://mainnet.fuel.network/v1/graphql

# Saved preferences (set by wizard)
O2_MARKETS=ETH_USDC,FUEL_USDC
O2_STRATEGY=simple

# Data
O2_DATA_DIR=./data
O2_STRATEGIES_DIR=./strategies

# Notifications (optional)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=123456789
```

### Notifications

The bot can send real-time alerts to Discord and/or Telegram for:
- Bot started / stopped
- Orders filled
- Stop-loss triggers
- Errors and warnings

**Discord**: Create a webhook in your Discord server settings, add the URL to `.env`.

**Telegram**: Create a bot via [@BotFather](https://t.me/BotFather), get the token and your chat ID, add both to `.env`.

Notifications are rate-limited to 1 alert per type per minute to prevent spam.

---

## Data & Sessions

### Data Directory

```
./data/
├── o2-cli-bot.db     # SQLite database
└── logs/             # Activity logs
```

The database stores:
- **Sessions** — encrypted session keys, expiry, trade account info
- **Orders** — full order history with status tracking
- **Trades** — filled trades with P&L calculations
- **Strategy configs** — persisted per market
- **Snapshots** — periodic balance/P&L snapshots
- **Nonces** — transaction nonce tracking

### Session Management

Sessions are created on the O2 exchange to authorize trading. The bot:

1. Generates a session signing key
2. Encrypts it with your password using **AES-256-GCM** (PBKDF2 key derivation, 100k iterations)
3. Stores the encrypted key in the local database
4. Automatically restores sessions on restart (if not expired)
5. Auto-renews sessions before they expire (default: 30 days)

Your private key is only used once during session creation — all subsequent trades use the session key.

---

## Development

### Prerequisites

- Node.js 18+
- npm or bun

### Setup

```bash
git clone https://github.com/rishabhkeshan/o2-cli-bot.git
cd o2-cli-bot
npm install
```

### Dev Mode

```bash
# Watch mode with hot reload
npm run dev

# Or run directly
npx tsx src/index.ts

# Build
npm run build

# Run built version
npm start
```

### Building Standalone Binaries

```bash
# Install bun
curl -fsSL https://bun.sh/install | bash

# Patch blessed for static requires (needed for bun compile)
node scripts/patch-blessed.cjs

# Build
npm run build

# Compile to standalone binary
bun build dist/index.js --compile --outfile o2-bot
```

### Project Structure

```
src/
├── index.ts                 # CLI entry, setup wizard, bot orchestration
├── config/
│   ├── index.ts             # .env config loading
│   └── strategy-loader.ts   # Strategy resolution and merging
├── auth/
│   ├── wallet.ts            # Fuel/EVM wallet management
│   ├── session-manager.ts   # Session lifecycle and auto-renewal
│   ├── encryption.ts        # AES-256-GCM encryption
│   ├── encoders.ts          # Contract call encoding
│   └── prompt.ts            # Interactive input prompts
├── api/
│   ├── rest-client.ts       # O2 REST API client
│   └── ws-client.ts         # WebSocket client (order book, orders)
├── engine/
│   ├── trading-engine.ts    # Main trading loop
│   ├── strategy-executor.ts # Strategy logic execution
│   ├── order-manager.ts     # Order submission and fill tracking
│   ├── market-data.ts       # Market data, tickers, order books
│   ├── balance-tracker.ts   # Balance monitoring
│   └── pnl-calculator.ts    # P&L computation and snapshots
├── tui/
│   ├── dashboard.ts         # Blessed TUI dashboard
│   └── logger.ts            # Event logger
├── notifications/
│   ├── index.ts             # Notification manager
│   ├── discord.ts           # Discord webhooks
│   └── telegram.ts          # Telegram bot messages
├── db/
│   ├── index.ts             # SQLite init and auto-save
│   └── queries.ts           # Database CRUD
├── types/                   # TypeScript type definitions
└── utils/
    └── price-math.ts        # Price formatting and math
```

---

## Releasing

Releases are automated via GitHub Actions. To publish a new version:

```bash
# Bump version in package.json and src/index.ts
# Commit and tag
git tag v1.0.2
git push origin v1.0.2
```

This automatically:
1. Publishes to npm
2. Builds standalone binaries for macOS (ARM64 + x64) and Linux
3. Creates a GitHub Release with binaries attached
4. Updates the Homebrew formula with new checksums

---

## License

[MIT](LICENSE)
