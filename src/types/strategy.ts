// ============================================
// CORE ORDER CONFIGURATION
// ============================================
export type OrderTypeName = 'BoundedMarket' | 'Market' | 'Spot' | 'PostOnly' | 'IOC' | 'FOK';

export interface OrderConfig {
  // Order Type
  orderType: OrderTypeName;

  // Price Configuration
  priceMode: 'offsetFromMid' | 'offsetFromBestBid' | 'offsetFromBestAsk' | 'market';
  priceOffsetPercent: number; // % offset from reference price (positive = above, negative = below)

  // Spread Management
  maxSpreadPercent: number; // Don't trade if spread exceeds this %

  // Order Side
  side: 'Buy' | 'Sell' | 'Both'; // Both = place buy and sell orders

  // Price Randomization
  priceRandomizationEnabled?: boolean; // Add random jitter to order prices each cycle
  priceRandomizationRangePercent?: number; // Max % random offset (e.g., 0.05 = +/-0.05%)

  // Slippage cap on Market orders — abort placement if estimated VWAP slippage exceeds this %
  slippageMaxPercent?: number;

  // BoundedMarket slippage tolerance (%). Defines the price band the order may
  // walk before the matching engine stops: Buy fills up to ref*(1+x%), Sell
  // fills down to ref*(1-x%). Defaults to 2% when omitted.
  boundedSlippagePercent?: number;

  // Auto-replace open orders if reference price has drifted by more than this % since placement
  autoReplaceOnDriftPercent?: number;

  // Volatility-adaptive spread: scale priceOffsetPercent by realized vol over a lookback window
  volatilityAdaptiveSpreadEnabled?: boolean;
  volatilityLookbackBars?: number; // e.g., 30 bars
  volatilitySpreadMultiplier?: number; // offset_effective = offset * (1 + multiplier * realizedVol)

  // Inventory-skewed quoting: skew bid/ask offsets based on base vs quote balance ratio
  inventorySkewEnabled?: boolean;
  inventoryTargetBaseRatio?: number; // 0..1, target fraction of equity held in base (0.5 = balanced)
  inventoryMaxSkewPercent?: number; // max additional offset added when fully imbalanced
}

// ============================================
// POSITION SIZING
// ============================================
export interface PositionSizingConfig {
  // Size Mode
  sizeMode: 'percentageOfBalance' | 'fixedUsd';

  // Percentage-based (most common)
  balancePercentage: number; // Legacy fallback - use baseBalancePercentage/quoteBalancePercentage instead
  baseBalancePercentage: number; // % of base balance to use for sell orders (0-100)
  quoteBalancePercentage: number; // % of quote balance to use for buy orders (0-100)

  // Fixed USD (alternative)
  fixedUsdAmount?: number; // Fixed USD value per order

  // Constraints
  minOrderSizeUsd: number; // Minimum order size (e.g., 5 USD)
  maxOrderSizeUsd?: number; // Maximum order size per order (optional cap)

  // Aggregate cap across all currently-open orders for this market (optional)
  maxAggregatePositionUsd?: number;
}

// ============================================
// ORDER MANAGEMENT
// ============================================
export interface OrderManagementConfig {
  // Profit Protection
  trackFillPrices: boolean; // DEPRECATED: Always true now - kept for backwards compatibility
  onlySellAboveBuyPrice: boolean; // Only place sell orders above average buy price

  // Order Limits
  maxOpenOrders: number; // Maximum open orders per side (e.g., 2 = max 2 buy + 2 sell)
}

// ============================================
// RISK MANAGEMENT
// ============================================
export interface RiskManagementConfig {
  // Take Profit - minimum profit margin above fees
  takeProfitPercent: number; // default 0.02 (covers 0.01% buy + 0.01% sell fees)

  // Stop Loss - Price Based
  stopLossEnabled: boolean;
  stopLossPercent: number; // e.g., 5 = sell if price drops 5% below avg buy

  // Stop Loss - Time Based (Order Timeout)
  orderTimeoutEnabled: boolean;
  orderTimeoutMinutes: number; // e.g., 30 = cancel if not filled in 30 min

  // Max Session Loss - pauses trading when session P&L drops below threshold
  maxSessionLossEnabled: boolean;
  maxSessionLossUsd: number; // e.g., 100 = pause if session P&L drops to -$100

  // Daily loss limit — auto-pause when realized P&L for the current UTC day drops below threshold
  maxDailyLossEnabled?: boolean;
  maxDailyLossUsd?: number; // e.g., 50 = pause if today's P&L drops to -$50
  dailyLossResetUtcHour?: number; // Hour (0-23) when the daily window resets, default 0 (UTC midnight)

  // Trailing stop — exit when price falls more than this % below the highest price seen since position opened
  trailingStopEnabled?: boolean;
  trailingStopPercent?: number; // e.g., 2 = exit when price drops 2% from peak

