import blessed from 'blessed';

// ─── Theme constants (mirrored from dashboard.ts) ─────────
// Kept local so this module has no cross-imports from the
// dashboard. Update both if the palette changes.
const COLOR = {
  border: '#263248',
  borderActive: '#60C8FF',
  bg: '#0E1220',
  bgHeader: '#0A0E16',
  fg: '#DEE6FA',
  muted: '#6C7896',
  dim: '#3E4A64',
  accent: '#60C8FF',
  accent2: '#FF8CC8',
  buy: '#78F0BE',
  sell: '#FF78AA',
  warn: '#FFC83C',
  gold: '#FFD750',
} as const;

const baseModalStyle = {
  border: { fg: COLOR.borderActive },
  label: { fg: COLOR.accent2, bold: true },
  fg: COLOR.fg,
  bg: COLOR.bg,
};

interface ModalScope {
  cleanup: () => void;
}

/**
 * Common scaffolding for modal display. Captures focus, blocks the screen
 * from rendering hotkeys for the dashboard via the modalActive flag, and
 * tears everything down on close.
 */
function attachShade(screen: blessed.Widgets.Screen): blessed.Widgets.BoxElement {
  const shade = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    style: { bg: 'black' },
    transparent: false,
    tags: false,
  });
  return shade;
}

function centerBox(
  screen: blessed.Widgets.Screen,
  opts: { title: string; width: number | string; height: number | string }
): blessed.Widgets.BoxElement {
  return blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: opts.width,
    height: opts.height,
    label: ` ${opts.title} `,
    border: { type: 'line' },
    tags: true,
    keys: true,
    mouse: false,
    style: baseModalStyle,
    padding: { left: 1, right: 1 },
  });
}

function teardown(scope: ModalScope, screen: blessed.Widgets.Screen, previousFocus: blessed.Widgets.BlessedElement | null): void {
  scope.cleanup();
  if (previousFocus && typeof (previousFocus as any).focus === 'function') {
    try {
      (previousFocus as any).focus();
    } catch {
      // ignore focus errors
    }
  }
  screen.render();
}

// ─── Input modal ──────────────────────────────────────────
export function showInputModal(
  screen: blessed.Widgets.Screen,
  opts: {
    title: string;
    label: string;
    initialValue?: string;
    validate?: (v: string) => string | null;
  }
): Promise<string | null> {
  return new Promise((resolve) => {
    const previousFocus = (screen as any).focused as blessed.Widgets.BlessedElement | null;
    const shade = attachShade(screen);
    const box = centerBox(screen, { title: opts.title, width: 60, height: 9 });

    blessed.text({
      parent: box,
      top: 0,
      left: 0,
      content: opts.label,
      style: { fg: COLOR.fg, bg: COLOR.bg },
      tags: true,
    });

    const input = blessed.textbox({
      parent: box,
      top: 2,
      left: 0,
      width: '100%-2',
      height: 3,
      inputOnFocus: true,
      keys: true,
      mouse: false,
      border: { type: 'line' },
      style: {
        fg: COLOR.fg,
        bg: COLOR.bg,
        border: { fg: COLOR.border },
        focus: { border: { fg: COLOR.accent } },
      },
    });

    const errorLine = blessed.text({
      parent: box,
      top: 5,
      left: 0,
      width: '100%-2',
      height: 1,
      content: '',
      style: { fg: COLOR.sell, bg: COLOR.bg },
      tags: true,
    });

    const hint = blessed.text({
      parent: box,
      bottom: 0,
      left: 0,
      content: '{gray-fg}Enter: submit  Esc: cancel{/gray-fg}',
      style: { fg: COLOR.muted, bg: COLOR.bg },
      tags: true,
    });

    if (opts.initialValue !== undefined) {
      input.setValue(opts.initialValue);
    }

    const scope: ModalScope = {
      cleanup: () => {
        input.removeAllListeners();
        box.detach();
        shade.detach();
        // referenced for typescript no-unused
        void hint;
        void errorLine;
      },
    };

    let finished = false;
    const submit = (): void => {
      if (finished) return;
      const v = input.getValue();
      if (opts.validate) {
        const err = opts.validate(v);
        if (err) {
          errorLine.setContent(`{red-fg}${err}{/red-fg}`);
          screen.render();
          input.focus();
          (input as any).readInput?.(() => undefined);
          return;
        }
      }
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(v);
    };

    const cancel = (): void => {
      if (finished) return;
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(null);
    };

    input.on('submit', submit);
    input.on('cancel', cancel);
    input.key(['escape'], cancel);
    box.key(['escape'], cancel);
    shade.key(['escape'], cancel);

    input.focus();
    (input as any).readInput?.(() => undefined);
    screen.render();
  });
}

