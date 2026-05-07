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

**Navigation & view**

| Key | Action |
|-----|--------|
| `q` / `Ctrl+C` | Quit (graceful shutdown) |
| `[` | Previous market (chart focus only) |
| `]` | Next market |
| `r` | Cycle chart timeframe (1m → 5m → 15m → 1h → 4h → 1d) |
| `h` | Toggle activity log / trade history |
| `?` | Open help overlay |

**Engine control**

| Key | Action |
|-----|--------|
| `p` | Pause / resume the **whole engine** |
| `P` | Pause / resume **only the focused market** |

**Strategy control**

| Key | Action |
|-----|--------|
| `s` | Cycle strategy preset across **all markets** (legacy quick-cycle) |
| `S` | Open strategy **picker modal** for the focused market only |
| `e` | Open strategy **editor modal** — change individual fields (spread, sizes, intervals, SL/TP, etc.) on the live config without restarting |

**Order control**

| Key | Action |
|-----|--------|
| `c` | Cancel all open orders for the focused market (immediate) |
| `C` | Cancel-all with confirm dialog |
| `O` | Open per-order cancel picker (list of open orders, pick one) |
| `o` | Open the order ticket — rich buy/sell form with live balances, fees, slippage, and post-trade preview |
| `f` | Flatten — confirm, then cancel all + market-sell base balance |

When trading multiple markets, the header shows your position like `(1/3)`. New keys are additive — every key the bot used before still works exactly as it did.

### Order ticket (press `o`)

The manual order modal mirrors the web app's place-order panel:

- **Always-visible**: base + quote balances, mid / bid / ask, spread, maker/taker fees, min order
- **Side toggle** (Buy / Sell) — `←/→` or `B`/`S`
- **Order-type toggle** — Limit / Market / PostOnly / IOC / FOK
- **Price input** with shortcuts: `m` = mid, `b` = bid, `a` = ask, or any number
- **Quantity input** with shortcuts: `25` / `50` / `75` / `100` / `max` = % of available, or any number (Sell uses base balance, Buy uses `quote / price`)
- **Live recompute on every keystroke** of: total ($), estimated fee (maker vs taker), estimated slippage (Market only), post-trade balances
- **Status line** that flips between `Ready`, `Insufficient ETH/USDC`, `Below min order $X`, `PostOnly would cross book`, etc.
- `Tab` cycles fields → Side, Type, Price, Qty, **Place Order** button. `Enter` from any field submits if the status is Ready.

### Open-orders panel & strategy state

The portfolio panel shows up to 10 open orders with `id6 / side / price / qty / fill% / age / Δmid%`. Below it, a one-line **strategy state strip** prints the live values: `Mode | Spread<= | Off<= | Size | Open<= | TP<= | SL on/off`, plus a `Last skip:` line that surfaces the most recent reason the executor declined to trade (e.g. `spread_exceeded`, `insufficient_balance`, `daily_loss_hit`, `slippage_exceeded`).

A **health strip** in the header shows WS state, reconnect count, and the most recent error (abbreviated).

### Console Mode

Use `--no-tui` for headless environments (servers, Docker, CI). All events are printed to stdout.

---

## Runtime Control

Most things you used to need a restart for can now be done while the bot is running.

### Hot-reload of strategy JSON

The bot watches your `strategies/` directory. Edit any preset file in your editor, save, and within ~300ms every market currently using that preset is updated in place — runtime state (avg buy price, fill history, daily-loss counters, trailing peak) is preserved.

Markets that started from a custom config (`--config ./my.json`) are intentionally **skipped** by hot-reload to avoid clobbering your live tuning.

### Per-market pause

Press `P` (capital) to pause only the focused market. The global engine and other markets keep running. Press `P` again to resume.

### Auto-pause guards

If a strategy sets either of these, the engine will pause itself when things go wrong:

```jsonc
"riskManagement": {
  "autoPauseOnConsecutiveFailures": 3,   // after 3 consecutive order rejections, pause this market
  "autoPauseOnWsDownSeconds": 60         // after WS down for 60s, globally stop (no auto-resume)
}
```

Auto-pause is reported via the activity log, the `AUTO_PAUSED` notification, and the `autoPaused` engine event.

### Telegram commands

