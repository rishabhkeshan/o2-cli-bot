import blessed from 'blessed';
import chalk from 'chalk';
import type { TradingEngine, TradingContext } from '../engine/trading-engine.js';
import type { PnLCalculator } from '../engine/pnl-calculator.js';
import type { MarketDataService } from '../engine/market-data.js';
import type { BalanceTracker } from '../engine/balance-tracker.js';
import type { OrderManager } from '../engine/order-manager.js';
import type { O2RestClient } from '../api/rest-client.js';
import type { O2WebSocketClient } from '../api/ws-client.js';
import type { Market, Bar, OrderBookDepth, MarketTicker } from '../types/market.js';
import type { Order } from '../types/order.js';
import type { Logger } from './logger.js';
import type { CompetitionTracker } from '../engine/competition-tracker.js';
import type { StrategyPreset } from '../types/strategy.js';
import { getPresetStrategyConfig, STRATEGY_PRESET_LABELS } from '../types/strategy.js';
import * as dbQueries from '../db/queries.js';

// Force truecolor output
chalk.level = 3;

const RESOLUTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const STRATEGY_PRESETS: StrategyPreset[] = ['simple', 'volumeMaximizing', 'profitTaking', 'competitionMode'];

// ─── Unicode visual elements ──────────────────────────────
const SPARK = '▁▂▃▄▅▆▇█';
const TRI = '▸';
const DOT = '●';
const DIAMOND = '◆';
const ARROW_UP = '▲';
const ARROW_DOWN = '▼';
const BLOCK = '█';
const HLINE = '─';
const VLINE = '│';

// ─── O2 Theme — inspired by o2term (Ratatui) ─────────────
type RGB = readonly [number, number, number];

const T = {
  fg:       [222, 230, 250] as RGB,
  muted:    [108, 120, 150] as RGB,
  dim:      [62, 74, 100] as RGB,
  border:   [38, 50, 72] as RGB,
  accent:   [96, 200, 255] as RGB,    // cyan
  accent2:  [255, 140, 200] as RGB,   // pink
  buy:      [120, 240, 190] as RGB,   // green
  buyDim:   [40, 100, 70] as RGB,
  sell:     [255, 120, 170] as RGB,   // red-pink
  sellDim:  [120, 50, 75] as RGB,
  gold:     [255, 215, 80] as RGB,
  warn:     [255, 200, 60] as RGB,
  panel:    [14, 18, 28] as RGB,      // panel bg
  panelAlt: [18, 24, 36] as RGB,     // zebra stripe
  headerBg: [10, 14, 22] as RGB,
  flash:    [255, 255, 140] as RGB,   // new trade flash
};

// ─── Truecolor helpers ────────────────────────────────────
function tc(color: RGB, text: string): string {
  return chalk.rgb(color[0], color[1], color[2])(text);
}
function tcB(color: RGB, text: string): string {
  return chalk.rgb(color[0], color[1], color[2]).bold(text);
}
function tcBg(bg: RGB, fg: RGB, text: string): string {
  return chalk.bgRgb(bg[0], bg[1], bg[2]).rgb(fg[0], fg[1], fg[2])(text);
}
function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}
function gradient(text: string, from: RGB, to: RGB, bold = false): string {
  if (text.length === 0) return '';
  if (text.length === 1) return bold ? tcB(from, text) : tc(from, text);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const t = i / (text.length - 1);
    const c = lerpRGB(from, to, t);
    out += bold
      ? chalk.rgb(c[0], c[1], c[2]).bold(text[i])
      : chalk.rgb(c[0], c[1], c[2])(text[i]);
  }
  return out;
}
function depthBar(ratio: number, maxLen: number, bright: RGB, dim: RGB): string {
  const len = Math.max(0, Math.round(ratio * maxLen));
  if (len === 0) return '';
  let out = '';
  for (let i = 0; i < len; i++) {
    const t = len > 1 ? i / (len - 1) : 1;
    const c = lerpRGB(dim, bright, t);
    out += chalk.rgb(c[0], c[1], c[2])('█');
  }
  return out;
}
function sparkline(values: number[], maxW: number): string {
  if (values.length < 2) return '';
  const recent = values.slice(-maxW);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const range = max - min || 1;
  const up = recent[recent.length - 1] >= recent[0];
  let out = '';
  for (let i = 0; i < recent.length; i++) {
    const idx = Math.min(7, Math.floor(((recent[i] - min) / range) * 7.99));
    const age = recent.length > 1 ? i / (recent.length - 1) : 1;
    const c = lerpRGB(up ? T.buyDim : T.sellDim, up ? T.buy : T.sell, age);
    out += chalk.rgb(c[0], c[1], c[2])(SPARK[idx]);
  }
  return out;
}