// ─── Picker modal ─────────────────────────────────────────
export function showPickerModal<T>(
  screen: blessed.Widgets.Screen,
  opts: {
    title: string;
    items: Array<{ label: string; value: T; hint?: string }>;
    initialIndex?: number;
  }
): Promise<T | null> {
  return new Promise((resolve) => {
    const previousFocus = (screen as any).focused as blessed.Widgets.BlessedElement | null;
    const shade = attachShade(screen);
    const itemCount = Math.max(1, opts.items.length);
    const height = Math.min(20, itemCount + 5);
    const box = centerBox(screen, { title: opts.title, width: 70, height });

    const list = blessed.list({
      parent: box,
      top: 0,
      left: 0,
      width: '100%-2',
      height: height - 4,
      keys: true,
      mouse: false,
      tags: true,
      items: opts.items.map((it) => {
        const labelPart = it.label;
        const hintPart = it.hint ? ` {gray-fg}— ${it.hint}{/gray-fg}` : '';
        return `${labelPart}${hintPart}`;
      }),
      style: {
        fg: COLOR.fg,
        bg: COLOR.bg,
        selected: { bg: COLOR.accent, fg: 'black', bold: true },
        item: { fg: COLOR.fg },
      },
    });

    blessed.text({
      parent: box,
      bottom: 0,
      left: 0,
      content: '{gray-fg}↑/↓: navigate  Enter: select  Esc: cancel{/gray-fg}',
      style: { fg: COLOR.muted, bg: COLOR.bg },
      tags: true,
    });

    if (opts.initialIndex !== undefined && opts.initialIndex >= 0 && opts.initialIndex < opts.items.length) {
      list.select(opts.initialIndex);
    }

    let finished = false;
    const scope: ModalScope = {
      cleanup: () => {
        list.removeAllListeners();
        box.detach();
        shade.detach();
      },
    };

    const submit = (): void => {
      if (finished) return;
      const idx = (list as any).selected as number;
      if (idx < 0 || idx >= opts.items.length) {
        finished = true;
        teardown(scope, screen, previousFocus);
        resolve(null);
        return;
      }
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(opts.items[idx].value);
    };

    const cancel = (): void => {
      if (finished) return;
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(null);
    };

    list.key(['enter'], submit);
    list.key(['escape', 'q'], cancel);
    list.on('select', submit);
    list.focus();
    screen.render();
  });
}

// ─── Confirm modal ────────────────────────────────────────
export function showConfirmModal(
  screen: blessed.Widgets.Screen,
  opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }
): Promise<boolean> {
  return new Promise((resolve) => {
    const previousFocus = (screen as any).focused as blessed.Widgets.BlessedElement | null;
    const shade = attachShade(screen);
    const messageLines = opts.message.split('\n').length;
    const height = Math.max(7, messageLines + 5);
    const box = centerBox(screen, { title: opts.title, width: 60, height });

    blessed.text({
      parent: box,
      top: 0,
      left: 0,
      width: '100%-2',
      height: messageLines,
      content: opts.message,
      style: { fg: COLOR.fg, bg: COLOR.bg },
      tags: true,
    });

    const confirmLabel = opts.confirmLabel || 'Yes';
    const cancelLabel = opts.cancelLabel || 'No';

    blessed.text({
      parent: box,
      bottom: 0,
      left: 0,
      content: `{green-fg}[Y/Enter] ${confirmLabel}{/green-fg}   {red-fg}[N/Esc] ${cancelLabel}{/red-fg}`,
      style: { bg: COLOR.bg },
      tags: true,
    });

    let finished = false;
    const scope: ModalScope = {
      cleanup: () => {
        box.removeAllListeners();
        shade.removeAllListeners();
        box.detach();
        shade.detach();
      },
    };

    const yes = (): void => {
      if (finished) return;
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(true);
    };
    const no = (): void => {
      if (finished) return;
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(false);
    };

    box.key(['y', 'Y', 'enter'], yes);
    box.key(['n', 'N', 'escape'], no);
    box.focus();
    screen.render();
  });
}

// ─── Form modal ───────────────────────────────────────────
export interface FormField<K extends string = string> {
  key: K;
  label: string;
  initial?: string;
  type?: 'text' | 'number' | 'boolean';
  helper?: string;
}