If you set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_ENABLE_COMMANDS=true`, you can drive the bot from Telegram (the chat IDs in `TELEGRAM_CHAT_ID` are the allowlist — comma-separated for multiple accounts):

| Command | What it does |
|---------|--------------|
| `/status` | Engine state + per-market preset, paused flag, last skip reason |
| `/pause` | Stop the engine globally |
| `/resume` | Start the engine globally |
| `/cancel [MARKET]` | Cancel open orders for a market (or all if omitted) |
| `/flatten [MARKET]` | Cancel orders + market-sell base balance |
| `/strategy <preset> [MARKET]` | Switch preset (`simple`, `volumeMaximizing`, `profitTaking`, `competitionMode`) |
| `/markets` | List active markets |
| `/help` | Print the command list |

Non-allowlisted chats receive a polite "not authorized" reply, and the attempt is logged.

---

## Strategies

### Built-in Presets

| Preset | Style | Order Type | Spread | Profit Target | Speed |
|--------|-------|------------|--------|---------------|-------|
| `simple` | Balanced | Limit | 2% max | Sell above avg buy | 3-5s |
| `volumeMaximizing` | Aggressive | Market | 5% max | None | 1-2s |
| `profitTaking` | Conservative | Limit | 1.5% max | 0.1% min margin | 4-7s |
| `competitionMode` | Volume race | Market w/ jitter | 5% max | None (45% sizing, $50 session-loss cap) | 1.5-3s |

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
├── profitTaking.json
└── competitionMode.json
```

Edit any file, then run with it:

```bash
# By preset name (looks in ./strategies/)
o2-bot -s simple

# By file path
o2-bot --config ./strategies/my-custom.json
```

### Strategy Config Fields

The on-disk JSON is grouped into sections. Every field below is **optional** unless it appears in a preset — defaults preserve the original behavior, so you can copy a preset and only set the fields you care about.

```jsonc
{
  "name": "my-strategy",
  "isActive": true,
  "preferBoostedMarkets": false,           // Schedule boosted markets first (competition)

  "orderConfig": {
    // Order type
    "orderType": "Spot",                   // "Market" | "Spot" | "PostOnly" | "IOC" | "FOK"
                                           //   IOC is mapped to FillOrKill (the contract has no native IOC)
    "priceMode": "offsetFromMid",          // "offsetFromMid" | "offsetFromBestBid" | "offsetFromBestAsk" | "market"
    "priceOffsetPercent": 0.1,             // % offset from reference price
    "maxSpreadPercent": 2.0,               // Skip cycle if spread exceeds this
    "side": "Both",                        // "Buy" | "Sell" | "Both"

    // Price randomization
    "priceRandomizationEnabled": false,
    "priceRandomizationRangePercent": 0.01,

    // Slippage cap on Market orders (estimated VWAP slippage)
    "slippageMaxPercent": 0.5,             // optional; market orders aborted if estimated > this

    // Auto-replace open orders if reference price has drifted by more than this %
    "autoReplaceOnDriftPercent": 0.15,     // optional; cancels stale orders so the next cycle re-quotes

    // Volatility-adaptive spread (rolling realized vol)
    "volatilityAdaptiveSpreadEnabled": false,
    "volatilityLookbackBars": 30,
    "volatilitySpreadMultiplier": 5,       // offset_effective = offset * (1 + multiplier * realizedVol)

    // Inventory-skewed quoting
    "inventorySkewEnabled": false,
    "inventoryTargetBaseRatio": 0.5,       // 0..1, target fraction of equity in base
    "inventoryMaxSkewPercent": 0.2         // max additional offset added on full imbalance
  },

  "positionSizing": {
    "sizeMode": "percentageOfBalance",     // "percentageOfBalance" | "fixedUsd"
    "baseBalancePercentage": 50,
    "quoteBalancePercentage": 50,
    "fixedUsdAmount": 100,                 // used when sizeMode is "fixedUsd"
    "minOrderSizeUsd": 5,
    "maxOrderSizeUsd": 1000,               // per-order cap
    "maxAggregatePositionUsd": 5000        // optional cap across ALL open orders for this market
  },

  "orderManagement": {
    "onlySellAboveBuyPrice": true,
    "maxOpenOrders": 2                     // per side, per market
  },

  "riskManagement": {
    "takeProfitPercent": 0.05,             // minimum profit margin above fees
    "stopLossEnabled": false,
    "stopLossPercent": 5.0,                // sell if price drops this % below avg buy

    // Trailing stop (in addition to / alternative to fixed stop loss)
    "trailingStopEnabled": false,
    "trailingStopPercent": 2,              // exit when price falls this % from the peak

    // Session loss cap (existing)
    "maxSessionLossEnabled": false,
    "maxSessionLossUsd": 50,

    // Daily loss cap with UTC reset
    "maxDailyLossEnabled": false,
    "maxDailyLossUsd": 50,
    "dailyLossResetUtcHour": 0,            // 0..23, default 0 (UTC midnight)

    // Order timeout (existing)
    "orderTimeoutEnabled": false,
    "orderTimeoutMinutes": 15,

    // Auto-pause guards
    "autoPauseOnConsecutiveFailures": 3,   // pause this market after N consecutive order rejections
    "autoPauseOnWsDownSeconds": 60         // globally stop after WS has been down for N seconds (no auto-resume)
  },

  "timing": {
    "cycleIntervalMinMs": 3000,
    "cycleIntervalMaxMs": 5000
  }
}
```

