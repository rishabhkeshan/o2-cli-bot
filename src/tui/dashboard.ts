import blessed from 'blessed';
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
import type { StrategyPreset } from '../types/strategy.js';
import { getPresetStrategyConfig, STRATEGY_PRESET_LABELS } from '../types/strategy.js';
import * as dbQueries from '../db/queries.js';

const RESOLUTIONS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
const STRATEGY_PRESETS: StrategyPreset[] = ['simple', 'volumeMaximizing', 'profitTaking'];

// ─── Smart number formatting ────────────────────────────────
// Auto-detects needed decimal places based on magnitude
function fmtPrice(n: number): string {
  if (n === 0 || !isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 10000) return n.toFixed(2);
  if (abs >= 100) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.01) return n.toFixed(4);
  if (abs >= 0.0001) return n.toFixed(6);
  // For very small prices, show enough significant digits
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

export class Dashboard {
  private screen: blessed.Widgets.Screen | null = null;
  private headerBox: blessed.Widgets.BoxElement | null = null;
  private chartBox: blessed.Widgets.BoxElement | null = null;
  private orderbookBox: blessed.Widgets.BoxElement | null = null;
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
  private competitionStats: { rank: string; score: string; volume: string; pnl: string; title: string } | null = null;
  private lastCompetitionFetch = 0;