export function showFormModal<T extends Record<string, string>>(
  screen: blessed.Widgets.Screen,
  opts: {
    title: string;
    fields: Array<FormField<keyof T & string>>;
    initial?: Partial<T>;
    validate?: (values: T) => string | null;
  }
): Promise<T | null> {
  return new Promise((resolve) => {
    const previousFocus = (screen as any).focused as blessed.Widgets.BlessedElement | null;
    const shade = attachShade(screen);

    const fieldCount = opts.fields.length;
    const rowHeight = 1; // label + input share row via columns
    const visibleRows = Math.min(14, fieldCount);
    const height = Math.min(28, visibleRows * 2 + 7);
    const box = centerBox(screen, { title: opts.title, width: 78, height });

    const helperLine = blessed.text({
      parent: box,
      top: 0,
      left: 0,
      width: '100%-2',
      height: 1,
      content: '{gray-fg}Tab/Shift-Tab: navigate fields  Enter on last field: submit  Esc: cancel{/gray-fg}',
      style: { fg: COLOR.muted, bg: COLOR.bg },
      tags: true,
    });
    void helperLine;
    void rowHeight;

    const errorLine = blessed.text({
      parent: box,
      bottom: 0,
      left: 0,
      width: '100%-2',
      height: 1,
      content: '',
      style: { fg: COLOR.sell, bg: COLOR.bg },
      tags: true,
    });

    // Build a vertically scrolling form area. Each field is label + textbox.
    const form = blessed.box({
      parent: box,
      top: 2,
      left: 0,
      width: '100%-2',
      height: height - 5,
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      mouse: false,
      tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg },
    });

    const inputs: blessed.Widgets.TextboxElement[] = [];
    const labelW = 28;

    opts.fields.forEach((field, idx) => {
      const initVal =
        opts.initial && field.key in opts.initial
          ? String(opts.initial[field.key as keyof T] ?? '')
          : (field.initial ?? '');

      blessed.text({
        parent: form,
        top: idx * 2,
        left: 0,
        width: labelW,
        height: 1,
        content: field.label,
        style: { fg: COLOR.fg, bg: COLOR.bg },
        tags: true,
      });

      const tb = blessed.textbox({
        parent: form,
        top: idx * 2,
        left: labelW,
        width: 40,
        height: 1,
        inputOnFocus: true,
        keys: true,
        mouse: false,
        style: {
          fg: COLOR.fg,
          bg: COLOR.bgHeader,
          focus: { fg: COLOR.fg, bg: COLOR.dim },
        },
      });
      tb.setValue(initVal);

      if (field.helper) {
        blessed.text({
          parent: form,
          top: idx * 2 + 1,
          left: labelW,
          width: 40,
          height: 1,
          content: `{gray-fg}${field.helper}{/gray-fg}`,
          style: { fg: COLOR.muted, bg: COLOR.bg },
          tags: true,
        });
      }

      inputs.push(tb);
    });

    let activeIndex = 0;
    let finished = false;

    const collect = (): T => {
      const out: Record<string, string> = {};
      opts.fields.forEach((f, idx) => {
        out[f.key as string] = inputs[idx].getValue();
      });
      return out as T;
    };

    const validateField = (field: FormField<string>, raw: string): string | null => {
      if (field.type === 'number') {
        if (raw.trim() === '') return null;
        const num = Number(raw);
        if (!isFinite(num)) return `${field.label}: must be a number`;
      }
      if (field.type === 'boolean') {
        if (raw.trim() === '') return null;
        const v = raw.trim().toLowerCase();
        if (!['true', 'false', '1', '0', 'y', 'n', 'yes', 'no'].includes(v)) {
          return `${field.label}: must be true/false`;
        }
      }
      return null;
    };

    const focusIndex = (idx: number): void => {
      if (idx < 0) idx = inputs.length - 1;
      if (idx >= inputs.length) idx = 0;
      activeIndex = idx;
      const input = inputs[idx];
      input.focus();
      (input as any).readInput?.(() => undefined);
      // Auto-scroll the form so the active input is visible
      const top = idx * 2;
      const formH = (form as any).height as number;
      if (typeof formH === 'number') {
        if (top < (form as any).childBase) (form as any).scrollTo(top);
        else if (top >= (form as any).childBase + formH - 2) (form as any).scrollTo(top - formH + 3);
      }
      screen.render();
    };

    const scope: ModalScope = {
      cleanup: () => {
        for (const ip of inputs) ip.removeAllListeners();
        box.detach();
        shade.detach();
      },
    };

    const submit = (): void => {
      if (finished) return;
      // Validate per-field types first
      for (let i = 0; i < opts.fields.length; i++) {
        const e = validateField(opts.fields[i], inputs[i].getValue());
        if (e) {
          errorLine.setContent(`{red-fg}${e}{/red-fg}`);
          focusIndex(i);
          return;
        }
      }
      const values = collect();
      if (opts.validate) {
        const err = opts.validate(values);
        if (err) {
          errorLine.setContent(`{red-fg}${err}{/red-fg}`);
          screen.render();
          return;
        }
      }
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(values);
    };

    const cancel = (): void => {
      if (finished) return;
      finished = true;
      teardown(scope, screen, previousFocus);
      resolve(null);
    };

    inputs.forEach((tb, idx) => {
      tb.key(['escape'], cancel);
      tb.key(['tab'], () => {
        // commit current value before moving (already in textbox state)
        focusIndex(idx + 1);
      });
      tb.key(['S-tab'], () => {
        focusIndex(idx - 1);
      });
      tb.on('submit', () => {
        if (idx === inputs.length - 1) submit();
        else focusIndex(idx + 1);
      });
      tb.on('cancel', cancel);
    });

    focusIndex(0);
    screen.render();
  });
}