  // Auto-pause guards
  autoPauseOnWsDownSeconds?: number; // pause trading if WS has been down for this many seconds (0/undefined = disabled)
  autoPauseOnConsecutiveFailures?: number; // pause after N consecutive order rejections (0/undefined = disabled)
}

// ============================================
// TIMING
// ============================================
export interface TimingConfig {
  // Execution Interval
  cycleIntervalMinMs: number; // Minimum time between order cycles (ms)
  cycleIntervalMaxMs: number; // Maximum time between order cycles (ms)
}

// ============================================
// MAIN STRATEGY CONFIG
// ============================================
export interface StrategyConfig {
  // Basic Info
  marketId: string;
  name?: string;

  // Core Configurations
  orderConfig: OrderConfig;
  positionSizing: PositionSizingConfig;
  orderManagement: OrderManagementConfig;
  riskManagement: RiskManagementConfig;
  timing: TimingConfig;

  // Internal State (managed by system)
  lastFillPrices?: {
    buy: Array<{ price: string; quantity: string; timestamp: number }>;
    sell: Array<{ price: string; quantity: string; timestamp: number }>;
  };
  averageBuyPrice?: string;
  averageSellPrice?: string;

  // Trailing-stop runtime state — highest price observed while holding the current position
  trailingPeakPrice?: string;

  // Daily loss tracker — start of the current UTC day window and realized P&L accumulated since
  dailyLossWindowStart?: number; // ms epoch
  dailyRealizedPnl?: number; // USD, signed

  // Competition: prefer markets that currently have a volume boost multiplier when scheduling
  preferBoostedMarkets?: boolean;

  // Console Settings
  consoleMode?: 'simple' | 'debug'; // Console verbosity: simple (essential) or debug (all details)