  constructor(opts: {
    engine: TradingEngine;
    pnlCalc: PnLCalculator;
    marketData: MarketDataService;
    balanceTracker: BalanceTracker;
    restClient: O2RestClient;
    orderManager?: OrderManager;
    wsClient?: O2WebSocketClient;
    logger: Logger;
    noTui?: boolean;
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
    this.noTui = opts.noTui || false;
    this.onQuit = opts.onQuit;
    this.markets = opts.markets || this.marketData.getAllMarkets();
    this.ownerAddress = opts.ownerAddress || '';
    this.tradeAccountId = opts.tradeAccountId || '';
    this.sessionExpiry = opts.sessionExpiry || 0;

    // Detect initial strategy preset from engine context
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
          if (order.success) console.log(`[${order.side}] ${order.quantityHuman} @ ${order.priceHuman} (${order.marketPair})`);
          else if (order.error) console.error(`[Failed] ${order.error}`);
        }
      } else if (result.skipReason) {
        console.log(`[Skip] ${result.skipReason}`);
      }
    });
    this.engine.on('error', (marketId: string, err: Error) => {
      console.error(`[Error] ${marketId}: ${err.message}`);
    });
  }

  private startTuiMode(): void {
    this.screen = blessed.screen({ smartCSR: true, title: 'O2 CLI Trading Bot', fullUnicode: true });

    this.headerBox = blessed.box({
      top: 0, left: 0, width: '100%', height: 4,
      tags: true, style: { fg: 'white', bg: '#1a1a2e' }, padding: { left: 1 },
    });
    this.chartBox = blessed.box({
      top: 4, left: 0, width: '65%', height: '55%-4',
      label: ' Chart ', border: { type: 'line' }, tags: true,
      style: { border: { fg: '#444' }, fg: 'white' }, padding: { left: 0, right: 0 },
    });
    this.orderbookBox = blessed.box({
      top: 4, left: '65%', width: '35%', height: '55%-4',
      label: ' Order Book ', border: { type: 'line' }, tags: true,
      style: { border: { fg: '#444' }, fg: 'white' }, padding: { left: 0, right: 0 },
    });
    this.balancePnlBox = blessed.box({
      top: '55%', left: 0, width: '35%', height: '45%',
      label: ' Balances & P&L ', border: { type: 'line' }, tags: true,
      style: { border: { fg: '#444' }, fg: 'white' }, padding: { left: 1 },
    });
    this.logBox = blessed.log({
      top: '55%', left: '35%', width: '65%', height: '45%',
      label: ' Activity Log ', border: { type: 'line' }, tags: true,
      scrollable: true, scrollbar: { ch: ' ', style: { bg: 'cyan' } },
      style: { border: { fg: '#444' }, fg: 'white' }, padding: { left: 1 },
    });

    this.historyBox = blessed.box({
      top: '55%', left: '35%', width: '65%', height: '45%',
      label: ' Trade History ', border: { type: 'line' }, tags: true,
      scrollable: true, scrollbar: { ch: ' ', style: { bg: 'cyan' } },
      style: { border: { fg: '#444' }, fg: 'white' }, padding: { left: 1 },
      hidden: true,
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.chartBox);
    this.screen.append(this.orderbookBox);
    this.screen.append(this.balancePnlBox);
    this.screen.append(this.logBox);
    this.screen.append(this.historyBox);

    this.screen.key(['q', 'C-c'], () => { if (this.onQuit) this.onQuit(); });
    this.screen.key(['p'], () => {
      if (this.engine.isRunning) { this.engine.stop(); this.addLog('{yellow-fg}Bot paused{/yellow-fg}'); }
      else { this.engine.start(); this.addLog('{green-fg}Bot resumed{/green-fg}'); }
    });
    this.screen.key(['['], () => {
      if (this.markets.length > 1) {
        this.currentMarketIndex = (this.currentMarketIndex - 1 + this.markets.length) % this.markets.length;
        this.lastBarFetch = 0;
        this.addLog(`Switched to ${this.currentMarket?.base.symbol}/${this.currentMarket?.quote.symbol}`);
      }
    });
    this.screen.key([']'], () => {
      if (this.markets.length > 1) {
        this.currentMarketIndex = (this.currentMarketIndex + 1) % this.markets.length;
        this.lastBarFetch = 0;
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
        this.logBox?.hide();
        this.historyBox?.show();
        this.renderTradeHistory();
      } else {
        this.historyBox?.hide();
        this.logBox?.show();
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

    this.logger.onLog((_level, msg) => this.addLog(msg));
    this.engine.on('cycle', (_mId: string, result: any) => {
      if (result.executed) {
        for (const o of result.orders || []) {
          if (o.success) {
            const c = o.side === 'Buy' ? 'green' : 'red';
            this.addLog(`{${c}-fg}${o.side}{/${c}-fg} ${o.quantityHuman} @ ${o.priceHuman} (${o.marketPair})`);
          } else if (o.error) this.addLog(`{red-fg}Failed: ${o.error}{/red-fg}`);
        }
      } else if (result.skipReason) {
        this.addLog(`{yellow-fg}Skip: ${result.skipReason}{/yellow-fg}`);
      }
    });
    this.engine.on('error', (mId: string, err: Error) => {
      this.addLog(`{red-fg}Error [${mId}]: ${err.message}{/red-fg}`);
    });

    this.updateInterval = setInterval(() => this.render(), 1000);
    this.fetchBars();
    this.render();
    this.screen.render();
  }

  private get currentMarket(): Market | undefined {
    return this.markets[this.currentMarketIndex];
  }

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

  private async fetchCompetitionStats(): Promise<void> {
    if (!this.ownerAddress) return;
    try {
      const competitions = await this.restClient.getCompetitions();
      // Find active competition (not "Hall of Fame", started, not ended)
      const now = Date.now();
      const active = competitions.find((c: any) => {
        const plainTitle = this.stripHtmlTags(c.title || '');
        if (plainTitle.includes('Hall of Fame')) return false;
        const start = new Date(c.startDate).getTime();
        const end = c.endDate ? new Date(c.endDate).getTime() : Infinity;
        return start <= now && end >= now;
      });
      if (!active) { this.competitionStats = null; return; }

      const lb = await this.restClient.getLeaderboard(active.competitionId, this.ownerAddress);
      if (lb?.currentUser) {
        const u = lb.currentUser;
        const rawTitle = lb.title || active.title || 'Competition';
        this.competitionStats = {
          rank: u.rank || '-',
          score: u.score || '0',
          volume: this.fmtBigNum(u.volume),
          pnl: this.fmtBigNum(u.pnl),
          title: this.stripHtmlTags(rawTitle),
        };
      } else {
        this.competitionStats = null;
      }
    } catch {
      // silently ignore
    }
    this.lastCompetitionFetch = Date.now();
  }

  private fmtBigNum(val: string | undefined): string {
    if (!val) return '0';
    // Values come with 9 decimal places
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

  private async render(): Promise<void> {
    if (!this.screen || this.noTui || this.rendering) return;
    this.rendering = true;
    try {
      const market = this.currentMarket;
      if (!market) return;

      if (Date.now() - this.lastBarFetch > 15000) this.fetchBars();
      if (Date.now() - this.lastOrdersFetch > 5000) this.fetchOpenOrders(market);
      if (Date.now() - this.lastCompetitionFetch > 60000) this.fetchCompetitionStats();

      // Use cached data from market data service (updated by polling/WS)
      const ticker = this.marketData.getCachedTicker(market.market_id);
      const book = this.marketData.getCachedOrderBook(market.market_id);

      this.renderHeader(market, ticker);
      this.renderChart(market);
      this.renderOrderbook(market, book, ticker);
      this.renderBalancePnl(market);
      if (this.viewMode === 'history') this.renderTradeHistory();
      this.screen?.render();
    } finally {
      this.rendering = false;
    }
  }

  // ─── Header ────────────────────────────────────────────
  private renderHeader(market: Market, ticker: MarketTicker | null): void {
    if (!this.headerBox) return;
    const pair = `${market.base.symbol}/${market.quote.symbol}`;
    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;

    const priceNum = ticker ? parseFloat(ticker.last_price) / priceScale : 0;
    const price = priceNum > 0 ? fmtPrice(priceNum) : '---';
    const change = ticker?.percentage ? parseFloat(ticker.percentage).toFixed(2) : '0.00';
    const changeColor = parseFloat(change) >= 0 ? 'green' : 'red';
    const highNum = ticker?.high ? parseFloat(ticker.high) / priceScale : 0;
    const lowNum = ticker?.low ? parseFloat(ticker.low) / priceScale : 0;
    const high = highNum > 0 ? fmtPrice(highNum) : '---';
    const low = lowNum > 0 ? fmtPrice(lowNum) : '---';
    const volNum = ticker?.base_volume ? parseFloat(ticker.base_volume) / baseScale : 0;
    const vol = volNum > 0 ? fmtVol(volNum, market.base.symbol) : '---';
    const uptime = this.formatUptime(Date.now() - this.startTime);
    const status = this.engine.isRunning ? '{green-fg}RUNNING{/green-fg}' : '{yellow-fg}PAUSED{/yellow-fg}';
    const res = RESOLUTIONS[this.resolutionIndex];

    const marketNav = this.markets.length > 1
      ? ` {cyan-fg}(${this.currentMarketIndex + 1}/${this.markets.length}){/cyan-fg} [◀/▶]`
      : '';

    const stratLabel = STRATEGY_PRESET_LABELS[STRATEGY_PRESETS[this.currentPresetIndex]];

    const wsStatus = this.wsClient?.isConnected ? '{green-fg}WS{/green-fg}' : '{red-fg}WS{/red-fg}';
    let sessionStr = '';
    if (this.sessionExpiry > 0) {
      const remainMs = this.sessionExpiry * 1000 - Date.now();
      if (remainMs > 0) {
        const days = Math.floor(remainMs / 86400000);
        const hrs = Math.floor((remainMs % 86400000) / 3600000);
        sessionStr = days > 0 ? ` Sess:${days}d${hrs}h` : ` Sess:${hrs}h`;
      } else {
        sessionStr = ' {red-fg}Sess:EXP{/red-fg}';
      }
    }
    const acctStr = this.tradeAccountId ? ` Acct:${this.tradeAccountId.slice(0, 8)}..` : '';
    const histKey = this.viewMode === 'history' ? '{cyan-fg}[h]ist{/cyan-fg}' : '[h]ist';

    let line1 = `{bold}${pair}{/bold}${marketNav}  $${price}  {${changeColor}-fg}${parseFloat(change) >= 0 ? '+' : ''}${change}%{/${changeColor}-fg}  ` +
      `H:$${high}  L:$${low}  Vol:${vol}  |  ` +
      `${status} ${wsStatus}${sessionStr}${acctStr}  ${uptime}\n` +
      `[q]uit [p]ause [r]es:${res} [s]:${stratLabel} ${histKey} [c]ancel` +
      (this.markets.length > 1 ? ' [[]prev []]next' : '');

    if (this.competitionStats) {
      const c = this.competitionStats;
      const pnlNum = parseFloat(c.pnl) || 0;
      const pnlColor = pnlNum >= 0 ? 'green' : 'red';
      line1 += `\n{bold}{cyan-fg}${c.title}{/cyan-fg}{/bold}  Rank: {bold}#${c.rank}{/bold}  Score: ${c.score}  Vol: $${c.volume}  P&L: {${pnlColor}-fg}$${c.pnl}{/${pnlColor}-fg}`;
    }

    this.headerBox.setContent(line1);
  }

  // ─── Candlestick Chart ─────────────────────────────────
  private renderChart(market: Market): void {
    if (!this.chartBox) return;
    const innerW = (this.chartBox as any).width - 4;
    const innerH = (this.chartBox as any).height - 3;
    if (innerW < 10 || innerH < 5 || this.bars.length === 0) {
      this.chartBox.setContent(' Loading chart...');
      return;
    }

    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;

    // Determine how many decimals we need for Y-axis labels
    const samplePrice = this.bars.length > 0 ? parseFloat(this.bars[0].close) / priceScale : 0;
    const yLabelW = Math.max(10, fmtPrice(samplePrice).length + 2);
    const chartW = Math.max(1, innerW - yLabelW - 1);
    const chartH = Math.max(3, innerH - 2);

    const maxCandles = Math.floor(chartW / 2);
    const visibleBars = this.bars.slice(-maxCandles);
    if (visibleBars.length === 0) { this.chartBox.setContent(' No bar data'); return; }

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

    const grid: string[][] = [];
    for (let r = 0; r < chartH; r++) grid[r] = new Array(chartW).fill(' ');

    for (let i = 0; i < visibleBars.length; i++) {
      const b = visibleBars[i];
      const o = parseFloat(b.open) / priceScale;
      const c = parseFloat(b.close) / priceScale;
      const hi = parseFloat(b.high) / priceScale;
      const lo = parseFloat(b.low) / priceScale;
      const col = i * 2;
      if (col >= chartW) break;

      const bullish = c >= o;
      const bodyTop = priceToRow(Math.max(o, c));
      const bodyBot = priceToRow(Math.min(o, c));
      const wickTop = priceToRow(hi);
      const wickBot = priceToRow(lo);
      const color = bullish ? 'green' : 'red';

      for (let r = wickTop; r <= wickBot; r++) {
        if (r >= 0 && r < chartH) {
          if (r >= bodyTop && r <= bodyBot) {
            grid[r][col] = `{${color}-fg}\u2588{/${color}-fg}`;
          } else {
            grid[r][col] = `{${color}-fg}\u2502{/${color}-fg}`;
          }
        }
      }
      if (bodyTop === bodyBot && bodyTop >= 0 && bodyTop < chartH) {
        grid[bodyTop][col] = `{${color}-fg}\u2501{/${color}-fg}`;
      }
    }

    // Volume bars
    const volBars: string[] = [];
    const vc = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
    for (let i = 0; i < visibleBars.length; i++) {
      const b = visibleBars[i];
      const v = (parseFloat(b.buy_volume) + parseFloat(b.sell_volume)) / baseScale;
      const ratio = volMax > 0 ? v / volMax : 0;
      const idx = Math.min(Math.floor(ratio * 8), 7);
      const bullish = parseFloat(b.close) >= parseFloat(b.open);
      const color = bullish ? 'green' : 'red';
      volBars.push(`{${color}-fg}${vc[idx]}{/${color}-fg}`);
      if (i < visibleBars.length - 1) volBars.push(' ');
    }

    // Y-axis labels
    const yLabels: string[] = [];
    const labelStep = Math.max(1, Math.floor(chartH / 5));
    for (let r = 0; r < chartH; r++) {
      if (r % labelStep === 0 || r === chartH - 1) {
        const p = priceMax - (r / (chartH - 1)) * adjustedRange;
        yLabels[r] = fmtPrice(p).padStart(yLabelW);
      } else {
        yLabels[r] = ' '.repeat(yLabelW);
      }
    }

    const res = RESOLUTIONS[this.resolutionIndex];
    let content = ` {bold}${market.base.symbol}/${market.quote.symbol} \u00b7 ${res}{/bold}\n`;
    for (let r = 0; r < chartH; r++) {
      content += `${yLabels[r]}\u2524${grid[r].join('')}\n`;
    }
    content += ' '.repeat(yLabelW) + '\u2514' + '\u2500'.repeat(Math.min(chartW, visibleBars.length * 2)) + '\n';
    content += ' '.repeat(yLabelW + 1) + volBars.join('');

    this.chartBox.setContent(content);
  }

  // ─── Orderbook ─────────────────────────────────────────
  private renderOrderbook(market: Market, book: OrderBookDepth | null, ticker: MarketTicker | null): void {
    if (!this.orderbookBox) return;
    const innerW = (this.orderbookBox as any).width - 4;
    const innerH = (this.orderbookBox as any).height - 3;

    if (!book || (!book.asks.length && !book.bids.length)) {
      this.orderbookBox.setContent(' Loading orderbook...');
      return;
    }

    const priceScale = 10 ** market.quote.decimals;
    const baseScale = 10 ** market.base.decimals;

    // Rows available: header(1) + asks + spread(1) + bids
    const rowsPerSide = Math.max(3, Math.floor((innerH - 2) / 2));

    // Asks: closest to spread (lowest), displayed top=highest
    const rawAsks = book.asks.slice(0, rowsPerSide);
    const rawBids = book.bids.slice(0, rowsPerSide);

    // Parse levels: price in human USD, qty in base tokens, totalUsd = price * qty
    let maxTotalUsd = 0;
    const parseLevel = (raw: [string, string]) => {
      const price = parseFloat(raw[0]) / priceScale;
      const qty = parseFloat(raw[1]) / baseScale;
      const totalUsd = price * qty;
      if (totalUsd > maxTotalUsd) maxTotalUsd = totalUsd;
      return { price, qty, totalUsd };
    };

    const askLevels = rawAsks.map(parseLevel).reverse(); // highest at top
    const bidLevels = rawBids.map(parseLevel);

    // Determine column widths dynamically
    // Format: "  PRICE  QTY_BASE  TOTAL_USD  [BAR]"
    const priceW = Math.max(8, fmtPrice(askLevels[0]?.price || bidLevels[0]?.price || 0).length + 1);
    const qtyW = 10;
    const totalW = 9;
    const barW = Math.max(2, innerW - priceW - qtyW - totalW - 5);

    const depthBar = (totalUsd: number, color: string): string => {
      const len = maxTotalUsd > 0 ? Math.max(0, Math.round((totalUsd / maxTotalUsd) * barW)) : 0;
      if (len === 0) return ' '.repeat(barW);
      return `{${color}-bg}${' '.repeat(len)}{/${color}-bg}${' '.repeat(barW - len)}`;
    };

    let content = '';

    // Header
    content += ` {bold}${'Price'.padStart(priceW)} ${'Amt ' + market.base.symbol} ${'Total ' + market.quote.symbol}{/bold}\n`;

    // Asks (red) — highest at top, lowest near spread
    for (const lvl of askLevels) {
      const bar = depthBar(lvl.totalUsd, 'red');
      content += ` {red-fg}${fmtPrice(lvl.price).padStart(priceW)}{/red-fg} ${fmtQty(lvl.qty).padStart(qtyW)} ${fmtUsd(lvl.totalUsd).padStart(totalW)} ${bar}\n`;
    }

    // Spread
    if (rawBids.length > 0 && rawAsks.length > 0) {
      const bestBid = parseFloat(rawBids[0][0]) / priceScale;
      const bestAsk = parseFloat(rawAsks[0][0]) / priceScale;
      const spread = bestAsk - bestBid;
      const spreadPct = bestBid > 0 ? ((spread / bestBid) * 100) : 0;
      const lastP = ticker ? parseFloat(ticker.last_price) / priceScale : (bestBid + bestAsk) / 2;
      content += ` {bold}{yellow-fg}$${fmtPrice(lastP).padStart(priceW - 1)}  Spread: ${fmtPrice(spread)}  ${spreadPct.toFixed(4)}%{/yellow-fg}{/bold}\n`;
    }

    // Bids (green) — highest near spread
    for (const lvl of bidLevels) {
      const bar = depthBar(lvl.totalUsd, 'green');
      content += ` {green-fg}${fmtPrice(lvl.price).padStart(priceW)}{/green-fg} ${fmtQty(lvl.qty).padStart(qtyW)} ${fmtUsd(lvl.totalUsd).padStart(totalW)} ${bar}\n`;
    }

    this.orderbookBox.setContent(content);
  }

  // ─── Balances & P&L ───────────────────────────────────
  private renderBalancePnl(market: Market): void {
    if (!this.balancePnlBox) return;
    const mId = market.market_id;
    const baseHuman = this.balanceTracker.getBaseBalanceHuman(mId);
    const quoteHuman = this.balanceTracker.getQuoteBalanceHuman(mId);
    const aggPnl = this.pnlCalc.getSnapshot();
    const realColor = aggPnl.realizedPnl >= 0 ? 'green' : 'red';
    const contexts = this.engine.getContexts();
    const ctx = contexts.find(c => c.marketId === mId);

    // Estimate USD value of base balance
    const midPrice = this.marketData.getMidPrice(mId) || 0;
    const baseUsd = baseHuman * midPrice;
    const totalUsd = quoteHuman + baseUsd;

    let content = '';
    content += '{bold} Balances{/bold}\n';
    content += `  ${market.quote.symbol.padEnd(6)} ${quoteHuman.toFixed(2).padStart(12)} ${market.quote.symbol}\n`;
    content += `  ${market.base.symbol.padEnd(6)} ${fmtQty(baseHuman).padStart(12)} ${market.base.symbol}\n`;
    if (baseUsd > 0) {
      content += `  Total  ${fmtUsd(totalUsd).padStart(12)}\n`;
    }
    // Unrealized P&L: (currentPrice - avgBuyPrice) * baseBalance
    let unrealizedPnl = 0;
    if (aggPnl.averageBuyPrice > 0 && baseHuman > 0 && midPrice > 0) {
      unrealizedPnl = (midPrice - aggPnl.averageBuyPrice) * baseHuman;
    }
    const unrColor = unrealizedPnl >= 0 ? 'green' : 'red';
    const totalPnl = aggPnl.realizedPnl + unrealizedPnl;
    const totalColor = totalPnl >= 0 ? 'green' : 'red';

    content += '\n{bold} Session P&L{/bold}\n';
    content += `  Realized  {${realColor}-fg}$${aggPnl.realizedPnl.toFixed(4)}{/${realColor}-fg}\n`;
    if (baseHuman > 0 && aggPnl.averageBuyPrice > 0) {
      content += `  Unreal.   {${unrColor}-fg}$${unrealizedPnl.toFixed(4)}{/${unrColor}-fg}\n`;
      content += `  Total     {${totalColor}-fg}$${totalPnl.toFixed(4)}{/${totalColor}-fg}\n`;
    }
    content += `  Volume    $${aggPnl.totalVolume.toFixed(2)}\n`;
    content += `  Fees      $${aggPnl.totalFees.toFixed(4)}\n`;
    content += `  Trades    ${aggPnl.tradeCount} (${aggPnl.buyCount}B/${aggPnl.sellCount}S)\n`;
    if (aggPnl.averageBuyPrice > 0) content += `  Avg Buy   $${fmtPrice(aggPnl.averageBuyPrice)}\n`;
    if (aggPnl.averageSellPrice > 0) content += `  Avg Sell  $${fmtPrice(aggPnl.averageSellPrice)}\n`;
    if (ctx) {
      const cfg = this.engine.getStrategyConfig(mId);
      content += `\n{bold} Strategy{/bold}\n`;
      content += `  ${ctx.strategy} ${ctx.isActive ? '{green-fg}ON{/green-fg}' : '{red-fg}OFF{/red-fg}'}\n`;
      if (cfg) {
        const ot = cfg.orderConfig.orderType === 'Spot' ? 'Limit' : 'Market';
        const pm = cfg.orderConfig.priceMode;
        const side = cfg.orderConfig.side;
        content += `  ${ot} | ${pm} | ${side}\n`;
        // Sizing
        if (cfg.positionSizing.sizeMode === 'fixedUsd') {
          content += `  Size: $${cfg.positionSizing.fixedUsdAmount || 0} fixed`;
        } else {
          content += `  Size: ${cfg.positionSizing.quoteBalancePercentage}%Q/${cfg.positionSizing.baseBalancePercentage}%B`;
        }
        if (cfg.positionSizing.maxOrderSizeUsd) content += ` (max $${cfg.positionSizing.maxOrderSizeUsd})`;
        content += '\n';
        // Profit protection
        if (cfg.orderManagement.onlySellAboveBuyPrice) {
          content += `  {cyan-fg}Sell>Buy{/cyan-fg} TP:${cfg.riskManagement.takeProfitPercent}%`;
          if (cfg.averageBuyPrice && cfg.averageBuyPrice !== '0') {
            content += ` AvgBuy:$${fmtPrice(parseFloat(cfg.averageBuyPrice))}`;
          }
          content += '\n';
        }
        // Risk
        if (cfg.riskManagement.stopLossEnabled) content += `  SL:${cfg.riskManagement.stopLossPercent}% `;
        if (cfg.riskManagement.orderTimeoutEnabled) content += `  Timeout:${cfg.riskManagement.orderTimeoutMinutes}m`;
        if (cfg.riskManagement.stopLossEnabled || cfg.riskManagement.orderTimeoutEnabled) content += '\n';
        // Timing + next cycle countdown
        const nextRun = this.engine.getNextRunTime(mId);
        const countdown = nextRun ? Math.max(0, Math.ceil((nextRun - Date.now()) / 1000)) : 0;
        content += `  Cycle: ${(cfg.timing.cycleIntervalMinMs / 1000).toFixed(0)}-${(cfg.timing.cycleIntervalMaxMs / 1000).toFixed(0)}s`;
        if (cfg.orderConfig.maxSpreadPercent > 0) content += ` MaxSpread:${cfg.orderConfig.maxSpreadPercent}%`;
        if (countdown > 0) content += `  {yellow-fg}Next:${countdown}s{/yellow-fg}`;
        content += '\n';
      }
    }

    // Open Orders
    if (this.openOrders.length > 0) {
      const qScale = 10 ** market.quote.decimals;
      const bScale = 10 ** market.base.decimals;
      content += `\n{bold} Open Orders (${this.openOrders.length}){/bold}\n`;
      for (const o of this.openOrders.slice(0, 6)) {
        const side = o.side === 'Buy' ? '{green-fg}BUY{/green-fg}' : '{red-fg}SELL{/red-fg}';
        const price = fmtPrice(parseFloat(o.price) / qScale);
        const qty = fmtQty(parseFloat(o.quantity) / bScale);
        content += `  ${side}  ${qty} @ $${price}\n`;
      }
      if (this.openOrders.length > 6) {
        content += `  ... +${this.openOrders.length - 6} more\n`;
      }
    }

    this.balancePnlBox.setContent(content);
  }

  // ─── Trade History ────────────────────────────────────
  private renderTradeHistory(): void {
    if (!this.historyBox) return;
    const market = this.currentMarket;
    if (!market) return;

    const pair = `${market.base.symbol}/${market.quote.symbol}`;
    const trades = dbQueries.getRecentTrades(market.market_id, 40);

    let content = `{bold} ${pair} — Fills (${trades.length}){/bold}\n`;
    content += ` ${'Time'.padEnd(10)} ${'Side'.padEnd(5)} ${'Price'.padEnd(13)} ${'Qty'.padEnd(11)} ${'Value'.padEnd(10)} ${'Fee'.padEnd(9)} P&L\n`;
    content += ' ' + '\u2500'.repeat(72) + '\n';

    for (const t of trades) {
      const d = new Date(t.timestamp);
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      const side = t.side === 'Buy'
        ? '{green-fg}BUY {/green-fg}'
        : '{red-fg}SELL{/red-fg}';
      const price = '$' + fmtPrice(t.price);
      const qty = fmtQty(t.size);
      const value = fmtUsd(t.price * t.size);
      const fee = '$' + (t.fee || 0).toFixed(4);
      let pnl = '   -';
      if (t.pnl_usdc != null) {
        pnl = t.pnl_usdc >= 0
          ? `{green-fg}+$${t.pnl_usdc.toFixed(4)}{/green-fg}`
          : `{red-fg}-$${Math.abs(t.pnl_usdc).toFixed(4)}{/red-fg}`;
      }
      content += ` ${time.padEnd(10)} ${side} ${price.padEnd(13)} ${qty.padEnd(11)} ${value.padEnd(10)} ${fee.padEnd(9)} ${pnl}\n`;
    }

    if (trades.length === 0) {
      content += ' No fills recorded yet.\n';
    }

    // Summary stats
    const stats = dbQueries.getTradeStats(market.market_id);
    if (stats.totalTrades > 0) {
      const pnlColor = stats.realizedPnl >= 0 ? 'green' : 'red';
      content += ' ' + '\u2500'.repeat(72) + '\n';
      content += ` Trades: ${stats.totalTrades} (${stats.buyCount}B/${stats.sellCount}S)  `;
      content += `Vol: $${stats.totalVolume.toFixed(2)}  `;
      content += `Fees: $${stats.totalFees.toFixed(4)}  `;
      content += `P&L: {${pnlColor}-fg}$${stats.realizedPnl.toFixed(4)}{/${pnlColor}-fg}\n`;
    }

    // Recent orders section
    const orders = dbQueries.getRecentOrders(market.market_id, 15);
    if (orders.length > 0) {
      const qScale = 10 ** market.quote.decimals;
      const bScale = 10 ** market.base.decimals;
      content += `\n{bold} Recent Orders (${orders.length}){/bold}\n`;
      content += ` ${'Time'.padEnd(10)} ${'Side'.padEnd(5)} ${'Type'.padEnd(7)} ${'Price'.padEnd(13)} ${'Qty'.padEnd(11)} Status\n`;
      content += ' ' + '\u2500'.repeat(60) + '\n';
      for (const o of orders) {
        const d = new Date(o.created_at);
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        const side = o.side === 'Buy'
          ? '{green-fg}BUY {/green-fg}'
          : '{red-fg}SELL{/red-fg}';
        const orderType = (o.order_type || 'Market').padEnd(7);
        const price = '$' + fmtPrice(parseFloat(o.price) / qScale);
        const qty = fmtQty(parseFloat(o.quantity) / bScale);
        let status = o.status;
        switch (o.status) {
          case 'filled': status = '{green-fg}filled{/green-fg}'; break;
          case 'cancelled': status = '{yellow-fg}cancel{/yellow-fg}'; break;
          case 'partially_filled': status = '{cyan-fg}partial{/cyan-fg}'; break;
          case 'open': status = '{white-fg}open{/white-fg}'; break;
        }
        content += ` ${time.padEnd(10)} ${side} ${orderType} ${price.padEnd(13)} ${qty.padEnd(11)} ${status}\n`;
      }
    }

    this.historyBox.setContent(content);
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