// ─── Help overlay ─────────────────────────────────────────
export interface HelpEntry {
  key: string;
  description: string;
}

export interface HelpSection {
  title: string;
  entries: HelpEntry[];
}

export function showHelpOverlay(
  screen: blessed.Widgets.Screen,
  sections: HelpSection[]
): Promise<void> {
  return new Promise((resolve) => {
    const previousFocus = (screen as any).focused as blessed.Widgets.BlessedElement | null;
    const shade = attachShade(screen);

    // Render two columns of sections side-by-side. We pre-compute content
    // lines per column then merge them.
    const half = Math.ceil(sections.length / 2);
    const left = sections.slice(0, half);
    const right = sections.slice(half);

    const renderColumn = (cols: HelpSection[]): string[] => {
      const lines: string[] = [];
      for (const sec of cols) {
        lines.push(`{bold}{#FF8CC8-fg}${sec.title}{/}{/bold}`);
        for (const e of sec.entries) {
          const keyPart = `{cyan-fg}${e.key.padEnd(8)}{/cyan-fg}`;
          lines.push(` ${keyPart} ${e.description}`);
        }
        lines.push('');
      }
      return lines;
    };

    const leftLines = renderColumn(left);
    const rightLines = renderColumn(right);

    const totalLines = Math.max(leftLines.length, rightLines.length);
    const height = Math.min(30, totalLines + 5);
    const box = centerBox(screen, { title: 'Keyboard Shortcuts', width: 86, height });

    blessed.box({
      parent: box,
      top: 0,
      left: 0,
      width: '50%',
      height: '100%-3',
      content: leftLines.join('\n'),
      tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg },
    });

    blessed.box({
      parent: box,
      top: 0,
      left: '50%',
      width: '50%-2',
      height: '100%-3',
      content: rightLines.join('\n'),
      tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg },
    });

    blessed.text({
      parent: box,
      bottom: 0,
      left: 0,
      content: '{gray-fg}Esc / ? / q  to close{/gray-fg}',
      style: { fg: COLOR.muted, bg: COLOR.bg },
      tags: true,
    });

    let finished = false;
    const close = (): void => {
      if (finished) return;
      finished = true;
      box.removeAllListeners();
      shade.removeAllListeners();
      box.detach();
      shade.detach();
      if (previousFocus && typeof (previousFocus as any).focus === 'function') {
        try {
          (previousFocus as any).focus();
        } catch {
          // ignore
        }
      }
      screen.render();
      resolve();
    };

    box.key(['escape', 'q', '?'], close);
    box.focus();
    screen.render();
  });
}

// ─── Order entry modal (manual buy/sell) ──────────────────
// A rich, live-updating order ticket modeled on the O2 web app:
//   - Always-visible balances, market prices, fees and min-order
//   - Side toggle (Buy/Sell) and Order-type toggle (Limit/Market/PostOnly/IOC/FOK)
//   - Price field accepting numeric or shortcuts: m|mid, b|bid, a|ask
//   - Quantity field accepting numeric or "<n>%"/max for % of available
//   - Live-computed total, estimated fee, estimated slippage, status
//   - Submit via Place Order button or Enter from any input
export interface OrderEntryContext {
  pair: string;              // e.g. "ETH/USDC"
  baseSymbol: string;
  quoteSymbol: string;
  baseAvail: number;         // human units
  quoteAvail: number;        // human units (e.g. USDC)
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadPercent: number | null;
  makerFeePercent: number;   // e.g. 0.01 for 1bps
  takerFeePercent: number;
  minOrderUsd: number;
  initialSide?: 'Buy' | 'Sell';
}