#### Order types

The strategy-level `orderType` maps to the contract enum as follows:

| Strategy value | Behavior |
|---|---|
| `Market` | Crosses the book |
| `Spot` | Limit, may rest |
| `Limit` | Same as `Spot` |
| `PostOnly` | Limit; rejected if it would immediately match |
| `IOC` | Mapped to `FillOrKill` (no native IOC on the contract) |
| `FOK` | Fill-or-kill |

#### Skip diagnostics

Every cycle, the executor populates a structured `skipCategory` and a `diagnostics` block on the result so the TUI (and Telegram `/status`) can show *why* the bot is idle. Possible categories:

`spread_exceeded` · `insufficient_balance` · `max_open_orders` · `profit_floor` · `session_loss_hit` · `daily_loss_hit` · `stop_loss_active` · `paused` · `ws_down` · `consecutive_failures` · `aggregate_cap_hit` · `slippage_exceeded` · `cooldown` · `other`

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
TELEGRAM_CHAT_ID=123456789                  # comma-separated list = allowlist for inbound commands
TELEGRAM_ENABLE_COMMANDS=true               # opt-in; turns on /status /pause /resume /cancel /flatten /strategy /markets /help
```

### Notifications

The bot can send real-time alerts to Discord and/or Telegram. Alert types:

| Type | When |
|------|------|
| `BOT_STARTED` / `BOT_STOPPED` | Engine start / stop |
| `ORDER_FILLED` | A fill is observed |
| `ORDER_REJECTED` | API rejected an order |
| `STOP_LOSS_TRIGGERED` | Fixed or trailing stop fired |
| `DAILY_LOSS_HIT` | Daily-loss cap reached on a market |
| `WS_DOWN` | WebSocket has been down for >30s |
| `SESSION_EXPIRING` | Session has <1h left |
| `SESSION_RECOVERED` | A new session was created after invalidation |
| `AUTO_PAUSED` | Auto-pause triggered (per-market or global) |
| `ERROR` | Catch-all for uncategorized errors |

**Discord**: Create a webhook in your Discord server settings, add the URL to `.env`. Webhook only — no inbound commands.

**Telegram**: Create a bot via [@BotFather](https://t.me/BotFather), get the token and your chat ID, add both to `.env`. To control the bot from Telegram (`/pause`, `/strategy`, etc.), also set `TELEGRAM_ENABLE_COMMANDS=true`. Multiple chat IDs (comma-separated in `TELEGRAM_CHAT_ID`) form the command allowlist.

Notifications are rate-limited to 1 alert per type per minute to prevent spam. You can suppress specific alert types per channel via `NotificationManagerOptions.{telegram,discord}.disabledTypes`.

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
│   ├── trading-engine.ts    # Main trading loop, per-market pause, hot-reload, auto-pause monitor
│   ├── strategy-executor.ts # Strategy logic (vol-adaptive, inventory skew, trailing stop, daily loss…)
│   ├── order-manager.ts     # Order submission, fill tracking, PostOnly/IOC/FOK wiring
│   ├── risk-tracker.ts      # Daily-loss windows, mid-price history, consecutive-failure tracker
│   ├── market-data.ts       # Market data, tickers, order books
│   ├── balance-tracker.ts   # Balance monitoring
│   ├── competition-tracker.ts # Competition leaderboard, boosts, streaks
│   └── pnl-calculator.ts    # P&L computation and snapshots
├── tui/
│   ├── dashboard.ts         # Blessed TUI dashboard, modal hotkeys
│   ├── modals.ts            # Reusable modals (input, picker, confirm, form, help overlay)
│   └── logger.ts            # Event logger
├── notifications/
│   ├── index.ts             # Notification manager, typed helpers
│   ├── command-router.ts    # Telegram inbound command router with allowlist
│   ├── discord.ts           # Discord webhooks
│   └── telegram.ts          # Telegram bot messages (alerts + opt-in command polling)
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
