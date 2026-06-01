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
import type { StrategyPreset, StrategyConfig } from '../types/strategy.js';
import { getPresetStrategyConfig, STRATEGY_PRESET_LABELS, STRATEGY_PRESET_DESCRIPTIONS } from '../types/strategy.js';
import * as dbQueries from '../db/queries.js';
import {
  showPickerModal,
  showConfirmModal,
  showFormModal,
  showOrderEntryModal,
  type OrderEntryType,
  showHelpOverlay,
  type FormField,
  type HelpSection,
} from './modals.js';

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

  // Modal/visibility state — depth-counted so nested modals don't release the
  // hotkey lock prematurely.
  private modalDepth = 0;
  private get modalActive(): boolean { return this.modalDepth > 0; }
  private wsReconnectCount = 0;
  private lastWsError: string | null = null;
  // Per-market user-toggled pause (front-end overlay; the engine-level
  // pause method may not exist yet — see TODO(wave3-wiring))
  private localPausedMarkets: Set<string> = new Set();

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
    // q is suppressed when a modal is open so it can be used to dismiss
    // the modal. C-c always quits as a hard exit.
    this.screen.key(['q'], () => { if (this.modalActive) return; if (this.onQuit) this.onQuit(); });
    this.screen.key(['C-c'], () => { if (this.onQuit) this.onQuit(); });
    this.screen.key(['p'], () => {
      if (this.modalActive) return;
      if (this.engine.isRunning) { this.engine.stop(); this.addLog('{yellow-fg}Bot paused{/yellow-fg}'); }
      else {
        this.watchMode = false;
        this.engine.start();
        this.addLog('{green-fg}Bot resumed{/green-fg}');
      }
    });
    this.screen.key(['['], () => {
      if (this.modalActive) return;
      if (this.markets.length > 1) {
        this.currentMarketIndex = (this.currentMarketIndex - 1 + this.markets.length) % this.markets.length;
        this.lastBarFetch = 0;
        this.priceHistory = [];
        this.addLog(`Switched to ${this.currentMarket?.base.symbol}/${this.currentMarket?.quote.symbol}`);
      }
    });
    this.screen.key([']'], () => {
      if (this.modalActive) return;
      if (this.markets.length > 1) {
        this.currentMarketIndex = (this.currentMarketIndex + 1) % this.markets.length;
        this.lastBarFetch = 0;
        this.priceHistory = [];
        this.addLog(`Switched to ${this.currentMarket?.base.symbol}/${this.currentMarket?.quote.symbol}`);
      }
    });
    this.screen.key(['r'], () => {
      if (this.modalActive) return;
      this.resolutionIndex = (this.resolutionIndex + 1) % RESOLUTIONS.length;
      this.lastBarFetch = 0;
      this.addLog(`Chart resolution: ${RESOLUTIONS[this.resolutionIndex]}`);
    });
    this.screen.key(['s'], () => {
      if (this.modalActive) return;
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
      if (this.modalActive) return;
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
      if (this.modalActive) return;
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

    // ─── New modal-driven keybindings (additive) ──────────
    this.screen.key(['?'], () => {
      if (this.modalActive) return;
      void this.openHelpOverlay();
    });
    this.screen.key(['S'], () => {
      if (this.modalActive) return;
      void this.openStrategyPicker();
    });
    this.screen.key(['e'], () => {
      if (this.modalActive) return;
      void this.openStrategyEditor();
    });
    this.screen.key(['o'], () => {
      if (this.modalActive) return;
      void this.openManualOrderModal();
    });
    this.screen.key(['f'], () => {
      if (this.modalActive) return;
      void this.openFlattenConfirm();
    });
    this.screen.key(['C'], () => {
      if (this.modalActive) return;
      void this.openCancelAllConfirm();
    });
    this.screen.key(['P'], () => {
      if (this.modalActive) return;
      void this.toggleMarketPause();
    });
    this.screen.key(['O'], () => {
      if (this.modalActive) return;
      void this.openCancelOrderPicker();
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
      this.lastWsError = `${mId}: ${err.message}`;
    });

    // ─── WS health tracking ───────────────────────────────
    if (this.wsClient) {
      this.wsClient.on('disconnected', () => {
        this.wsReconnectCount += 1;
      });
      this.wsClient.on('error', (err: Error) => {
        this.lastWsError = err.message;
      });
    }

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

    // Append health strip onto line 2 — connection state, reconnect count,
    // last error abbreviated. Counts come from local tracking; if not
    // populated they show as `—`.
    const wsState = this.wsClient
      ? (this.wsClient.isConnected ? tc(T.buy, 'OK') : tc(T.sell, 'DOWN'))
      : tc(T.dim, '—');
    const reconnects = this.wsReconnectCount > 0
      ? tc(T.warn, String(this.wsReconnectCount))
      : tc(T.dim, '0');
    const errStr = this.lastWsError
      ? tc(T.sell, this.lastWsError.slice(0, 32))
      : tc(T.dim, '—');
    const healthStrip = `${tc(T.muted, 'WS:')}${wsState} ${tc(T.muted, 'rc:')}${reconnects} ${tc(T.muted, 'err:')}${errStr}`;
    line2 += `  ${tc(T.dim, VLINE)}  ${healthStrip}`;

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
        const ot = cfg.orderConfig.orderType === 'Spot'
          ? 'Limit'
          : cfg.orderConfig.orderType === 'BoundedMarket'
            ? 'Bounded'
            : cfg.orderConfig.orderType;
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

    // Open Orders — detailed table (up to 10) with id/side/price/qty/fill%/age/dist
    if (this.openOrders.length > 0) {
      const qScale = 10 ** market.quote.decimals;
      const bScale = 10 ** market.base.decimals;
      content += `\n${tcB(T.accent, `${TRI} Open Orders (${this.openOrders.length})`)}\n`;
      // Header row
      content += `  ${tc(T.muted, 'ID    ')} ${tc(T.muted, 'Side')} ${tc(T.muted, 'Price'.padStart(10))} ${tc(T.muted, 'Qty'.padStart(8))} ${tc(T.muted, 'Fill%')} ${tc(T.muted, 'Age'.padStart(6))} ${tc(T.muted, 'Δmid%')}\n`;
      const mid = midPrice;
      const visible = this.openOrders.slice(0, 10);
      for (let i = 0; i < visible.length; i++) {
        const o = visible[i];
        const idShort = (o.order_id || '').slice(0, 6).padEnd(6);
        const side = o.side === 'Buy' ? tcB(T.buy, 'BUY ') : tcB(T.sell, 'SELL');
        const priceN = parseFloat(o.price) / qScale;
        const qtyN = parseFloat(o.quantity) / bScale;
        const fillN = parseFloat(o.quantity_fill || '0') / bScale;
        const fillPct = qtyN > 0 ? Math.min(100, Math.round((fillN / qtyN) * 100)) : 0;
        const ageMs = Math.max(0, Date.now() - (o.created_at || Date.now()));
        const ageMin = Math.floor(ageMs / 60000);
        const ageSec = Math.floor((ageMs % 60000) / 1000);
        const ageStr = `${ageMin}m${ageSec}s`;
        const distPct = mid > 0 ? ((priceN - mid) / mid) * 100 : 0;
        const distStr = `${distPct >= 0 ? '+' : ''}${distPct.toFixed(2)}%`;
        const rowFg = i % 2 === 0 ? T.fg : T.muted;
        content += `  ${tc(rowFg, idShort)} ${side} ${tc(rowFg, fmtPrice(priceN).padStart(10))} ${tc(rowFg, fmtQty(qtyN).padStart(8))} ${tc(rowFg, String(fillPct).padStart(4) + '%')} ${tc(rowFg, ageStr.padStart(6))} ${tc(distPct >= 0 ? T.buy : T.sell, distStr.padStart(7))}\n`;
      }
      if (this.openOrders.length > 10) {
        content += `  ${tc(T.accent, `+${this.openOrders.length - 10} more`)}\n`;
      }
    } else {
      // Fallback: keep the empty-state line so the panel never collapses
      content += `\n${tc(T.muted, `${TRI} No open orders`)}\n`;
    }

    // Strategy state strip — compact summary always rendered
    const stratCfg = this.engine.getStrategyConfig(mId);
    if (stratCfg) {
      const presetName = stratCfg.name || 'Custom';
      const sl = stratCfg.riskManagement.stopLossEnabled ? 'on' : 'off';
      const stripParts = [
        `${tc(T.muted, 'Mode:')} ${tc(T.accent, presetName)}`,
        `${tc(T.muted, 'Spread<=')} ${tc(T.fg, `${stratCfg.orderConfig.maxSpreadPercent}%`)}`,
        `${tc(T.muted, 'Off<=')} ${tc(T.fg, `${stratCfg.orderConfig.priceOffsetPercent}%`)}`,
        `${tc(T.muted, 'Size:')} ${tc(T.fg, `${stratCfg.positionSizing.quoteBalancePercentage}%Q/${stratCfg.positionSizing.baseBalancePercentage}%B`)}`,
        `${tc(T.muted, 'Open<=')} ${tc(T.fg, String(stratCfg.orderManagement.maxOpenOrders))}`,
        `${tc(T.muted, 'TP<=')} ${tc(T.fg, `${stratCfg.riskManagement.takeProfitPercent}%`)}`,
        `${tc(T.muted, 'SL:')} ${tc(stratCfg.riskManagement.stopLossEnabled ? T.warn : T.dim, sl)}`,
      ];
      content += `\n${tcB(T.accent, `${TRI} State`)}\n  ${stripParts.join(tc(T.dim, ' | '))}\n`;

      // Last skip — pull from engine.getLastExecutionResult if available.
      // TODO(wave3-wiring): typed once engine wave lands
      const lastResult = (this.engine as any).getLastExecutionResult?.(mId) as
        | { skipReason?: string; skipCategory?: string }
        | undefined;
      if (lastResult?.skipReason) {
        const cat = lastResult.skipCategory || 'other';
        content += `  ${tc(T.muted, 'Last skip:')} ${tc(T.warn, cat)} ${tc(T.dim, lastResult.skipReason.slice(0, 60))}\n`;
      }
    }

    // Local pause overlay indicator
    if (this.localPausedMarkets.has(mId)) {
      content += `  ${tc(T.warn, '⏸ Market paused (local)')}\n`;
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
        const rawType = o.order_type || 'BoundedMarket';
        const orderType = (rawType === 'BoundedMarket' ? 'Bounded' : rawType).padEnd(7);
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

  // ─── Modal handlers ───────────────────────────────────
  private async withModal<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (!this.screen) return undefined;
    this.modalDepth += 1;
    try {
      return await fn();
    } finally {
      this.modalDepth = Math.max(0, this.modalDepth - 1);
      this.screen?.render();
    }
  }

  private async openHelpOverlay(): Promise<void> {
    if (!this.screen) return;
    const sections: HelpSection[] = [
      {
        title: 'Navigation',
        entries: [
          { key: '[', description: 'Previous market' },
          { key: ']', description: 'Next market' },
          { key: 'r', description: 'Cycle chart resolution' },
          { key: 'h', description: 'Toggle Activity ↔ Trade History' },
        ],
      },
      {
        title: 'Trading',
        entries: [
          { key: 's', description: 'Cycle preset (all markets)' },
          { key: 'S', description: 'Strategy picker (current market)' },
          { key: 'e', description: 'Edit strategy parameters' },
          { key: 'o', description: 'Place manual order' },
          { key: 'c', description: 'Cancel all orders (immediate)' },
          { key: 'C', description: 'Cancel all orders (confirm)' },
          { key: 'O', description: 'Cancel a single order (picker)' },
          { key: 'f', description: 'Flatten position (cancel + sell)' },
        ],
      },
      {
        title: 'View',
        entries: [
          { key: '?', description: 'This help overlay' },
        ],
      },
      {
        title: 'System',
        entries: [
          { key: 'p', description: 'Pause / resume bot (global)' },
          { key: 'P', description: 'Pause / resume current market only' },
          { key: 'q', description: 'Quit' },
          { key: 'Ctrl-C', description: 'Quit' },
        ],
      },
    ];
    await this.withModal(() => showHelpOverlay(this.screen!, sections));
  }

  private async openStrategyPicker(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market) return;

    const items = STRATEGY_PRESETS.map((p) => ({
      label: STRATEGY_PRESET_LABELS[p],
      value: p,
      hint: STRATEGY_PRESET_DESCRIPTIONS[p],
    }));
    const currentIdx = this.currentPresetIndex;
    const picked = await this.withModal(() =>
      showPickerModal<StrategyPreset>(this.screen!, {
        title: `Strategy preset — ${market.base.symbol}/${market.quote.symbol}`,
        items,
        initialIndex: currentIdx,
      })
    );
    if (!picked) return;

    // TODO(wave3-wiring): typed once engine wave lands
    const setPreset = (this.engine as any).setStrategyPreset as
      | ((preset: StrategyPreset, marketId?: string) => void)
      | undefined;
    if (typeof setPreset === 'function') {
      setPreset.call(this.engine, picked, market.market_id);
    } else {
      const newConfig = getPresetStrategyConfig(market.market_id, picked);
      this.engine.updateConfig(market.market_id, newConfig);
    }
    this.addLog(`{cyan-fg}Strategy switched to: ${STRATEGY_PRESET_LABELS[picked]} for ${market.base.symbol}/${market.quote.symbol}{/cyan-fg}`);
  }

  private async openStrategyEditor(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market) return;
    const cfg = this.engine.getStrategyConfig(market.market_id);
    if (!cfg) {
      this.addLog('{yellow-fg}No strategy config available for editing.{/yellow-fg}');
      return;
    }

    const fields: Array<FormField<string>> = [
      { key: 'priceOffsetPercent', label: 'Price offset %', initial: String(cfg.orderConfig.priceOffsetPercent ?? 0), type: 'number', helper: 'e.g. 0.05' },
      { key: 'maxSpreadPercent', label: 'Max spread %', initial: String(cfg.orderConfig.maxSpreadPercent ?? 0), type: 'number', helper: '0–100' },
      { key: 'baseBalancePercentage', label: 'Base balance %', initial: String(cfg.positionSizing.baseBalancePercentage ?? 100), type: 'number', helper: '0–100' },
      { key: 'quoteBalancePercentage', label: 'Quote balance %', initial: String(cfg.positionSizing.quoteBalancePercentage ?? 100), type: 'number', helper: '0–100' },
      { key: 'minOrderSizeUsd', label: 'Min order size USD', initial: String(cfg.positionSizing.minOrderSizeUsd ?? 5), type: 'number' },
      { key: 'maxOrderSizeUsd', label: 'Max order size USD', initial: cfg.positionSizing.maxOrderSizeUsd != null ? String(cfg.positionSizing.maxOrderSizeUsd) : '', type: 'number', helper: 'blank = no cap' },
      { key: 'maxOpenOrders', label: 'Max open orders', initial: String(cfg.orderManagement.maxOpenOrders ?? 2), type: 'number' },
      { key: 'takeProfitPercent', label: 'Take profit %', initial: String(cfg.riskManagement.takeProfitPercent ?? 0), type: 'number' },
    ];
    if (cfg.riskManagement.stopLossEnabled) {
      fields.push({ key: 'stopLossPercent', label: 'Stop loss %', initial: String(cfg.riskManagement.stopLossPercent ?? 0), type: 'number' });
    }
    fields.push(
      { key: 'cycleIntervalMinMs', label: 'Cycle interval min ms', initial: String(cfg.timing.cycleIntervalMinMs ?? 3000), type: 'number' },
      { key: 'cycleIntervalMaxMs', label: 'Cycle interval max ms', initial: String(cfg.timing.cycleIntervalMaxMs ?? 5000), type: 'number' },
    );

    const validate = (values: Record<string, string>): string | null => {
      const numKeys = ['priceOffsetPercent', 'maxSpreadPercent', 'baseBalancePercentage', 'quoteBalancePercentage', 'minOrderSizeUsd', 'maxOpenOrders', 'takeProfitPercent', 'stopLossPercent', 'cycleIntervalMinMs', 'cycleIntervalMaxMs'];
      for (const k of numKeys) {
        if (!(k in values)) continue;
        const raw = values[k];
        if (raw === '' || raw === undefined) continue;
        const n = Number(raw);
        if (!isFinite(n)) return `${k}: not a number`;
        if (n < 0) return `${k}: must be >= 0`;
      }
      const pctKeys = ['maxSpreadPercent', 'baseBalancePercentage', 'quoteBalancePercentage', 'takeProfitPercent', 'stopLossPercent'];
      for (const k of pctKeys) {
        if (!(k in values)) continue;
        const raw = values[k];
        if (raw === '' || raw === undefined) continue;
        const n = Number(raw);
        if (n < 0 || n > 100) return `${k}: must be 0–100`;
      }
      // size > 0 sanity check on min order size and intervals
      const min = Number(values.cycleIntervalMinMs);
      const max = Number(values.cycleIntervalMaxMs);
      if (isFinite(min) && isFinite(max) && max < min) return 'cycleIntervalMaxMs must be >= cycleIntervalMinMs';
      const minSize = Number(values.minOrderSizeUsd);
      if (isFinite(minSize) && minSize <= 0) return 'minOrderSizeUsd: must be > 0';
      return null;
    };

    const result = await this.withModal(() =>
      showFormModal<Record<string, string>>(this.screen!, {
        title: `Edit strategy — ${market.base.symbol}/${market.quote.symbol}`,
        fields,
        validate,
      })
    );
    if (!result) return;

    // Build new config preserving runtime state and unmodified fields
    const newCfg: StrategyConfig = {
      ...cfg,
      orderConfig: {
        ...cfg.orderConfig,
        priceOffsetPercent: Number(result.priceOffsetPercent),
        maxSpreadPercent: Number(result.maxSpreadPercent),
      },
      positionSizing: {
        ...cfg.positionSizing,
        baseBalancePercentage: Number(result.baseBalancePercentage),
        quoteBalancePercentage: Number(result.quoteBalancePercentage),
        minOrderSizeUsd: Number(result.minOrderSizeUsd),
        maxOrderSizeUsd: result.maxOrderSizeUsd === '' ? undefined : Number(result.maxOrderSizeUsd),
      },
      orderManagement: {
        ...cfg.orderManagement,
        maxOpenOrders: Number(result.maxOpenOrders),
      },
      riskManagement: {
        ...cfg.riskManagement,
        takeProfitPercent: Number(result.takeProfitPercent),
        stopLossPercent: result.stopLossPercent !== undefined && result.stopLossPercent !== ''
          ? Number(result.stopLossPercent)
          : cfg.riskManagement.stopLossPercent,
      },
      timing: {
        cycleIntervalMinMs: Number(result.cycleIntervalMinMs),
        cycleIntervalMaxMs: Number(result.cycleIntervalMaxMs),
      },
      updatedAt: Date.now(),
    };
    this.engine.updateConfig(market.market_id, newCfg);
    this.addLog(`{green-fg}Strategy config updated for ${market.base.symbol}/${market.quote.symbol}{/green-fg}`);
  }

  private async openManualOrderModal(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market || !this.orderManager) {
      this.addLog('{yellow-fg}Order manager unavailable.{/yellow-fg}');
      return;
    }

    // Gather live context for the rich order ticket
    const mId = market.market_id;
    const baseAvail = this.balanceTracker.getBaseBalanceHuman(mId) || 0;
    const quoteAvail = this.balanceTracker.getQuoteBalanceHuman(mId) || 0;
    const bestBid = this.marketData.getBestBid(mId);
    const bestAsk = this.marketData.getBestAsk(mId);
    const midPrice = this.marketData.getMidPrice(mId);
    const spread = this.marketData.getSpreadPercent(mId);
    // O2 fees are stored as a fraction over 1_000_000; convert to percent for display
    const makerFeePct = (parseFloat(market.maker_fee) / 1_000_000) * 100;
    const takerFeePct = (parseFloat(market.taker_fee) / 1_000_000) * 100;
    const minOrderUsd = parseFloat(market.min_order || '0') || 0;

    const result = await this.withModal(() =>
      showOrderEntryModal(this.screen!, {
        pair: `${market.base.symbol}/${market.quote.symbol}`,
        baseSymbol: market.base.symbol,
        quoteSymbol: market.quote.symbol,
        baseAvail,
        quoteAvail,
        midPrice,
        bestBid,
        bestAsk,
        spreadPercent: spread,
        makerFeePercent: makerFeePct,
        takerFeePercent: takerFeePct,
        minOrderUsd,
      })
    );
    if (!result) return;

    // Map the modal's order-type to what OrderManager.placeOrder() accepts.
    // (order-manager already handles the Spot/Market/PostOnly/IOC/FOK aliasing.)
    const apiOrderType = result.orderType === 'Limit' ? 'Spot' : (result.orderType as OrderEntryType);

    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;
    const qtyScaled = String(Math.floor(result.quantityHuman * baseScale));
    const priceScaled = result.priceHuman > 0 ? String(Math.floor(result.priceHuman * priceScale)) : '0';

    const priceTag = result.priceHuman > 0 ? `$${result.priceHuman}` : 'MARKET';
    const summary = `${result.side} ${result.quantityHuman} ${market.base.symbol} @ ${priceTag} (${result.orderType})`;

    this.addLog(`{cyan-fg}Submitting ${summary}...{/cyan-fg}`);
    try {
      await this.orderManager.placeOrder(market, result.side, apiOrderType, priceScaled, qtyScaled);
      this.addLog(`{green-fg}Order submitted: ${summary}{/green-fg}`);
    } catch (err: any) {
      this.addLog(`{red-fg}Order failed: ${err.message}{/red-fg}`);
    }
  }

  private async openFlattenConfirm(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market || !this.orderManager) return;
    const baseHuman = this.balanceTracker.getBaseBalanceHuman(market.market_id);

    const confirmed = await this.withModal(() =>
      showConfirmModal(this.screen!, {
        title: `Flatten ${market.base.symbol}/${market.quote.symbol}`,
        message: `Cancel all orders and market-sell ${fmtQty(baseHuman)} ${market.base.symbol}?\n\nThis cannot be undone.`,
        confirmLabel: 'Flatten',
      })
    );
    if (!confirmed) return;

    this.addLog(`{yellow-fg}Flattening ${market.base.symbol}/${market.quote.symbol}...{/yellow-fg}`);
    // TODO(wave3-wiring): typed once engine wave lands
    const flatten = (this.orderManager as any).flattenPosition as
      | ((marketId: string) => Promise<void>)
      | undefined;
    try {
      if (typeof flatten === 'function') {
        await flatten.call(this.orderManager, market.market_id);
      } else {
        await this.engine.cancelAllOrders();
        if (baseHuman > 0) {
          const baseScale = 10 ** market.base.decimals;
          const qtyScaled = String(Math.floor(baseHuman * baseScale));
          await this.orderManager.placeOrder(market, 'Sell', 'BoundedMarket', '0', qtyScaled);
        }
      }
      this.addLog(`{green-fg}Flatten complete{/green-fg}`);
    } catch (err: any) {
      this.addLog(`{red-fg}Flatten failed: ${err.message}{/red-fg}`);
    }
  }

  private async openCancelAllConfirm(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market || !this.orderManager) return;

    const confirmed = await this.withModal(() =>
      showConfirmModal(this.screen!, {
        title: 'Cancel all orders',
        message: `Cancel all open orders for ${market.base.symbol}/${market.quote.symbol}?`,
      })
    );
    if (!confirmed) return;

    this.addLog('{yellow-fg}Cancelling all open orders...{/yellow-fg}');
    try {
      await this.orderManager.cancelAllOrders(market);
      this.addLog('{green-fg}All open orders cancelled{/green-fg}');
    } catch (err: any) {
      this.addLog(`{red-fg}Cancel failed: ${err.message}{/red-fg}`);
    }
  }

  private async toggleMarketPause(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market) return;
    const mId = market.market_id;
    const pair = `${market.base.symbol}/${market.quote.symbol}`;

    // TODO(wave3-wiring): typed once engine wave lands
    const eng = this.engine as any;
    const isPausedFn = eng.isMarketPaused as ((id: string) => boolean) | undefined;
    const pauseFn = eng.pauseMarket as ((id: string) => void) | undefined;
    const resumeFn = eng.resumeMarket as ((id: string) => void) | undefined;

    let nowPaused: boolean;
    if (typeof pauseFn === 'function' && typeof resumeFn === 'function') {
      const wasPaused = typeof isPausedFn === 'function'
        ? isPausedFn.call(this.engine, mId)
        : this.localPausedMarkets.has(mId);
      if (wasPaused) {
        resumeFn.call(this.engine, mId);
        this.localPausedMarkets.delete(mId);
        nowPaused = false;
      } else {
        pauseFn.call(this.engine, mId);
        this.localPausedMarkets.add(mId);
        nowPaused = true;
      }
    } else {
      // Local-only fallback: flip the overlay flag and toggle the
      // strategy's isActive flag on the engine so the scheduler skips it.
      const cfg = this.engine.getStrategyConfig(mId);
      if (!cfg) {
        this.addLog(`{yellow-fg}No config for ${pair}.{/yellow-fg}`);
        return;
      }
      const wasPaused = this.localPausedMarkets.has(mId);
      const updated: StrategyConfig = { ...cfg, isActive: !wasPaused ? false : true, updatedAt: Date.now() };
      this.engine.updateConfig(mId, updated);
      if (wasPaused) {
        this.localPausedMarkets.delete(mId);
        nowPaused = false;
      } else {
        this.localPausedMarkets.add(mId);
        nowPaused = true;
      }
    }
    this.addLog(nowPaused
      ? `{yellow-fg}Paused ${pair}{/yellow-fg}`
      : `{green-fg}Resumed ${pair}{/green-fg}`);
  }

  private async openCancelOrderPicker(): Promise<void> {
    if (!this.screen) return;
    const market = this.currentMarket;
    if (!market || !this.orderManager) return;

    if (this.openOrders.length === 0) {
      this.addLog(`{yellow-fg}No open orders to cancel.{/yellow-fg}`);
      return;
    }
    const qScale = 10 ** market.quote.decimals;
    const bScale = 10 ** market.base.decimals;
    const items = this.openOrders.map((o) => {
      const idShort = (o.order_id || '').slice(0, 8);
      const priceN = parseFloat(o.price) / qScale;
      const qtyN = parseFloat(o.quantity) / bScale;
      const ageMs = Math.max(0, Date.now() - (o.created_at || Date.now()));
      const ageMin = Math.floor(ageMs / 60000);
      const ageSec = Math.floor((ageMs % 60000) / 1000);
      return {
        label: `${idShort}  ${o.side.padEnd(4)}  ${fmtPrice(priceN).padStart(10)}  ${fmtQty(qtyN).padStart(8)}  ${ageMin}m${ageSec}s`,
        value: o.order_id,
      };
    });

    const picked = await this.withModal(() =>
      showPickerModal<string>(this.screen!, {
        title: `Cancel order — ${market.base.symbol}/${market.quote.symbol}`,
        items,
      })
    );
    if (!picked) return;

    const confirmed = await this.withModal(() =>
      showConfirmModal(this.screen!, {
        title: 'Confirm cancel',
        message: `Cancel order ${picked.slice(0, 12)}?`,
      })
    );
    if (!confirmed) return;

    this.addLog(`{yellow-fg}Cancelling order ${picked.slice(0, 12)}...{/yellow-fg}`);
    try {
      await this.orderManager.cancelOrder(picked, market);
      this.addLog(`{green-fg}Order cancelled{/green-fg}`);
    } catch (err: any) {
      this.addLog(`{red-fg}Cancel failed: ${err.message}{/red-fg}`);
    }
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