// ─── Formatting ───────────────────────────────────────────
function fmtPrice(n: number): string {
  if (n === 0 || !isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 10000) return n.toFixed(2);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.01) return n.toFixed(4);
  if (abs >= 0.0001) return n.toFixed(6);
  const mag = Math.floor(Math.log10(abs));
  const decimals = Math.min(-mag + 3, 10);
  return n.toFixed(decimals);
}
function fmtQty(n: number): string {
  if (n === 0) return '0';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(2) + 'K';
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(4);
  return n.toFixed(6);
}
function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(2) + 'K';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}
function fmtVol(n: number, symbol: string): string {
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M ' + symbol;
  if (n >= 1000) return (n / 1000).toFixed(2) + 'K ' + symbol;
  return n.toFixed(2) + ' ' + symbol;
}
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtTimeFull(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ─── Tape Fill type ───────────────────────────────────────
interface TapeFill {
  time: number;
  side: string;
  price: string;
  quantity: string;
  pair: string;
  pnl?: string;
  isNew: boolean;
}

const MAX_TAPE_FILLS = 50;

// ─── Dashboard ────────────────────────────────────────────
export class Dashboard {
  private screen: blessed.Widgets.Screen | null = null;
  private headerBox: blessed.Widgets.BoxElement | null = null;
  private competitionBox: blessed.Widgets.BoxElement | null = null;
  private compRankBox: blessed.Widgets.BoxElement | null = null;
  private compPnlBox: blessed.Widgets.BoxElement | null = null;
  private compBoostBox: blessed.Widgets.BoxElement | null = null;
  private compStreakBox: blessed.Widgets.BoxElement | null = null;
  private compDailyBox: blessed.Widgets.BoxElement | null = null;
  private compFooterBox: blessed.Widgets.BoxElement | null = null;
  private chartBox: blessed.Widgets.BoxElement | null = null;
  private orderbookBox: blessed.Widgets.BoxElement | null = null;
  private tapeBox: blessed.Widgets.BoxElement | null = null;
  private balancePnlBox: blessed.Widgets.BoxElement | null = null;
  private logBox: blessed.Widgets.Log | null = null;
  private historyBox: blessed.Widgets.BoxElement | null = null;

  private engine: TradingEngine;
  private pnlCalc: PnLCalculator;
  private marketData: MarketDataService;
  private balanceTracker: BalanceTracker;
  private restClient: O2RestClient;
  private wsClient: O2WebSocketClient | null = null;
  private orderManager: OrderManager | null = null;
  private logger: Logger;
  private startTime: number = Date.now();
  private rendering = false;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private noTui: boolean;
  private watchMode: boolean;
  private onQuit?: () => void;
  private viewMode: 'log' | 'history' = 'log';
  private tradeAccountId: string = '';
  private sessionExpiry: number = 0;

  private currentMarketIndex = 0;
  private markets: Market[] = [];
  private resolutionIndex = 0;
  private bars: Bar[] = [];
  private lastBarFetch = 0;
  private openOrders: Order[] = [];
  private lastOrdersFetch = 0;
  private currentPresetIndex = 0;
  private ownerAddress: string = '';
  private competitionTracker: CompetitionTracker | null = null;

  // Trades tape
  private tapeFills: TapeFill[] = [];
  // Price history for sparkline
  private priceHistory: number[] = [];
  private readonly MAX_PRICE_HISTORY = 40;

  constructor(opts: {
    engine: TradingEngine;
    pnlCalc: PnLCalculator;
    marketData: MarketDataService;
    balanceTracker: BalanceTracker;
    restClient: O2RestClient;
    orderManager?: OrderManager;
    wsClient?: O2WebSocketClient;
    logger: Logger;
    competitionTracker?: CompetitionTracker;
    noTui?: boolean;
    watchMode?: boolean;
    onQuit?: () => void;
    markets?: Market[];
    ownerAddress?: string;
    tradeAccountId?: string;
    sessionExpiry?: number;
  }) {
    this.engine = opts.engine;
    this.pnlCalc = opts.pnlCalc;
    this.marketData = opts.marketData;
    this.balanceTracker = opts.balanceTracker;
    this.restClient = opts.restClient;
    this.wsClient = opts.wsClient || null;
    this.orderManager = opts.orderManager || null;
    this.logger = opts.logger;
    this.competitionTracker = opts.competitionTracker || null;
    this.noTui = opts.noTui || false;
    this.watchMode = opts.watchMode || false;
    this.onQuit = opts.onQuit;
    this.markets = opts.markets || this.marketData.getAllMarkets();
    this.ownerAddress = opts.ownerAddress || '';
    this.tradeAccountId = opts.tradeAccountId || '';
    this.sessionExpiry = opts.sessionExpiry || 0;

    const contexts = this.engine.getContexts();
    if (contexts.length > 0) {
      const name = contexts[0].strategy?.toLowerCase() || '';
      const idx = STRATEGY_PRESETS.findIndex(p => name.includes(p.toLowerCase()));
      if (idx >= 0) this.currentPresetIndex = idx;
    }
  }

  start(): void {
    if (this.noTui) { this.startConsoleMode(); return; }
    this.startTuiMode();
  }

  private startConsoleMode(): void {
    this.logger.onLog((level, message) => {
      if (level === 'error') console.error(message);
      else console.log(message);
    });
    this.engine.on('cycle', (_marketId: string, result: any) => {
      if (result.executed) {
        for (const order of result.orders || []) {
          // Don't log successful orders here — fill handler in index.ts logs confirmed fills
          if (!order.success && order.error) console.error(`[Failed] ${order.error}`);
        }
      } else if (result.skipReason) {
        console.log(`[Skip] ${result.skipReason}`);
      }
      if (!result.executed && result.orders) {
        for (const order of result.orders) {
          if (!order.success && order.error) console.error(`[Failed] ${order.error}`);
        }
      }
    });
    this.engine.on('error', (marketId: string, err: Error) => {
      console.error(`[Error] ${marketId}: ${err.message}`);
    });

    // Competition status in headless mode
    if (this.competitionTracker) {
      this.competitionTracker.on('update', (state: any) => {
        if (!state?.competition || !state.userEntry) return;
        const comp = state.competition;
        const u = state.userEntry;
        const title = this.stripHtmlTags(comp.title);
        const remainMs = state.timeRemainingMs;
        const days = Math.floor(remainMs / 86400000);
        const hrs = Math.floor((remainMs % 86400000) / 3600000);
        const timeStr = days > 0 ? `${days}d${hrs}h` : `${hrs}h`;
        let compLine = `[Competition] ${title} | Rank: #${u.rank} | Vol: $${this.fmtBigNum(String(u.volume))} | P&L: $${this.fmtBigNum(String(u.pnl))} | ${timeStr}`;
        const subs = state.subRankings;
        if (subs?.taker) compLine += ` | Taker: #${subs.taker.rank} $${this.fmtBigNum(String(subs.taker.volume))}`;
        if (subs?.maker) compLine += ` | Maker: #${subs.maker.rank} $${this.fmtBigNum(String(subs.maker.volume))}`;
        console.log(compLine);

        const streakInfo = this.competitionTracker?.getStreakInfo();
        if (streakInfo) {
          let streakMsg = `[Competition] Streak: ${streakInfo.streakCount}`;
          if (streakInfo.currentPeriodProgress) {
            const prog = streakInfo.currentPeriodProgress;
            const volNum = parseFloat(prog.volume) || 0;
            const tgtNum = parseFloat(prog.target) || 0;
            const pct = tgtNum > 0 ? Math.round((volNum / tgtNum) * 100) : 0;
            streakMsg += ` | Day ${streakInfo.currentPeriodIndex + 1}: ${pct}% ($${this.fmtBigNum(String(prog.volume))}/$${this.fmtBigNum(String(prog.target))})`;
            if (prog.met) streakMsg += ' [MET]';
          }
          if (streakInfo.superBoostStatus) streakMsg += ` | SB: ${streakInfo.superBoostStatus}`;
          console.log(streakMsg);
        }
      });

      this.competitionTracker.on('streakAtRisk', (info: any) => {
        console.warn(`[Competition] WARNING: Streak at risk! Day ${info.periodIndex + 1}, ${info.progress}% elapsed, $${info.volume}/$${info.target}`);
      });
    }
  }

  private startTuiMode(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'O2 Trading Bot',
      fullUnicode: true,
      forceUnicode: true,
    });

    const borderStyle = { fg: '#263248' };
    const labelStyle = { fg: '#60C8FF', bold: true };

    // ─── Panels ─────────────────────────────────────────
    this.headerBox = blessed.box({
      top: 0, left: 0, width: '100%', height: 3,
      tags: true,
      style: { fg: 'white', bg: '#0A0E16' },
      padding: { left: 1, right: 1 },
    });

    // Competition panel — dedicated strip below header
    this.competitionBox = blessed.box({
      top: 3, left: 0, width: '100%', height: 13,
      label: ` ${DIAMOND} Competition `,
      border: { type: 'line' }, tags: true,
      style: { border: { fg: '#3A2660' }, label: { fg: '#FF8CC8', bold: true }, fg: 'white', bg: '#0E1220' },
      hidden: true,
    });

    // ─── Competition child boxes ──────────────────────
    const compCardStyle = { border: { fg: '#2A3658' }, fg: 'white', bg: '#0E1220' };
    const compLabelFg = '#60C8FF';

    this.compRankBox = blessed.box({
      parent: this.competitionBox,
      top: 1, left: 0, width: '35%', height: 6,
      label: ` ${TRI} Ranking `, border: { type: 'line' }, tags: true,
      style: { ...compCardStyle, label: { fg: compLabelFg, bold: true } },
      padding: { left: 1 },
    });

    this.compPnlBox = blessed.box({
      parent: this.competitionBox,
      top: 1, left: '35%', width: '30%', height: 6,
      label: ` ${TRI} P&L `, border: { type: 'line' }, tags: true,
      style: { ...compCardStyle, label: { fg: compLabelFg, bold: true } },
      padding: { left: 1 },
    });

    this.compBoostBox = blessed.box({
      parent: this.competitionBox,
      top: 1, left: '65%', width: '35%', height: 6,
      label: ` ${TRI} Market Boosts `, border: { type: 'line' }, tags: true,
      style: { ...compCardStyle, label: { fg: '#FF8CC8', bold: true } },
      padding: { left: 1 },
    });

    this.compDailyBox = blessed.box({
      parent: this.competitionBox,
      top: 7, left: 0, width: '50%', height: 3,
      label: ` ${TRI} Daily Boost `, border: { type: 'line' }, tags: true,
      style: { ...compCardStyle, label: { fg: '#78F0BE', bold: true } },
      padding: { left: 1 },
    });

    this.compStreakBox = blessed.box({
      parent: this.competitionBox,
      top: 7, left: '50%', width: '50%', height: 3,
      label: ` ${TRI} Streak `, border: { type: 'line' }, tags: true,
      style: { ...compCardStyle, label: { fg: '#FFD750', bold: true } },
      padding: { left: 1 },
    });

    const chartTop = 3; // Will be shifted to 15 when competition visible

    this.chartBox = blessed.box({
      top: chartTop, left: 0, width: '50%', height: '57%-3',
      label: ` ${TRI} Chart `,
      border: { type: 'line' }, tags: true,
      style: { border: borderStyle, label: labelStyle, fg: 'white', bg: '#0E1220' },
    });

    this.tapeBox = blessed.box({
      top: chartTop, left: '50%', width: '25%', height: '57%-3',
      label: ` ${TRI} Trades `,
      border: { type: 'line' }, tags: true,
      style: { border: borderStyle, label: labelStyle, fg: 'white', bg: '#0E1220' },
      padding: { left: 1 },
    });

    this.orderbookBox = blessed.box({
      top: chartTop, left: '75%', width: '25%', height: '57%-3',
      label: ` ${TRI} Order Book `,
      border: { type: 'line' }, tags: true,
      style: { border: borderStyle, label: labelStyle, fg: 'white', bg: '#0E1220' },
    });

    this.balancePnlBox = blessed.box({
      top: '57%', left: 0, width: '32%', height: '43%',
      label: ` ${TRI} Portfolio `,
      border: { type: 'line' }, tags: true,
      scrollable: true, scrollbar: { ch: '▐', style: { bg: '#60C8FF' } },
      style: { border: borderStyle, label: labelStyle, fg: 'white', bg: '#0E1220' },
      padding: { left: 1 },
    });

    this.logBox = blessed.log({
      top: '57%', left: '32%', width: '68%', height: '43%',
      label: ` ${TRI} Activity `,
      border: { type: 'line' }, tags: true,
      scrollable: true, scrollbar: { ch: '▐', style: { bg: '#60C8FF' } },
      style: { border: borderStyle, label: labelStyle, fg: 'white', bg: '#0E1220' },
      padding: { left: 1 },
    });

    this.historyBox = blessed.box({
      top: '57%', left: '32%', width: '68%', height: '43%',
      label: ` ${TRI} Trade History `,
      border: { type: 'line' }, tags: true,
      scrollable: true, scrollbar: { ch: '▐', style: { bg: '#60C8FF' } },
      style: { border: borderStyle, label: labelStyle, fg: 'white', bg: '#0E1220' },
      padding: { left: 1 },
      hidden: true,
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.competitionBox);
    this.screen.append(this.orderbookBox);
    this.screen.append(this.tapeBox);
    this.screen.append(this.chartBox);
    this.screen.append(this.balancePnlBox);
    this.screen.append(this.logBox);
    this.screen.append(this.historyBox);

    // ─── Key bindings ───────────────────────────────────
    this.screen.key(['q', 'C-c'], () => { if (this.onQuit) this.onQuit(); });
    this.screen.key(['p'], () => {
      if (this.engine.isRunning) { this.engine.stop(); this.addLog('{yellow-fg}Bot paused{/yellow-fg}'); }
      else {
        this.watchMode = false;
        this.engine.start();
        this.addLog('{green-fg}Bot resumed{/green-fg}');
      }
    });
    this.screen.key(['['], () => {
      if (this.markets.length > 1) {
        this.currentMarketIndex = (this.currentMarketIndex - 1 + this.markets.length) % this.markets.length;
        this.lastBarFetch = 0;
        this.priceHistory = [];
        this.addLog(`Switched to ${this.currentMarket?.base.symbol}/${this.currentMarket?.quote.symbol}`);
      }
    });
    this.screen.key([']'], () => {
      if (this.markets.length > 1) {
        this.currentMarketIndex = (this.currentMarketIndex + 1) % this.markets.length;
        this.lastBarFetch = 0;
        this.priceHistory = [];
        this.addLog(`Switched to ${this.currentMarket?.base.symbol}/${this.currentMarket?.quote.symbol}`);
      }
    });
    this.screen.key(['r'], () => {
      this.resolutionIndex = (this.resolutionIndex + 1) % RESOLUTIONS.length;
      this.lastBarFetch = 0;
      this.addLog(`Chart resolution: ${RESOLUTIONS[this.resolutionIndex]}`);
    });
    this.screen.key(['s'], () => {
      this.currentPresetIndex = (this.currentPresetIndex + 1) % STRATEGY_PRESETS.length;
      const preset = STRATEGY_PRESETS[this.currentPresetIndex];
      const label = STRATEGY_PRESET_LABELS[preset];
      for (const market of this.markets) {
        const newConfig = getPresetStrategyConfig(market.market_id, preset);
        this.engine.updateConfig(market.market_id, newConfig);
      }
      this.addLog(`{cyan-fg}Strategy switched to: ${label}{/cyan-fg}`);
    });
    this.screen.key(['h'], () => {
      this.viewMode = this.viewMode === 'log' ? 'history' : 'log';
      if (this.viewMode === 'history') {
        this.logBox?.hide(); this.historyBox?.show();
        this.renderTradeHistory();
      } else {
        this.historyBox?.hide(); this.logBox?.show();
      }
      this.screen?.render();
    });
    this.screen.key(['c'], async () => {
      const market = this.currentMarket;
      if (!market || !this.orderManager) return;
      this.addLog('{yellow-fg}Cancelling all open orders...{/yellow-fg}');
      try {
        await this.orderManager.cancelAllOrders(market);
        this.addLog('{green-fg}All open orders cancelled{/green-fg}');
      } catch (err: any) {
        this.addLog(`{red-fg}Cancel failed: ${err.message}{/red-fg}`);
      }
    });

    // ─── Event handlers ─────────────────────────────────
    this.logger.onLog((_level, msg) => this.addLog(msg));
    this.engine.on('cycle', (_mId: string, result: any) => {
      if (result.executed) {
        for (const o of result.orders || []) {
          if (o.success) {
            // Don't log here — the fill handler in index.ts logs the confirmed fill.
            // Only add to tape for the visual trades panel.
            this.addTapeFill({
              time: Date.now(),
              side: o.side,
              price: o.priceHuman || '?',
              quantity: o.quantityHuman || '?',
              pair: o.marketPair || '?',
              isNew: true,
            });
          } else if (o.error) {
            this.addLog(`{red-fg}Failed: ${o.error}{/red-fg}`);
          }
        }
      } else if (result.skipReason) {
        this.addLog(`{yellow-fg}Skip: ${result.skipReason}{/yellow-fg}`);
      }
      if (!result.executed && result.orders) {
        for (const o of result.orders) {
          if (!o.success && o.error) this.addLog(`{red-fg}Failed: ${o.error}{/red-fg}`);
        }
      }
    });
    this.engine.on('error', (mId: string, err: Error) => {
      this.addLog(`{red-fg}Error [${mId}]: ${err.message}{/red-fg}`);
    });

    this.loadTapeFromDb();
    this.updateInterval = setInterval(() => this.render(), 1000);
    this.fetchBars();
    this.render();
    this.screen.render();
  }

  // ─── Tape management ─────────────────────────────────
  private addTapeFill(fill: TapeFill): void {
    this.tapeFills.unshift(fill);
    if (this.tapeFills.length > MAX_TAPE_FILLS) this.tapeFills.pop();
    setTimeout(() => { fill.isNew = false; }, 3000);
  }

  private loadTapeFromDb(): void {
    const market = this.currentMarket;
    if (!market) return;
    const trades = dbQueries.getRecentTrades(market.market_id, 20);
    const pair = `${market.base.symbol}/${market.quote.symbol}`;
    for (const t of trades.reverse()) {
      this.tapeFills.unshift({
        time: t.timestamp,
        side: t.side,
        price: fmtPrice(t.price),
        quantity: fmtQty(t.size),
        pair,
        pnl: t.pnl_usdc != null
          ? (t.pnl_usdc >= 0 ? `+$${t.pnl_usdc.toFixed(4)}` : `-$${Math.abs(t.pnl_usdc).toFixed(4)}`)
          : undefined,
        isNew: false,
      });
    }
    if (this.tapeFills.length > MAX_TAPE_FILLS) this.tapeFills.length = MAX_TAPE_FILLS;
  }

  // ─── Core rendering ──────────────────────────────────
  private get currentMarket(): Market | undefined {
    return this.markets[this.currentMarketIndex];
  }

  private async render(): Promise<void> {
    if (!this.screen || this.noTui || this.rendering) return;
    this.rendering = true;
    try {
      const market = this.currentMarket;
      if (!market) return;

      if (Date.now() - this.lastBarFetch > 15000) this.fetchBars();
      if (Date.now() - this.lastOrdersFetch > 5000) this.fetchOpenOrders(market);

      const ticker = this.marketData.getCachedTicker(market.market_id);
      const book = this.marketData.getCachedOrderBook(market.market_id);

      // Track price history for sparkline
      if (ticker) {
        const priceScale = 10 ** market.quote.decimals;
        const p = parseFloat(ticker.last_price) / priceScale;
        if (p > 0) {
          this.priceHistory.push(p);
          if (this.priceHistory.length > this.MAX_PRICE_HISTORY) {
            this.priceHistory.shift();
          }
        }
      }

      this.renderHeader(market, ticker);
      this.renderCompetition();
      this.renderOrderbook(market, book, ticker);
      this.renderTape();
      this.renderChart(market);
      this.renderBalancePnl(market);
      if (this.viewMode === 'history') this.renderTradeHistory();
      this.screen?.render();
    } finally {
      this.rendering = false;
    }
  }

  // ─── HEADER ───────────────────────────────────────────
  private renderHeader(market: Market, ticker: MarketTicker | null): void {
    if (!this.headerBox) return;
    const pair = `${market.base.symbol}/${market.quote.symbol}`;
    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;

    const priceNum = ticker ? parseFloat(ticker.last_price) / priceScale : 0;
    const price = priceNum > 0 ? fmtPrice(priceNum) : '---';
    const change = ticker?.percentage ? parseFloat(ticker.percentage).toFixed(2) : '0.00';
    const changeNum = parseFloat(change);
    const highNum = ticker?.high ? parseFloat(ticker.high) / priceScale : 0;
    const lowNum = ticker?.low ? parseFloat(ticker.low) / priceScale : 0;
    const high = highNum > 0 ? fmtPrice(highNum) : '---';
    const low = lowNum > 0 ? fmtPrice(lowNum) : '---';
    const volNum = ticker?.base_volume ? parseFloat(ticker.base_volume) / baseScale : 0;
    const vol = volNum > 0 ? fmtVol(volNum, market.base.symbol) : '---';
    const uptime = this.formatUptime(Date.now() - this.startTime);

    // Gradient brand: cyan → pink
    const brand = gradient(`${DIAMOND} O2 BOT`, T.accent, T.accent2, true);

    // Price with subtle color
    const priceStr = tc(T.fg, `$${price}`);

    // Change with color
    const changeArrow = changeNum >= 0 ? ARROW_UP : ARROW_DOWN;
    const changeColor = changeNum >= 0 ? T.buy : T.sell;
    const changeStr = tc(changeColor, `${changeArrow}${changeNum >= 0 ? '+' : ''}${change}%`);

    // Sparkline
    const spark = sparkline(this.priceHistory, 20);
    const sparkSection = spark ? `  ${spark}` : '';

    // Status indicators
    const statusColor = this.engine.isRunning ? T.buy : (this.watchMode && !this.engine.isRunning ? T.accent : T.warn);
    const statusText = this.engine.isRunning ? 'RUNNING' : (this.watchMode ? 'WATCHING' : 'PAUSED');
    const statusDot = this.engine.isRunning ? DOT : (this.watchMode ? '◉' : DOT);
    const status = tc(statusColor, `${statusDot} ${statusText}`);
    const wsColor = this.wsClient?.isConnected ? T.buy : T.sell;
    const wsStr = tc(wsColor, 'WS');

    const marketNav = this.markets.length > 1
      ? ` ${tc(T.muted, `(${this.currentMarketIndex + 1}/${this.markets.length})`)}`
      : '';

    let sessionStr = '';
    if (this.sessionExpiry > 0) {
      const remainMs = this.sessionExpiry * 1000 - Date.now();
      if (remainMs > 0) {
        const days = Math.floor(remainMs / 86400000);
        const hrs = Math.floor((remainMs % 86400000) / 3600000);
        sessionStr = days > 0 ? ` Sess:${days}d${hrs}h` : ` Sess:${hrs}h`;
      } else {
        sessionStr = ` ${tc(T.sell, 'Sess:EXP')}`;
      }
    }
    const acctStr = this.tradeAccountId ? ` ${tc(T.dim, `Acct:${this.tradeAccountId.slice(0, 8)}..`)}` : '';

    // High/Low/Vol in muted color
    const hlv = tc(T.muted, `H:$${high} L:$${low}  Vol:${vol}`);

    // Line 1
    const line1 = `${brand}  ${tcB(T.fg, pair)}${marketNav}  ${priceStr}  ${changeStr}${sparkSection}  ${hlv}  ${tc(T.dim, VLINE)}  ${status} ${wsStr}${sessionStr}${acctStr}  ${tc(T.dim, uptime)}`;

    // Line 2: Controls
    const res = RESOLUTIONS[this.resolutionIndex];
    const stratLabel = STRATEGY_PRESET_LABELS[STRATEGY_PRESETS[this.currentPresetIndex]];
    const histKey = this.viewMode === 'history' ? tc(T.accent, '[h]ist') : tc(T.dim, '[h]ist');

    const pauseLabel = this.engine.isRunning ? '[p]ause' : (this.watchMode ? '[p] start trading' : '[p] resume');
    let controls = [
      tc(T.dim, '[q]uit'),
      tc(T.dim, pauseLabel),
      tc(T.dim, `[r]es:${res}`),
      tc(T.dim, `[s]:${stratLabel}`),
      histKey,
      tc(T.dim, '[c]ancel'),
    ];
    if (this.markets.length > 1) controls.push(tc(T.dim, '[[]prev []]next'));
    let line2 = controls.join(' ');

    const compState = this.competitionTracker?.getState();
    if (compState?.userEntry) {
      const comp = compState.competition;
      const u = compState.userEntry;
      const compTitle = this.stripHtmlTags(comp.title);
      const pnlNum = parseFloat(u.pnl) / 1e9;
      const pnlColor = pnlNum >= 0 ? T.buy : T.sell;
      const remainMs = compState.timeRemainingMs;
      const days = Math.floor(remainMs / 86400000);
      const hrs = Math.floor((remainMs % 86400000) / 3600000);
      const timeStr = days > 0 ? `${days}d${hrs}h` : `${hrs}h`;

      let streakStr = '';
      const streakInfo = this.competitionTracker?.getStreakInfo();
      if (streakInfo) {
        const streakColor = streakInfo.superBoostStatus === 'active' ? T.gold
          : streakInfo.superBoostStatus === 'lost' ? T.sell
          : T.accent;
        streakStr = ` ${tc(streakColor, `Str:${streakInfo.streakCount}`)}`;
        if (streakInfo.currentPeriodProgress) {
          streakStr += streakInfo.currentPeriodProgress.met
            ? tc(T.buy, ' OK')
            : tc(T.warn, ' Target!');
        }
      }

      line2 += `  ${tc(T.dim, VLINE)}  ${tc(T.accent, compTitle)} ${tc(T.gold, `#${u.rank}`)} Vol:${tc(T.fg, `$${this.fmtBigNum(u.volume)}`)} P&L:${tc(pnlColor, `$${this.fmtBigNum(u.pnl)}`)} ${tc(T.dim, timeStr)}${streakStr}`;
    }

    this.headerBox.setContent(line1 + '\n' + line2);
  }

  // ─── COMPETITION PANEL ───────────────────────────────
  private renderCompetition(): void {
    const compState = this.competitionTracker?.getState();
    const hasComp = compState?.isActive || (compState?.competition && compState?.userEntry);
    const compH = 13; // competition panel height

    if (!hasComp || !compState) {
      if (this.competitionBox && !this.competitionBox.hidden) {
        this.competitionBox.hide();
        this.chartBox!.top = 3;
        this.tapeBox!.top = 3;
        this.orderbookBox!.top = 3;
        (this.chartBox as any).height = '57%-3';
        (this.tapeBox as any).height = '57%-3';
        (this.orderbookBox as any).height = '57%-3';
      }
      return;
    }

    if (this.competitionBox?.hidden) {
      this.competitionBox.show();
      const shiftTo = 3 + compH;
      this.chartBox!.top = shiftTo;
      this.tapeBox!.top = shiftTo;
      this.orderbookBox!.top = shiftTo;
      (this.chartBox as any).height = `57%-${shiftTo}`;
      (this.tapeBox as any).height = `57%-${shiftTo}`;
      (this.orderbookBox as any).height = `57%-${shiftTo}`;
    }

    if (!this.competitionBox) return;

    const comp = compState.competition;
    const u = compState.userEntry;
    const remainMs = compState.timeRemainingMs;
    const days = Math.floor(remainMs / 86400000);
    const hrs = Math.floor((remainMs % 86400000) / 3600000);
    const mins = Math.floor((remainMs % 3600000) / 60000);
    const secs = Math.floor((remainMs % 60000) / 1000);
    const timeStr = days > 0
      ? `${days}d ${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const streakInfo = this.competitionTracker?.getStreakInfo();
    const config = comp.streakConfig;
    const currentPeriodConfig = config?.periods?.[streakInfo?.currentPeriodIndex ?? 0];
    const subs = this.competitionTracker?.getSubRankings();
    const lotteryInfo = this.competitionTracker?.getLotteryInfo();

    // ─── Title line (row 0 of competition box) ──────────
    const title = gradient(this.stripHtmlTags(comp.title), T.accent, T.accent2, true);
    let titleLine = ` ${title}`;
    titleLine += `     ${tc(T.dim, '\u23F1')} ${tcB(T.fg, timeStr)}`;
    if (comp.prizePool?.activeMilestone) {
      const pool = this.fmtBigNum(comp.prizePool.activeMilestone.rewardPool);
      titleLine += `     ${tc(T.gold, `\u2605 $${pool}`)}`;
    }
    titleLine += `     ${tc(T.dim, `${comp.totalTraders} traders`)}`;
    titleLine += `  ${tc(T.dim, `$${this.fmtBigNum(comp.totalVolume)} vol`)}`;

    // Add lottery + sub-rankings to title line (compact footer info)
    if (lotteryInfo) {
      titleLine += `     ${tc(T.accent2, 'Lottery')} ${tc(T.fg, `${lotteryInfo.ticketsThisPeriod}today`)} ${tc(T.fg, `${lotteryInfo.ticketsTotal}total`)} ${tc(T.gold, `${lotteryInfo.winsCount}wins`)}`;
    }
    if (subs) {
      const sParts: string[] = [];
      if (subs.taker) sParts.push(`${tc(T.muted, 'T')}${tc(T.fg, `#${subs.taker.rank}`)}`);
      if (subs.maker) sParts.push(`${tc(T.muted, 'M')}${tc(T.fg, `#${subs.maker.rank}`)}`);
      if (subs.pnl) sParts.push(`${tc(T.muted, 'P')}${tc(T.fg, `#${subs.pnl.rank}`)}`);
      if (subs.lottery) sParts.push(`${tc(T.muted, 'L')}${tc(T.fg, `#${subs.lottery.rank}`)}`);
      if (sParts.length > 0) titleLine += `  ${sParts.join(' ')}`;
    }
    this.competitionBox.setContent(titleLine);

    // ─── RANKING BOX ────────────────────────────────────
    if (this.compRankBox) {
      if (u) {
        let content = `${tcB(T.gold, `#${u.rank}`)}  ${tc(T.muted, 'Score')} ${tc(T.fg, this.fmtBigNum(u.score))}\n`;
        content += `${tc(T.muted, 'Vol')} ${tcB(T.fg, `$${this.fmtBigNum(u.volume)}`)}`;
        if (u.boostedVolume && u.boostedVolume !== u.volume) {
          content += `  ${tc(T.muted, 'Bst')} ${tc(T.accent, `$${this.fmtBigNum(u.boostedVolume)}`)}`;
        }
        // Taker / Maker sub-rankings
        if (subs?.taker || subs?.maker) {
          content += '\n';
          if (subs.taker) content += `${tc(T.muted, 'Taker')} ${tcB(T.fg, `#${subs.taker.rank}`)} ${tc(T.dim, `$${this.fmtBigNum(subs.taker.volume)}`)}`;
          if (subs.taker && subs.maker) content += `  `;
          if (subs.maker) content += `${tc(T.muted, 'Maker')} ${tcB(T.fg, `#${subs.maker.rank}`)} ${tc(T.dim, `$${this.fmtBigNum(subs.maker.volume)}`)}`;
        }
        this.compRankBox.setContent(content);
      } else {
        this.compRankBox.setContent(tc(T.muted, 'Not ranked yet'));
      }
    }

    // ─── P&L BOX ────────────────────────────────────────
    if (this.compPnlBox) {
      if (u) {
        const pnlNum = parseFloat(u.pnl) / 1e9;
        const realPnlNum = parseFloat(u.realizedPnl) / 1e9;
        const pnlC = pnlNum >= 0 ? T.buy : T.sell;
        const realC = realPnlNum >= 0 ? T.buy : T.sell;

        let content = `${tc(T.muted, 'Total')}  ${tc(pnlC, `$${this.fmtBigNum(u.pnl)}`)}`;
        if (subs?.pnl) content += `  ${tc(T.muted, '#')}${tc(T.fg, `${subs.pnl.rank}`)}`;
        content += `\n${tc(T.muted, 'Real.')}  ${tc(realC, `$${this.fmtBigNum(u.realizedPnl)}`)}\n`;
        content += `${tc(T.muted, '24h')}    ${tc(T.fg, `$${this.fmtBigNum(u.volume24h)}`)}`;
        this.compPnlBox.setContent(content);
      } else {
        this.compPnlBox.setContent(tc(T.dim, '\u2014'));
      }
    }

    // ─── MARKET BOOSTS BOX ──────────────────────────────
    if (this.compBoostBox) {
      const boosts = comp.marketBoosts;
      if (boosts && Object.keys(boosts).length > 0) {
        const lines: string[] = [];
        for (const [mktId, bpVal] of Object.entries(boosts)) {
          const mkt = this.marketData.getMarketByContractId(mktId) || this.marketData.getMarket(mktId);
          const label = mkt ? `${mkt.base.symbol}/${mkt.quote.symbol}` : mktId.slice(0, 10);
          const mult = (bpVal / 10000).toFixed(1);
          lines.push(`${tc(T.fg, label.padEnd(12))} ${tc(T.gold, `x${mult}`)}`);
        }
        this.compBoostBox.setContent(lines.join('\n'));
      } else {
        this.compBoostBox.setContent(tc(T.dim, 'No active boosts'));
      }
    }

    // ─── DAILY BOOST BOX ────────────────────────────────
    if (this.compDailyBox) {
      if (streakInfo && currentPeriodConfig) {
        const boostPct = Math.round((currentPeriodConfig.boostBp / 100) - 100);
        let content = `${tcB(T.buy, `+${boostPct}%`)}  `;

        if (streakInfo.currentPeriodProgress) {
          const prog = streakInfo.currentPeriodProgress;
          const curVol = this.fmtBigNum(prog.volume);
          const tgtVol = this.fmtBigNum(prog.target);
          const pct = parseFloat(prog.target) > 0 ? Math.min(1, parseFloat(prog.volume) / parseFloat(prog.target)) : 0;
          const barLen = 15;
          const filledLen = Math.round(pct * barLen);
          const emptyLen = barLen - filledLen;
          const barClr = prog.met ? T.buy : T.accent;

          content += `${tc(barClr, BLOCK.repeat(filledLen))}${tc(T.dim, HLINE.repeat(emptyLen))}`;
          content += ` ${tcB(T.fg, `${Math.round(pct * 100)}%`)}`;
          content += `  ${tc(T.fg, `$${curVol}`)}${tc(T.muted, '/')}${tc(T.fg, `$${tgtVol}`)}`;
          if (prog.met) content += ` ${tcB(T.buy, '\u2713')}`;
        }

        // Period countdown
        const periodEnd = new Date(currentPeriodConfig.endTime).getTime();
        const periodRemain = Math.max(0, periodEnd - Date.now());
        if (periodRemain > 0) {
          const pH = Math.floor(periodRemain / 3600000);
          const pM = Math.floor((periodRemain % 3600000) / 60000);
          const pS = Math.floor((periodRemain % 60000) / 1000);
          content += `  ${tc(T.dim, 'resets')} ${tc(T.fg, `${String(pH).padStart(2, '0')}:${String(pM).padStart(2, '0')}:${String(pS).padStart(2, '0')}`)}`;
        }
        this.compDailyBox.setContent(content);
      } else {
        this.compDailyBox.setContent(tc(T.dim, 'No daily boost'));
      }
    }

    // ─── STREAK BOX ─────────────────────────────────────
    if (this.compStreakBox) {
      if (streakInfo && streakInfo.totalPeriods > 0) {
        const periods = streakInfo.periods;
        const totalP = streakInfo.totalPeriods;
        const currentIdx = streakInfo.currentPeriodIndex;

        let content = '';
        for (let i = 0; i < totalP; i++) {
          const userP = periods.find(p => p.periodIndex === i);
          const isCurrent = i === currentIdx;
          const isFuture = i > currentIdx;

          if (isCurrent) {
            if (userP?.targetMet) {
              content += tcB(T.buy, `[${DOT}]`);
            } else {
              const pct = userP && parseFloat(userP.targetVolume) > 0
                ? Math.round(parseFloat(userP.volume) / parseFloat(userP.targetVolume) * 100) : 0;
              content += tcB(T.warn, `[${pct}%]`);
            }
          } else if (userP) {
            content += userP.targetMet ? tc(T.buy, DOT) : tc(T.sell, '\u2717');
          } else if (isFuture) {
            content += tc(T.dim, '\u25CB');
          } else {
            content += tc(T.dim, '\u25CB');
          }
          if (i < totalP - 1) content += ' ';
        }

        content += `  ${tc(T.muted, 'x')}${tcB(T.fg, String(streakInfo.streakCount))}`;
        content += ` ${tc(T.dim, `D${currentIdx + 1}/${totalP}`)}`;

        // Super Boost
        if (currentPeriodConfig?.superBoostBp) {
          const sbMult = (currentPeriodConfig.superBoostBp / 10000).toFixed(1);
          if (streakInfo.superBoostStatus === 'active') {
            content += `  ${tc(T.gold, `\u26A1x${sbMult}`)} ${tcB(T.buy, 'ACTIVE')}`;
          } else if (streakInfo.superBoostStatus === 'lost') {
            const brokenDay = streakInfo.superBoostStreakBrokenDay ?? 0;
            content += `  ${tc(T.sell, `\u26A1 lost D${brokenDay}`)}`;
          } else {
            const sbNeeded = currentPeriodConfig.superBoostStreakNeeded || 0;
            const remaining = Math.max(0, sbNeeded - streakInfo.streakCount);
            content += `  ${tc(T.dim, `\u26A1x${sbMult} in ${remaining}d`)}`;
          }
        }
        this.compStreakBox.setContent(content);
      } else {
        this.compStreakBox.setContent(tc(T.dim, 'No streak data'));
      }
    }
  }

  // ─── ORDERBOOK ────────────────────────────────────────
  private renderOrderbook(market: Market, book: OrderBookDepth | null, ticker: MarketTicker | null): void {
    if (!this.orderbookBox) return;
    const innerW = (this.orderbookBox as any).width - 2;
    const innerH = (this.orderbookBox as any).height - 2;

    if (!book || (!book.asks.length && !book.bids.length)) {
      this.orderbookBox.setContent(` ${tc(T.accent, 'Waiting for orderbook...')}`);
      return;
    }

    // Staleness indicator + WS depth diagnostic
    const bookAge = book.timestamp ? Math.floor((Date.now() - book.timestamp) / 1000) : -1;
    const wsCount = this.marketData.wsDepthCount;
    const wsTag = wsCount > 0 ? tc(T.buy, `ws:${wsCount}`) : tc(T.sell, 'ws:0');
    const staleTag = bookAge > 5
      ? ` ${tc(T.sell, `${bookAge}s`)} ${wsTag}`
      : bookAge >= 0
        ? ` ${tc(T.dim, `${bookAge}s`)} ${wsTag}`
        : ` ${wsTag}`;

    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;
    const rowsPerSide = Math.max(3, Math.floor((innerH - 2) / 2));
    const rawAsks = book.asks.slice(0, rowsPerSide);
    const rawBids = book.bids.slice(0, rowsPerSide);

    let maxTotalUsd = 0;
    const parseLevel = (raw: [string, string]) => {
      const price = parseFloat(raw[0]) / priceScale;
      const qty = parseFloat(raw[1]) / baseScale;
      const totalUsd = price * qty;
      if (totalUsd > maxTotalUsd) maxTotalUsd = totalUsd;
      return { price, qty, totalUsd };
    };

    const askLevels = rawAsks.map(parseLevel).reverse();
    const bidLevels = rawBids.map(parseLevel);

    const priceW = Math.max(8, fmtPrice(askLevels[0]?.price || bidLevels[0]?.price || 0).length + 1);
    const qtyW = 8;
    const barW = Math.max(2, innerW - priceW - qtyW - 5);

    // Header with staleness
    let content = ` ${tc(T.muted, 'Price'.padStart(priceW))} ${tc(T.muted, 'Qty'.padStart(qtyW))}  ${tc(T.muted, 'Depth')}${staleTag}\n`;

    // Asks (red gradient) — highest at top, lowest near spread
    for (let i = 0; i < askLevels.length; i++) {
      const lvl = askLevels[i];
      const ratio = maxTotalUsd > 0 ? lvl.totalUsd / maxTotalUsd : 0;
      const bar = depthBar(ratio, barW, T.sell, T.sellDim);
      const isNear = i >= askLevels.length - 2;
      // Zebra: alternate row brightness
      const rowColor = i % 2 === 0
        ? lerpRGB(T.sell, T.fg, isNear ? 0.3 : 0.1)
        : T.sell;
      const priceTxt = isNear
        ? tcB(rowColor, fmtPrice(lvl.price).padStart(priceW))
        : tc(rowColor, fmtPrice(lvl.price).padStart(priceW));
      const qtyTxt = tc(i % 2 === 0 ? T.muted : T.fg, fmtQty(lvl.qty).padStart(qtyW));
      content += ` ${priceTxt} ${qtyTxt}  ${bar}\n`;
    }

    // Spread
    if (rawBids.length > 0 && rawAsks.length > 0) {
      const bestBid = parseFloat(rawBids[0][0]) / priceScale;
      const bestAsk = parseFloat(rawAsks[0][0]) / priceScale;
      const spread = bestAsk - bestBid;
      const spreadPct = bestBid > 0 ? ((spread / bestBid) * 100) : 0;
      const lastP = ticker ? parseFloat(ticker.last_price) / priceScale : (bestBid + bestAsk) / 2;
      const spreadLine = gradient(` ${HLINE.repeat(3)} `, T.sell, T.buy)
        + tcB(T.gold, `$${fmtPrice(lastP)}`)
        + tc(T.muted, ` ${HLINE} ${spreadPct.toFixed(3)}%`)
        + gradient(` ${HLINE.repeat(3)} `, T.buy, T.sell);
      content += spreadLine + '\n';
    }

    // Bids (green gradient) — highest near spread
    for (let i = 0; i < bidLevels.length; i++) {
      const lvl = bidLevels[i];
      const ratio = maxTotalUsd > 0 ? lvl.totalUsd / maxTotalUsd : 0;
      const bar = depthBar(ratio, barW, T.buy, T.buyDim);
      const isNear = i < 2;
      const rowColor = i % 2 === 0
        ? lerpRGB(T.buy, T.fg, isNear ? 0.3 : 0.1)
        : T.buy;
      const priceTxt = isNear
        ? tcB(rowColor, fmtPrice(lvl.price).padStart(priceW))
        : tc(rowColor, fmtPrice(lvl.price).padStart(priceW));
      const qtyTxt = tc(i % 2 === 0 ? T.muted : T.fg, fmtQty(lvl.qty).padStart(qtyW));
      content += ` ${priceTxt} ${qtyTxt}  ${bar}\n`;
    }

    this.orderbookBox.setContent(content);
  }

  // ─── TRADES TAPE ──────────────────────────────────────
  private renderTape(): void {
    if (!this.tapeBox) return;
    const innerH = (this.tapeBox as any).height - 2;

    if (this.tapeFills.length === 0) {
      this.tapeBox.setContent(tc(T.accent, 'Waiting for fills...'));
      return;
    }

    const visibleFills = this.tapeFills.slice(0, Math.max(1, innerH - 1));

    // Header
    let content = tcB(T.muted, 'Time  Side Qty      Price') + '\n';

    for (let idx = 0; idx < visibleFills.length; idx++) {
      const fill = visibleFills[idx];
      const time = fmtTime(fill.time);
      const isBuy = fill.side === 'Buy' || fill.side === 'buy';

      if (fill.isNew) {
        // Flash animation: bright gold/white for new fills
        const flashAge = (Date.now() - fill.time) / 3000; // 0→1 over 3s
        const flashColor = lerpRGB(T.flash, isBuy ? T.buy : T.sell, Math.min(1, flashAge));
        const sideText = isBuy ? 'BUY ' : 'SELL';
        const line = tcB(flashColor, `${time} ${sideText} ${fill.quantity.slice(0, 8).padEnd(8)} $${fill.price}`);
        content += line;
      } else {
        const sideColor = isBuy ? T.buy : T.sell;
        const sideText = isBuy ? 'BUY ' : 'SELL';
        // Zebra effect: alternate row brightness
        const textColor = idx % 2 === 0 ? T.fg : T.muted;
        content += `${tc(textColor, time)} ${tcB(sideColor, sideText)} ${tc(textColor, fill.quantity.slice(0, 8).padEnd(8))} ${tc(textColor, '$' + fill.price)}`;
      }

      if (fill.pnl) {
        const pnlColor = fill.pnl.startsWith('+') ? T.buy : T.sell;
        content += ` ${tc(pnlColor, fill.pnl)}`;
      }

      content += '\n';
    }

    this.tapeBox.setContent(content);
  }

  // ─── CHART ────────────────────────────────────────────
  private renderChart(market: Market): void {
    if (!this.chartBox) return;
    const innerW = (this.chartBox as any).width - 4;
    const innerH = (this.chartBox as any).height - 3;
    if (innerW < 10 || innerH < 5 || this.bars.length === 0) {
      this.chartBox.setContent(` ${tc(T.accent, 'Loading chart...')}`);
      return;
    }

    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;
    const samplePrice = this.bars.length > 0 ? parseFloat(this.bars[0].close) / priceScale : 0;
    const yLabelW = Math.max(10, fmtPrice(samplePrice).length + 2);
    const chartW = Math.max(1, innerW - yLabelW - 1);
    const chartH = Math.max(3, innerH - 4);

    const maxCandles = Math.floor(chartW / 2);
    const visibleBars = this.bars.slice(-maxCandles);
    if (visibleBars.length === 0) { this.chartBox.setContent(` ${tc(T.muted, 'No bar data')}`); return; }

    let priceMin = Infinity, priceMax = -Infinity, volMax = 0;
    for (const b of visibleBars) {
      const hi = parseFloat(b.high) / priceScale;
      const lo = parseFloat(b.low) / priceScale;
      const v = (parseFloat(b.buy_volume) + parseFloat(b.sell_volume)) / baseScale;
      if (hi > priceMax) priceMax = hi;
      if (lo < priceMin) priceMin = lo;
      if (v > volMax) volMax = v;
    }
    const priceRange = priceMax - priceMin || samplePrice * 0.01 || 1;
    priceMin -= priceRange * 0.02;
    priceMax += priceRange * 0.02;
    const adjustedRange = priceMax - priceMin;

    const priceToRow = (p: number): number => {
      return Math.round((priceMax - p) / adjustedRange * (chartH - 1));
    };

    // Build grid with truecolor candle strings
    const grid: string[][] = [];
    for (let r = 0; r < chartH; r++) grid[r] = new Array(chartW).fill(' ');

    for (let i = 0; i < visibleBars.length; i++) {
      const b = visibleBars[i];
      const o = parseFloat(b.open) / priceScale;
      const cl = parseFloat(b.close) / priceScale;
      const hi = parseFloat(b.high) / priceScale;
      const lo = parseFloat(b.low) / priceScale;
      const col = i * 2;
      if (col >= chartW) break;

      const bullish = cl >= o;
      const bodyTop = priceToRow(Math.max(o, cl));
      const bodyBot = priceToRow(Math.min(o, cl));
      const wickTop = priceToRow(hi);
      const wickBot = priceToRow(lo);
      const color = bullish ? T.buy : T.sell;
      const wickColor = bullish ? T.buyDim : T.sellDim;

      for (let r = wickTop; r <= wickBot; r++) {
        if (r >= 0 && r < chartH) {
          if (r >= bodyTop && r <= bodyBot) {
            grid[r][col] = tc(color, '\u2588');
          } else {
            grid[r][col] = tc(wickColor, '\u2502');
          }
        }
      }
      if (bodyTop === bodyBot && bodyTop >= 0 && bodyTop < chartH) {
        grid[bodyTop][col] = tc(color, '\u2501');
      }
    }

    // Volume sparkline with gradient
    const volBars: string[] = [];
    for (let i = 0; i < visibleBars.length; i++) {
      const b = visibleBars[i];
      const v = (parseFloat(b.buy_volume) + parseFloat(b.sell_volume)) / baseScale;
      const ratio = volMax > 0 ? v / volMax : 0;
      const idx = Math.min(Math.floor(ratio * 8), 7);
      const bullish = parseFloat(b.close) >= parseFloat(b.open);
      const color = bullish ? T.buy : T.sell;
      const dimColor = bullish ? T.buyDim : T.sellDim;
      // Color intensity by volume ratio
      const c = lerpRGB(dimColor, color, ratio);
      volBars.push(chalk.rgb(c[0], c[1], c[2])(SPARK[idx]));
      if (i < visibleBars.length - 1) volBars.push(' ');
    }

    // Y-axis labels
    const yLabels: string[] = [];
    const labelStep = Math.max(1, Math.floor(chartH / 5));
    for (let r = 0; r < chartH; r++) {
      if (r % labelStep === 0 || r === chartH - 1) {
        const p = priceMax - (r / (chartH - 1)) * adjustedRange;
        yLabels[r] = tc(T.dim, fmtPrice(p).padStart(yLabelW));
      } else {
        yLabels[r] = ' '.repeat(yLabelW);
      }
    }

    // Buy/Sell pressure bar with gradient
    const bk = this.marketData.getCachedOrderBook(market.market_id);
    let pressureLine = '';
    if (bk && bk.bids.length && bk.asks.length) {
      let totalBidVol = 0, totalAskVol = 0;
      for (const [, qty] of bk.bids.slice(0, 10)) totalBidVol += parseFloat(qty) / baseScale;
      for (const [, qty] of bk.asks.slice(0, 10)) totalAskVol += parseFloat(qty) / baseScale;
      const total = totalBidVol + totalAskVol;
      if (total > 0) {
        const buyPct = Math.round((totalBidVol / total) * 100);
        const barLen = Math.max(8, chartW - 24);
        const buyLen = Math.round((buyPct / 100) * barLen);
        const sellLen = barLen - buyLen;
        const buyBar = depthBar(1, buyLen, T.buy, T.buyDim);
        const sellBar = depthBar(1, sellLen, T.sell, T.sellDim);
        pressureLine = ` ${tcB(T.buy, 'BUY')} ${buyBar}${sellBar} ${tcB(T.sell, 'SELL')}  ${tc(T.muted, `${buyPct}%/${100 - buyPct}%`)}`;
      }
    }

    const res = RESOLUTIONS[this.resolutionIndex];
    const title = gradient(`${market.base.symbol}/${market.quote.symbol}`, T.accent, T.accent2, true)
      + tc(T.dim, ` ${HLINE} ${res}`);
    let content = ` ${title}\n`;
    for (let r = 0; r < chartH; r++) {
      content += `${yLabels[r]}${tc(T.dim, '\u2524')}${grid[r].join('')}\n`;
    }
    content += ' '.repeat(yLabelW) + tc(T.dim, '\u2514' + '\u2500'.repeat(Math.min(chartW, visibleBars.length * 2))) + '\n';
    content += ' '.repeat(yLabelW + 1) + volBars.join('');
    if (pressureLine) content += '\n' + pressureLine;

    this.chartBox.setContent(content);
  }

  // ─── BALANCE & P&L ────────────────────────────────────
  private renderBalancePnl(market: Market): void {
    if (!this.balancePnlBox) return;
    const mId = market.market_id;
    const baseHuman = this.balanceTracker.getBaseBalanceHuman(mId);
    const quoteHuman = this.balanceTracker.getQuoteBalanceHuman(mId);
    const aggPnl = this.pnlCalc.getSnapshot();
    const contexts = this.engine.getContexts();
    const ctx = contexts.find(c => c.marketId === mId);
    const midPrice = this.marketData.getMidPrice(mId) || 0;
    const baseUsd = baseHuman * midPrice;
    const totalUsd = quoteHuman + baseUsd;

    let unrealizedPnl = 0;
    if (aggPnl.averageBuyPrice > 0 && baseHuman > 0 && midPrice > 0) {
      unrealizedPnl = (midPrice - aggPnl.averageBuyPrice) * baseHuman;
    }
    const totalPnl = aggPnl.realizedPnl + unrealizedPnl;

    const pnlClr = (n: number): RGB => n >= 0 ? T.buy : T.sell;
    const pnlSign = (n: number) => n >= 0 ? '+' : '';

    let content = '';

    // Balances
    content += `${tcB(T.accent, `${TRI} Balances`)}\n`;
    content += `  ${tc(T.muted, market.quote.symbol.padEnd(5))} ${tc(T.fg, quoteHuman.toFixed(2).padStart(11))} ${tc(T.dim, market.quote.symbol)}\n`;
    content += `  ${tc(T.muted, market.base.symbol.padEnd(5))} ${tc(T.fg, fmtQty(baseHuman).padStart(11))} ${tc(T.dim, market.base.symbol)}\n`;
    if (baseUsd > 0) {
      content += `  ${tcB(T.gold, `Total ${fmtUsd(totalUsd).padStart(11)}`)}\n`;
    }

    // P&L
    content += `\n${tcB(T.accent, `${TRI} Session P&L`)}\n`;
    const realStr = `${pnlSign(aggPnl.realizedPnl)}$${Math.abs(aggPnl.realizedPnl).toFixed(4)}`;
    content += `  ${tc(T.muted, 'Real.')}  ${tc(pnlClr(aggPnl.realizedPnl), realStr)}`;
    content += `  ${tc(T.muted, 'Vol')} ${tc(T.fg, fmtUsd(aggPnl.totalVolume))}\n`;

    if (baseHuman > 0 && aggPnl.averageBuyPrice > 0) {
      const unrlStr = `${pnlSign(unrealizedPnl)}$${Math.abs(unrealizedPnl).toFixed(4)}`;
      content += `  ${tc(T.muted, 'Unrl.')}  ${tc(pnlClr(unrealizedPnl), unrlStr)}`;
      content += `  ${tc(T.muted, 'Fee')} ${tc(T.fg, `$${aggPnl.totalFees.toFixed(4)}`)}\n`;
      const totStr = `${pnlSign(totalPnl)}$${Math.abs(totalPnl).toFixed(4)}`;
      content += `  ${tcB(T.muted, 'Total')}  ${tcB(pnlClr(totalPnl), totStr)}\n`;
    } else {
      content += `  ${tc(T.muted, 'Fee')} ${tc(T.fg, `$${aggPnl.totalFees.toFixed(4)}`)}\n`;
    }
    content += `  ${tc(T.muted, 'Trades')} ${tc(T.fg, `${aggPnl.tradeCount}`)} ${tc(T.dim, `(${aggPnl.buyCount}B/${aggPnl.sellCount}S)`)}`;
    if (aggPnl.averageBuyPrice > 0) content += ` ${tc(T.muted, 'AvgB:')}${tc(T.fg, `$${fmtPrice(aggPnl.averageBuyPrice)}`)}`;
    content += '\n';

    // Strategy
    if (ctx) {
      const cfg = this.engine.getStrategyConfig(mId);
      content += `\n${tcB(T.accent, `${TRI} Strategy`)}\n`;
      const activeStr = ctx.isActive ? tc(T.buy, 'ON') : tc(T.sell, 'OFF');
      content += `  ${tc(T.fg, ctx.strategy)} ${activeStr}`;
      if (cfg) {
        const ot = cfg.orderConfig.orderType === 'Spot' ? 'Limit' : 'Market';
        const pm = cfg.orderConfig.priceMode;
        const side = cfg.orderConfig.side;
        content += `  ${tc(T.dim, `${ot} ${VLINE} ${pm} ${VLINE} ${side}`)}\n`;
        if (cfg.positionSizing.sizeMode === 'fixedUsd') {
          content += `  ${tc(T.muted, 'Size:')} ${tc(T.fg, `$${cfg.positionSizing.fixedUsdAmount || 0} fixed`)}`;
        } else {
          content += `  ${tc(T.muted, 'Size:')} ${tc(T.fg, `${cfg.positionSizing.quoteBalancePercentage}%Q/${cfg.positionSizing.baseBalancePercentage}%B`)}`;
        }
        if (cfg.positionSizing.maxOrderSizeUsd) content += ` ${tc(T.dim, `(max $${cfg.positionSizing.maxOrderSizeUsd})`)}`;
        content += '\n';
        if (cfg.orderManagement.onlySellAboveBuyPrice) {
          content += `  ${tc(T.accent, 'Sell>Buy')} ${tc(T.muted, 'TP:')}${tc(T.fg, `${cfg.riskManagement.takeProfitPercent}%`)}`;
          if (cfg.averageBuyPrice && cfg.averageBuyPrice !== '0') {
            content += ` ${tc(T.muted, 'AvgBuy:')}${tc(T.fg, `$${fmtPrice(parseFloat(cfg.averageBuyPrice))}`)}`;
          }
          content += '\n';
        }
        if (cfg.riskManagement.stopLossEnabled) content += `  ${tc(T.sell, `SL:${cfg.riskManagement.stopLossPercent}%`)} `;
        if (cfg.riskManagement.orderTimeoutEnabled) content += `  ${tc(T.muted, `Timeout:${cfg.riskManagement.orderTimeoutMinutes}m`)}`;
        if (cfg.riskManagement.stopLossEnabled || cfg.riskManagement.orderTimeoutEnabled) content += '\n';
        const nextRun = this.engine.getNextRunTime(mId);
        const countdown = nextRun ? Math.max(0, Math.ceil((nextRun - Date.now()) / 1000)) : 0;
        content += `  ${tc(T.muted, 'Cycle:')} ${tc(T.fg, `${(cfg.timing.cycleIntervalMinMs / 1000).toFixed(0)}-${(cfg.timing.cycleIntervalMaxMs / 1000).toFixed(0)}s`)}`;
        if (cfg.orderConfig.maxSpreadPercent > 0) content += ` ${tc(T.muted, `Spread<${cfg.orderConfig.maxSpreadPercent}%`)}`;
        if (countdown > 0) content += `  ${tc(T.warn, `Next:${countdown}s`)}`;
        content += '\n';
      } else {
        content += '\n';
      }
    }

    // Open Orders
    if (this.openOrders.length > 0) {
      const qScale = 10 ** market.quote.decimals;
      const bScale = 10 ** market.base.decimals;
      content += `\n${tcB(T.accent, `${TRI} Open Orders (${this.openOrders.length})`)}\n`;
      for (const o of this.openOrders.slice(0, 5)) {
        const side = o.side === 'Buy' ? tcB(T.buy, 'BUY') : tcB(T.sell, 'SELL');
        const price = fmtPrice(parseFloat(o.price) / qScale);
        const qty = fmtQty(parseFloat(o.quantity) / bScale);
        content += `  ${side} ${tc(T.fg, qty)} @ ${tc(T.fg, `$${price}`)}\n`;
      }
      if (this.openOrders.length > 5) {
        content += `  ${tc(T.accent, `+${this.openOrders.length - 5} more`)}\n`;
      }
    }

    this.balancePnlBox.setContent(content);
  }

  // ─── TRADE HISTORY ────────────────────────────────────
  private renderTradeHistory(): void {
    if (!this.historyBox) return;
    const market = this.currentMarket;
    if (!market) return;

    const pair = `${market.base.symbol}/${market.quote.symbol}`;
    const trades = dbQueries.getRecentTrades(market.market_id, 40);

    const title = gradient(`${pair} ${HLINE} Fills (${trades.length})`, T.accent, T.accent2, true);
    let content = `${title}\n`;
    content += ` ${tc(T.muted, 'Time'.padEnd(10))} ${tc(T.muted, 'Side'.padEnd(5))} ${tc(T.muted, 'Price'.padEnd(13))} ${tc(T.muted, 'Qty'.padEnd(11))} ${tc(T.muted, 'Value'.padEnd(10))} ${tc(T.muted, 'Fee'.padEnd(9))} ${tc(T.muted, 'P&L')}\n`;
    content += ` ${tc(T.dim, HLINE.repeat(72))}\n`;

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const time = fmtTimeFull(t.timestamp);
      const sideColor = t.side === 'Buy' ? T.buy : T.sell;
      const side = t.side === 'Buy' ? tcB(T.buy, 'BUY ') : tcB(T.sell, 'SELL');
      const price = '$' + fmtPrice(t.price);
      const qty = fmtQty(t.size);
      const value = fmtUsd(t.price * t.size);
      const fee = '$' + (t.fee || 0).toFixed(4);
      let pnl = tc(T.dim, '   -');
      if (t.pnl_usdc != null) {
        pnl = t.pnl_usdc >= 0
          ? tc(T.buy, `+$${t.pnl_usdc.toFixed(4)}`)
          : tc(T.sell, `-$${Math.abs(t.pnl_usdc).toFixed(4)}`);
      }
      // Zebra striping
      const rowFg = i % 2 === 0 ? T.fg : T.muted;
      content += ` ${tc(rowFg, time.padEnd(10))} ${side} ${tc(rowFg, price.padEnd(13))} ${tc(rowFg, qty.padEnd(11))} ${tc(rowFg, value.padEnd(10))} ${tc(rowFg, fee.padEnd(9))} ${pnl}\n`;
    }

    if (trades.length === 0) {
      content += ` ${tc(T.muted, 'No fills recorded yet.')}\n`;
    }

    const stats = dbQueries.getTradeStats(market.market_id);
    if (stats.totalTrades > 0) {
      content += ` ${tc(T.dim, HLINE.repeat(72))}\n`;
      content += ` ${tc(T.muted, 'Trades:')} ${tc(T.fg, `${stats.totalTrades}`)} ${tc(T.dim, `(${stats.buyCount}B/${stats.sellCount}S)`)}  `;
      content += `${tc(T.muted, 'Vol:')} ${tc(T.fg, `$${stats.totalVolume.toFixed(2)}`)}  `;
      content += `${tc(T.muted, 'Fees:')} ${tc(T.fg, `$${stats.totalFees.toFixed(4)}`)}  `;
      content += `${tc(T.muted, 'P&L:')} ${tc(pnlClr(stats.realizedPnl), `$${stats.realizedPnl.toFixed(4)}`)}\n`;
    }

    const orders = dbQueries.getRecentOrders(market.market_id, 15);
    if (orders.length > 0) {
      const qScale = 10 ** market.quote.decimals;
      const bScale = 10 ** market.base.decimals;
      content += `\n${tcB(T.accent, `Recent Orders (${orders.length})`)}\n`;
      content += ` ${tc(T.muted, 'Time'.padEnd(10))} ${tc(T.muted, 'Side'.padEnd(5))} ${tc(T.muted, 'Type'.padEnd(7))} ${tc(T.muted, 'Price'.padEnd(13))} ${tc(T.muted, 'Qty'.padEnd(11))} ${tc(T.muted, 'Status')}\n`;
      content += ` ${tc(T.dim, HLINE.repeat(60))}\n`;
      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        const d = new Date(o.created_at);
        const time = fmtTimeFull(d.getTime());
        const side = o.side === 'Buy' ? tcB(T.buy, 'BUY ') : tcB(T.sell, 'SELL');
        const orderType = (o.order_type || 'Market').padEnd(7);
        const price = '$' + fmtPrice(parseFloat(o.price) / qScale);
        const qty = fmtQty(parseFloat(o.quantity) / bScale);
        let status: string;
        switch (o.status) {
          case 'filled': status = tc(T.buy, 'filled'); break;
          case 'cancelled': status = tc(T.warn, 'cancel'); break;
          case 'partially_filled': status = tc(T.accent, 'partial'); break;
          case 'open': status = tc(T.fg, 'open'); break;
          default: status = tc(T.dim, o.status); break;
        }
        const rowFg = i % 2 === 0 ? T.fg : T.muted;
        content += ` ${tc(rowFg, time.padEnd(10))} ${side} ${tc(rowFg, orderType)} ${tc(rowFg, price.padEnd(13))} ${tc(rowFg, qty.padEnd(11))} ${status}\n`;
      }
    }

    this.historyBox.setContent(content);
  }

  // ─── Data fetchers ────────────────────────────────────
  private async fetchOpenOrders(market: Market): Promise<void> {
    if (!this.orderManager) return;
    try {
      this.openOrders = await this.orderManager.getOpenOrders(market);
    } catch { /* ignore */ }
    this.lastOrdersFetch = Date.now();
  }

  private stripHtmlTags(str: string): string {
    return str.replace(/<[^>]*>/g, '');
  }

  private fmtBigNum(val: string | undefined): string {
    if (!val) return '0';
    const n = parseFloat(val) / 1e9;
    if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    if (Math.abs(n) >= 1) return n.toFixed(2);
    if (Math.abs(n) >= 0.01) return n.toFixed(4);
    return n.toFixed(2);
  }

  private async fetchBars(): Promise<void> {
    const market = this.currentMarket;
    if (!market) return;
    try {
      this.bars = await this.restClient.getBars(market.market_id, RESOLUTIONS[this.resolutionIndex], 60);
    } catch { /* ignore */ }
    this.lastBarFetch = Date.now();
  }

  // ─── Public API ───────────────────────────────────────
  getCompetitionTracker(): CompetitionTracker | null {
    return this.competitionTracker;
  }

  updateSessionExpiry(expiry: number): void {
    this.sessionExpiry = expiry;
  }

  addLog(message: string): void {
    if (this.noTui) return;
    if (this.logBox) this.logBox.log(message);
  }

  private formatUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ${s % 60}s`;
  }

  shutdown(): void {
    if (this.updateInterval) { clearInterval(this.updateInterval); this.updateInterval = null; }
    if (this.screen) { this.screen.destroy(); this.screen = null; }
  }
}

// Helper used outside class scope for trade history
function pnlClr(n: number): RGB {
  return n >= 0 ? T.buy : T.sell;
}