  // Metadata
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface StrategyConfigStore {
  id: string;
  marketId: string;
  config: StrategyConfig;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  version?: number; // Incremented on each update for change detection
}

// ============================================
// DEFAULT STRATEGY CONFIGURATION
// ============================================
export function getDefaultStrategyConfig(marketId: string): StrategyConfig {
  return {
    marketId,
    name: 'Default Trading Strategy',

    orderConfig: {
      orderType: 'BoundedMarket',
      boundedSlippagePercent: 2, // Walk up to 2% past the reference price
      priceMode: 'offsetFromMid',
      priceOffsetPercent: 0.1, // 0.1% from mid price
      maxSpreadPercent: 2.0, // Don't trade if spread > 2%
      side: 'Both', // Place both buy and sell orders
      priceRandomizationEnabled: false,
      priceRandomizationRangePercent: 0.05, // +/-0.05% default
    },

    positionSizing: {
      sizeMode: 'percentageOfBalance',
      balancePercentage: 100, // Legacy fallback
      baseBalancePercentage: 100, // Use 100% of base balance for sell orders
      quoteBalancePercentage: 100, // Use 100% of quote balance for buy orders
      minOrderSizeUsd: 5, // Minimum $5 per order
      maxOrderSizeUsd: undefined, // No maximum cap by default
    },

    orderManagement: {
      trackFillPrices: true,
      onlySellAboveBuyPrice: true, // Only sell if profitable
      maxOpenOrders: 2, // Max 2 buy + 2 sell orders
    },

    riskManagement: {
      takeProfitPercent: 0.02, // 0.02% covers round-trip fees (0.01% buy + 0.01% sell)
      stopLossEnabled: false,
      stopLossPercent: 5, // Sell if price drops 5% below avg buy
      orderTimeoutEnabled: false,
      orderTimeoutMinutes: 30, // Cancel orders not filled in 30 minutes
      maxSessionLossEnabled: false,
      maxSessionLossUsd: 100, // Pause trading if session P&L drops to -$100
    },

    timing: {
      cycleIntervalMinMs: 3000, // 3 seconds minimum
      cycleIntervalMaxMs: 5000, // 5 seconds maximum
    },

    consoleMode: 'simple', // Default to simple mode (essential messages only)

    isActive: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ============================================
// STRATEGY PRESETS
// ============================================
export type StrategyPreset = 'simple' | 'volumeMaximizing' | 'profitTaking' | 'competitionMode' | 'custom';

export const STRATEGY_PRESET_LABELS: Record<StrategyPreset, string> = {
  simple: 'Simple',
  volumeMaximizing: 'Volume Max',
  profitTaking: 'Profit Taking',
  competitionMode: 'Competition',
  custom: 'Custom',
};

export const STRATEGY_PRESET_DESCRIPTIONS: Record<StrategyPreset, string> = {
  simple: 'Balanced trading with profit protection',
  volumeMaximizing: 'Maximum volume, P&L not priority',
  profitTaking: 'Ensures 0.1%+ profit per trade',
  competitionMode: 'Optimized for competition volume + streak targets',
  custom: 'Full control over all settings',
};

export function getPresetStrategyConfig(marketId: string, preset: StrategyPreset): StrategyConfig {
  const base = getDefaultStrategyConfig(marketId);

  switch (preset) {
    case 'simple':
      return {
        ...base,
        name: 'Simple Mode',
        orderConfig: {
          ...base.orderConfig,
          orderType: 'Spot', // Limit orders required for sell above buy
        },
        orderManagement: { ...base.orderManagement, onlySellAboveBuyPrice: true },
      };

    case 'volumeMaximizing':
      return {
        ...base,
        name: 'Volume Maximizing',
        orderConfig: {
          ...base.orderConfig,
          orderType: 'BoundedMarket',
          priceMode: 'market',
          priceOffsetPercent: 0,
          maxSpreadPercent: 5.0,
        },
        orderManagement: {
          ...base.orderManagement,
          onlySellAboveBuyPrice: false,
          maxOpenOrders: 3,
        },
        riskManagement: {
          ...base.riskManagement,
          takeProfitPercent: 0,
        },
        timing: {
          cycleIntervalMinMs: 1000,
          cycleIntervalMaxMs: 2000,
        },
      };

    case 'profitTaking':
      return {
        ...base,
        name: 'Profit Taking',
        orderConfig: {
          ...base.orderConfig,
          orderType: 'Spot',
          priceMode: 'offsetFromMid',
          priceOffsetPercent: 0.05,
          maxSpreadPercent: 1.5,
        },
        orderManagement: {
          ...base.orderManagement,
          onlySellAboveBuyPrice: true,
        },
        riskManagement: {
          ...base.riskManagement,
          takeProfitPercent: 0.1,
          orderTimeoutEnabled: true,
          orderTimeoutMinutes: 15,
        },
        timing: {
          cycleIntervalMinMs: 4000,
          cycleIntervalMaxMs: 7000,
        },
      };

    case 'competitionMode':
      return {
        ...base,
        name: 'Competition Mode',
        orderConfig: {
          ...base.orderConfig,
          orderType: 'BoundedMarket',
          priceMode: 'offsetFromMid',
          priceOffsetPercent: 0.02,
          maxSpreadPercent: 5.0,
          priceRandomizationEnabled: true,
          priceRandomizationRangePercent: 0.01,
        },
        positionSizing: {
          ...base.positionSizing,
          sizeMode: 'percentageOfBalance',
          baseBalancePercentage: 45,
          quoteBalancePercentage: 45,
        },
        orderManagement: {
          ...base.orderManagement,
          onlySellAboveBuyPrice: false,
          maxOpenOrders: 3,
        },
        riskManagement: {
          ...base.riskManagement,
          takeProfitPercent: 0,
          maxSessionLossEnabled: true,
          maxSessionLossUsd: 50,
        },
        timing: {
          cycleIntervalMinMs: 1500,
          cycleIntervalMaxMs: 3000,
        },
      };

    case 'custom':
    default:
      return {
        ...base,
        name: 'Custom',
      };
  }
}

// ============================================
// ORDER EXECUTION & RESULTS
// ============================================
export interface OrderExecution {
  orderId: string;
  side: 'Buy' | 'Sell';
  success: boolean;
  price?: string; // Scaled price (for API)
  quantity?: string; // Scaled quantity (for API)
  filledQuantity?: string;
  error?: string;
  errorDetails?: unknown; // Full error response for debug mode
  // Human-readable values for display
  priceHuman?: string; // Human-readable price (e.g., "50000.00")
  quantityHuman?: string; // Human-readable quantity (e.g., "0.5")
  marketPair?: string; // Market pair name (e.g., "BTC/USDC")
  isLimitOrder?: boolean; // True if order was placed as limit (Spot) order
}

export interface StrategyExecutionResult {
  executed: boolean;
  orders: OrderExecution[];
  nextRunAt?: number;
  skipReason?: string; // Human-readable reason why execution was skipped (e.g., spread exceeded)
  skipCategory?: SkipCategory; // Stable, machine-readable category for UI grouping
  diagnostics?: ExecutionDiagnostics; // Optional structured diagnostics for the dashboard
}

// Stable categories for skip reasons. Used by the TUI to render colored chips and group state.
export type SkipCategory =
  | 'spread_exceeded'
  | 'insufficient_balance'
  | 'max_open_orders'
  | 'profit_floor'
  | 'session_loss_hit'
  | 'daily_loss_hit'
  | 'stop_loss_active'
  | 'paused'
  | 'ws_down'
  | 'consecutive_failures'
  | 'aggregate_cap_hit'
  | 'slippage_exceeded'
  | 'cooldown'
  | 'other';

export interface ExecutionDiagnostics {
  effectiveSpreadPercent?: number;
  midPrice?: string;
  bestBid?: string;
  bestAsk?: string;
  realizedVolPercent?: number; // recent realized volatility
  inventoryBaseRatio?: number; // current fraction of equity in base
  buySkewPercent?: number; // applied buy-side offset after skew/vol adjustments
  sellSkewPercent?: number;
  openOrdersBuy?: number;
  openOrdersSell?: number;
  aggregateOpenUsd?: number; // notional of all open orders
  trailingPeak?: string;
  dailyPnlUsd?: number;
  reasonDetail?: string;
}