export type OrderEntryType = 'Limit' | 'Market' | 'PostOnly' | 'IOC' | 'FOK';

export interface OrderEntryResult {
  side: 'Buy' | 'Sell';
  orderType: OrderEntryType;
  priceHuman: number;        // 0 if Market
  quantityHuman: number;
}

export function showOrderEntryModal(
  screen: blessed.Widgets.Screen,
  ctx: OrderEntryContext
): Promise<OrderEntryResult | null> {
  return new Promise((resolve) => {
    const previousFocus = (screen as any).focused as blessed.Widgets.BlessedElement | null;
    const shade = attachShade(screen);

    const TYPES: OrderEntryType[] = ['Limit', 'Market', 'PostOnly', 'IOC', 'FOK'];

    const state: {
      side: 'Buy' | 'Sell';
      type: OrderEntryType;
      priceRaw: string;
      qtyRaw: string;
    } = {
      side: ctx.initialSide ?? 'Buy',
      type: 'Limit',
      priceRaw: ctx.midPrice ? trimNum(ctx.midPrice) : '',
      qtyRaw: '',
    };

    const box = centerBox(screen, { title: `Manual Order — ${ctx.pair}`, width: 84, height: 22 });

    // Header lines (static — recomputed only when ctx changes, which it doesn't here)
    const balLine = blessed.text({
      parent: box, top: 0, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg },
      content: `Avail   {#78F0BE-fg}${fmtAmt(ctx.baseAvail)} ${ctx.baseSymbol}{/}   {#FFD750-fg}${fmtUsd(ctx.quoteAvail)} ${ctx.quoteSymbol}{/}`,
    });
    void balLine;
    blessed.text({
      parent: box, top: 1, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg },
      content: `Market  Mid ${fmtPrice(ctx.midPrice)}   Bid ${fmtPrice(ctx.bestBid)}   Ask ${fmtPrice(ctx.bestAsk)}`,
    });
    blessed.text({
      parent: box, top: 2, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.muted, bg: COLOR.bg },
      content: `Spread ${ctx.spreadPercent != null ? ctx.spreadPercent.toFixed(3) + '%' : '—'}   Maker ${ctx.makerFeePercent.toFixed(3)}%   Taker ${ctx.takerFeePercent.toFixed(3)}%   Min ${fmtUsd(ctx.minOrderUsd)}`,
    });

    // Side toggle (focusable). Left/Right toggles, B/S also work, Tab moves on.
    const sideRow = blessed.box({
      parent: box, top: 4, left: 0, width: '100%-2', height: 1,
      keys: true, mouse: false, tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg, focus: { fg: COLOR.fg, bg: COLOR.dim } },
    });

    // Type toggle
    const typeRow = blessed.box({
      parent: box, top: 5, left: 0, width: '100%-2', height: 1,
      keys: true, mouse: false, tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg, focus: { fg: COLOR.fg, bg: COLOR.dim } },
    });

    // Price field (label + textbox + helper)
    blessed.text({
      parent: box, top: 7, left: 0, width: 8, height: 1,
      content: 'Price', tags: true, style: { fg: COLOR.fg, bg: COLOR.bg },
    });
    const priceTb = blessed.textbox({
      parent: box, top: 7, left: 8, width: 26, height: 1,
      inputOnFocus: true, keys: true, mouse: false,
      style: { fg: COLOR.fg, bg: COLOR.bgHeader, focus: { fg: COLOR.fg, bg: COLOR.dim } },
    });
    priceTb.setValue(state.priceRaw);
    blessed.text({
      parent: box, top: 7, left: 36, width: '100%-37', height: 1, tags: true,
      style: { fg: COLOR.muted, bg: COLOR.bg },
      content: '{gray-fg}m=mid  b=bid  a=ask  (or a number){/gray-fg}',
    });

    // Quantity field
    blessed.text({
      parent: box, top: 8, left: 0, width: 8, height: 1,
      content: 'Qty', tags: true, style: { fg: COLOR.fg, bg: COLOR.bg },
    });
    const qtyTb = blessed.textbox({
      parent: box, top: 8, left: 8, width: 26, height: 1,
      inputOnFocus: true, keys: true, mouse: false,
      style: { fg: COLOR.fg, bg: COLOR.bgHeader, focus: { fg: COLOR.fg, bg: COLOR.dim } },
    });
    qtyTb.setValue(state.qtyRaw);
    blessed.text({
      parent: box, top: 8, left: 36, width: '100%-37', height: 1, tags: true,
      style: { fg: COLOR.muted, bg: COLOR.bg },
      content: '{gray-fg}25/50/75/100/max = % of available  (or a number){/gray-fg}',
    });

    // Live-computed footer rows
    const totalLine = blessed.text({
      parent: box, top: 10, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg }, content: '',
    });
    const afterLine = blessed.text({
      parent: box, top: 11, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.muted, bg: COLOR.bg }, content: '',
    });
    const statusLine = blessed.text({
      parent: box, top: 12, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.fg, bg: COLOR.bg }, content: '',
    });

    // Place button (focusable)
    const placeBtn = blessed.box({
      parent: box, top: 14, left: 0, width: 18, height: 1,
      keys: true, mouse: false, tags: true,
      content: '{center}{bold}[ Place Order ]{/bold}{/center}',
      style: { fg: COLOR.fg, bg: COLOR.dim, focus: { fg: 'white', bg: COLOR.accent } },
    });

    blessed.text({
      parent: box, bottom: 0, left: 0, width: '100%-2', height: 1, tags: true,
      style: { fg: COLOR.muted, bg: COLOR.bg },
      content: '{gray-fg}Tab/Shift-Tab: next field   ←/→: toggle   Enter: submit   Esc: cancel{/gray-fg}',
    });

    // Tab order
    const focusables: Array<blessed.Widgets.BlessedElement> = [sideRow, typeRow, priceTb, qtyTb, placeBtn];
    let focusIdx = 0;

    // ─── Computation ────────────────────────────────────────
    const resolvePrice = (): { value: number; isMarket: boolean; valid: boolean; reason?: string } => {
      if (state.type === 'Market' || state.type === 'IOC' || state.type === 'FOK') {
        // Marketable order types: ignore price input
        return { value: 0, isMarket: true, valid: true };
      }
      const raw = state.priceRaw.trim().toLowerCase();
      if (raw === '' || raw === 'm' || raw === 'mid') {
        if (ctx.midPrice == null) return { value: 0, isMarket: false, valid: false, reason: 'No mid price' };
        return { value: ctx.midPrice, isMarket: false, valid: true };
      }
      if (raw === 'b' || raw === 'bid') {
        if (ctx.bestBid == null) return { value: 0, isMarket: false, valid: false, reason: 'No bid' };
        return { value: ctx.bestBid, isMarket: false, valid: true };
      }
      if (raw === 'a' || raw === 'ask') {
        if (ctx.bestAsk == null) return { value: 0, isMarket: false, valid: false, reason: 'No ask' };
        return { value: ctx.bestAsk, isMarket: false, valid: true };
      }
      const n = Number(raw);
      if (!isFinite(n) || n <= 0) return { value: 0, isMarket: false, valid: false, reason: 'Bad price' };
      return { value: n, isMarket: false, valid: true };
    };

    const resolveQty = (priceForSizing: number): { value: number; valid: boolean; reason?: string } => {
      const raw = state.qtyRaw.trim().toLowerCase();
      if (raw === '') return { value: 0, valid: false, reason: 'Enter qty' };
      // Percentage / max syntax
      if (raw === 'max') return computePctQty(100, priceForSizing);
      const m = raw.match(/^(\d+(?:\.\d+)?)\s*%$/);
      if (m) return computePctQty(Number(m[1]), priceForSizing);
      // Bare number that user *might* mean as %: treat 25/50/75/100 as percentages for convenience
      if (/^(25|50|75|100)$/.test(raw)) return computePctQty(Number(raw), priceForSizing);
      const n = Number(raw);
      if (!isFinite(n) || n <= 0) return { value: 0, valid: false, reason: 'Bad qty' };
      return { value: n, valid: true };
    };

    const computePctQty = (pct: number, priceForSizing: number): { value: number; valid: boolean; reason?: string } => {
      if (pct < 0 || pct > 100) return { value: 0, valid: false, reason: 'Pct 0-100' };
      if (state.side === 'Sell') {
        return { value: ctx.baseAvail * (pct / 100), valid: true };
      }
      // Buy: convert quote → base via price
      if (priceForSizing <= 0) return { value: 0, valid: false, reason: 'Need price for %' };
      return { value: (ctx.quoteAvail * (pct / 100)) / priceForSizing, valid: true };
    };

    const recompute = (): void => {
      // Side row
      const buySel = state.side === 'Buy';
      sideRow.setContent(
        `Side    ${pill('BUY', buySel, COLOR.buy)}  ${pill('Sell', !buySel, COLOR.sell)}`
      );
      // Type row
      typeRow.setContent(
        'Type    ' +
          TYPES.map((t) => pill(t, state.type === t, COLOR.accent)).join('  ')
      );

      // Read current textbox values into state (in case a keypress just happened)
      state.priceRaw = priceTb.getValue();
      state.qtyRaw = qtyTb.getValue();

      const p = resolvePrice();
      // For sizing of Market orders, use mid as a placeholder
      const sizingPrice = p.isMarket ? (ctx.midPrice ?? ctx.bestAsk ?? ctx.bestBid ?? 0) : p.value;
      const q = resolveQty(sizingPrice);

      const isMaker = state.type === 'Limit' || state.type === 'PostOnly';
      const feePct = isMaker ? ctx.makerFeePercent : ctx.takerFeePercent;
      const total = q.valid && sizingPrice > 0 ? q.value * sizingPrice : 0;
      const fee = total * (feePct / 100);

      // Slippage estimate (for marketable types only): naive — distance from mid to opposite top-of-book
      let slipStr = '—';
      if (p.isMarket && ctx.midPrice && (ctx.bestBid != null || ctx.bestAsk != null)) {
        const opposing = state.side === 'Buy' ? ctx.bestAsk : ctx.bestBid;
        if (opposing != null && ctx.midPrice > 0) {
          const slipPct = Math.abs(opposing - ctx.midPrice) / ctx.midPrice * 100;
          const slipUsd = q.valid ? Math.abs(opposing - ctx.midPrice) * q.value : 0;
          slipStr = `${slipPct.toFixed(3)}% / ${fmtUsd(slipUsd)}`;
        }
      }

      totalLine.setContent(
        `Total   {bold}${fmtUsd(total)}{/bold}          Fee ${fmtUsd(fee)} (${isMaker ? 'maker' : 'taker'})     Slippage ${slipStr}`
      );

      // Result line: post-trade balances
      let baseAfter = ctx.baseAvail;
      let quoteAfter = ctx.quoteAvail;
      if (q.valid) {
        if (state.side === 'Buy') {
          baseAfter += q.value;
          quoteAfter -= total + fee;
        } else {
          baseAfter -= q.value;
          quoteAfter += total - fee;
        }
      }
      afterLine.setContent(
        `After   ${fmtAmt(baseAfter)} ${ctx.baseSymbol}  /  ${fmtUsd(quoteAfter)} ${ctx.quoteSymbol}`
      );

      // Status / validation
      let status = '';
      if (!p.valid) {
        status = `{#FF8CC8-fg}${p.reason}{/}`;
      } else if (!q.valid) {
        status = `{#FF8CC8-fg}${q.reason}{/}`;
      } else if (total > 0 && total < ctx.minOrderUsd) {
        status = `{#FFC83C-fg}Below min order ${fmtUsd(ctx.minOrderUsd)}{/}`;
      } else if (state.side === 'Buy' && total + fee > ctx.quoteAvail) {
        status = `{#FF8CC8-fg}Insufficient ${ctx.quoteSymbol}{/}`;
      } else if (state.side === 'Sell' && q.value > ctx.baseAvail) {
        status = `{#FF8CC8-fg}Insufficient ${ctx.baseSymbol}{/}`;
      } else if (state.type === 'PostOnly') {
        // Warn if a PostOnly limit would cross the book
        if (state.side === 'Buy' && ctx.bestAsk != null && p.value >= ctx.bestAsk) {
          status = `{#FFC83C-fg}PostOnly would cross book (price >= ask){/}`;
        } else if (state.side === 'Sell' && ctx.bestBid != null && p.value <= ctx.bestBid) {
          status = `{#FFC83C-fg}PostOnly would cross book (price <= bid){/}`;
        } else {
          status = `{#78F0BE-fg}Ready{/}`;
        }
      } else {
        status = `{#78F0BE-fg}Ready{/}`;
      }
      statusLine.setContent(`Status  ${status}`);

      screen.render();
    };

    const isReady = (): boolean => {
      const p = resolvePrice();
      const q = resolveQty(p.isMarket ? (ctx.midPrice ?? ctx.bestAsk ?? ctx.bestBid ?? 0) : p.value);
      if (!p.valid || !q.valid) return false;
      const sizingPrice = p.isMarket ? (ctx.midPrice ?? 0) : p.value;
      const total = q.value * sizingPrice;
      if (sizingPrice > 0 && total < ctx.minOrderUsd) return false;
      const isMaker = state.type === 'Limit' || state.type === 'PostOnly';
      const feePct = isMaker ? ctx.makerFeePercent : ctx.takerFeePercent;
      const fee = total * (feePct / 100);
      if (state.side === 'Buy' && total + fee > ctx.quoteAvail) return false;
      if (state.side === 'Sell' && q.value > ctx.baseAvail) return false;
      return true;
    };

    let finished = false;
    const cancel = (): void => {
      if (finished) return;
      finished = true;
      box.detach();
      shade.detach();
      if (previousFocus && typeof (previousFocus as any).focus === 'function') {
        try { (previousFocus as any).focus(); } catch { /* noop */ }
      }
      screen.render();
      resolve(null);
    };
    const submit = (): void => {
      if (finished) return;
      if (!isReady()) {
        recompute();
        return;
      }
      const p = resolvePrice();
      const q = resolveQty(p.isMarket ? (ctx.midPrice ?? ctx.bestAsk ?? ctx.bestBid ?? 0) : p.value);
      finished = true;
      box.detach();
      shade.detach();
      if (previousFocus && typeof (previousFocus as any).focus === 'function') {
        try { (previousFocus as any).focus(); } catch { /* noop */ }
      }
      screen.render();
      resolve({
        side: state.side,
        orderType: state.type,
        priceHuman: p.isMarket ? 0 : p.value,
        quantityHuman: q.value,
      });
    };

    const focusAt = (idx: number): void => {
      if (idx < 0) idx = focusables.length - 1;
      if (idx >= focusables.length) idx = 0;
      focusIdx = idx;
      const f = focusables[idx];
      f.focus();
      if (f === priceTb || f === qtyTb) {
        (f as any).readInput?.(() => undefined);
      }
      recompute();
    };

    // Side row keys
    sideRow.key(['left', 'right', 'b', 's', 'B', 'S'], (_ch, key) => {
      if (key.name === 'b' || key.name === 'B') state.side = 'Buy';
      else if (key.name === 's' || key.name === 'S') state.side = 'Sell';
      else state.side = state.side === 'Buy' ? 'Sell' : 'Buy';
      recompute();
    });
    sideRow.key(['tab'], () => focusAt(focusIdx + 1));
    sideRow.key(['S-tab'], () => focusAt(focusIdx - 1));
    sideRow.key(['enter'], () => focusAt(focusIdx + 1));
    sideRow.key(['escape'], cancel);

    // Type row keys
    typeRow.key(['left', 'right'], (_ch, key) => {
      const i = TYPES.indexOf(state.type);
      const next = key.name === 'left'
        ? (i - 1 + TYPES.length) % TYPES.length
        : (i + 1) % TYPES.length;
      state.type = TYPES[next];
      recompute();
    });
    typeRow.key(['tab'], () => focusAt(focusIdx + 1));
    typeRow.key(['S-tab'], () => focusAt(focusIdx - 1));
    typeRow.key(['enter'], () => focusAt(focusIdx + 1));
    typeRow.key(['escape'], cancel);

    // Textboxes
    for (const tb of [priceTb, qtyTb]) {
      tb.on('keypress', () => {
        // Defer one tick so the textbox has the latest value
        setImmediate(recompute);
      });
      tb.key(['escape'], cancel);
      tb.key(['tab'], () => {
        // commit current value before moving
        focusAt(focusIdx + 1);
      });
      tb.key(['S-tab'], () => focusAt(focusIdx - 1));
      tb.on('submit', () => {
        // Enter from textbox: try to submit the order if ready, else move on
        if (isReady()) submit();
        else focusAt(focusIdx + 1);
      });
      tb.on('cancel', cancel);
    }

    // Place button
    placeBtn.key(['enter', 'space'], submit);
    placeBtn.key(['tab'], () => focusAt(focusIdx + 1));
    placeBtn.key(['S-tab'], () => focusAt(focusIdx - 1));
    placeBtn.key(['escape'], cancel);

    // Initial focus + render
    focusAt(0);
    recompute();
  });
}

// Helpers used by showOrderEntryModal.
function pill(label: string, active: boolean, activeColor: string): string {
  if (active) return `{${activeColor}-fg}{bold}[ ${label} ]{/bold}{/}`;
  return `{gray-fg}  ${label}  {/gray-fg}`;
}
function trimNum(n: number): string {
  if (!isFinite(n)) return '';
  // Show up to 6 decimals but strip trailing zeros
  return n.toFixed(6).replace(/\.?0+$/, '');
}
function fmtAmt(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}
function fmtUsd(n: number): string {
  if (!isFinite(n)) return '$?';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return `$${n >= 100 ? n.toFixed(2) : n.toFixed(4)}`;
}
