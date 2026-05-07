import { TelegramNotifier } from './telegram.js';
import { DiscordNotifier } from './discord.js';
import type { CommandRouter } from './command-router.js';
import type { Config } from '../config/index.js';

/**
 * All alert types the bot may emit. The original four (BOT_STARTED,
 * BOT_STOPPED, ORDER_FILLED, ERROR) keep their string values so existing
 * callers continue to work unchanged.
 */
export type AlertType =
  | 'BOT_STARTED'
  | 'BOT_STOPPED'
  | 'ORDER_FILLED'
  | 'ORDER_PLACED'
  | 'STOP_LOSS'
  | 'ERROR'
  | 'WARNING'
  | 'INFO'
  // New in this wave
  | 'STOP_LOSS_TRIGGERED'
  | 'WS_DOWN'
  | 'ORDER_REJECTED'
  | 'DAILY_LOSS_HIT'
  | 'SESSION_EXPIRING'
  | 'SESSION_RECOVERED'
  | 'AUTO_PAUSED';

export type { CommandRouter, BotCommandHandlers, AllowedChatId } from './command-router.js';

/**
 * Per-channel notification options. None of these are required — the manager
 * defaults to legacy behavior (one-way alerts, no disabled types, polling off).
 */
export interface NotificationChannelOptions {
  /** Suppress these alert types on this channel only. */
  disabledTypes?: AlertType[];
}

export interface TelegramChannelOptions extends NotificationChannelOptions {
  /**
   * Opt in to inbound command polling. Default false. Also honoured via
   * env var `TELEGRAM_ENABLE_COMMANDS=true`.
   */
  enableCommands?: boolean;
}

export interface NotificationManagerOptions {
  telegram?: TelegramChannelOptions;
  discord?: NotificationChannelOptions;
}

/**
 * Helper: pretty timestamps in alert templates.
 */
function fmtTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  return new Date(ms).toISOString();
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return '$?';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export class NotificationManager {
  private telegram: TelegramNotifier | null = null;
  private discord: DiscordNotifier | null = null;

  constructor(config: Config, options: NotificationManagerOptions = {}) {
    if (config.notifications.telegram.botToken && config.notifications.telegram.chatId) {
      this.telegram = new TelegramNotifier(
        config.notifications.telegram.botToken,
        config.notifications.telegram.chatId,
        {
          enableCommands: options.telegram?.enableCommands,
          disabledTypes: options.telegram?.disabledTypes,
        }
      );
    }

    if (config.notifications.discord.webhookUrl) {
      this.discord = new DiscordNotifier(config.notifications.discord.webhookUrl, {
        disabledTypes: options.discord?.disabledTypes,
      });
    }
  }

  /**
   * Generic alert dispatch. Backwards-compatible signature: callers passing a
   * plain string for `type` still work. The `AlertType` union widens to
   * `string` for compatibility with the existing call sites in `src/index.ts`.
   */
  async notify(type: AlertType | string, message: string): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.telegram?.isEnabled) {
      promises.push(this.telegram.sendAlert(type, message));
    }
    if (this.discord?.isEnabled) {
      promises.push(this.discord.sendAlert(type, message));
    }
    await Promise.allSettled(promises);
  }

  /**
   * Attach a command router. Discord ignores this (webhook only). Telegram
   * will only start polling if it was constructed with `enableCommands` (or
   * the env var was set).
   */
  attachCommandRouter(router: CommandRouter): void {
    if (this.telegram?.isEnabled) {
      this.telegram.attachCommandRouter(router);
    }
  }

  get hasChannels(): boolean {
    return !!(this.telegram?.isEnabled || this.discord?.isEnabled);
  }

  // ---------------------------------------------------------------------
  // Typed alert helpers (new in this wave). All are thin wrappers that
  // build a markdown-friendly message and delegate to `notify`.
  // ---------------------------------------------------------------------

  async notifyStopLoss(
    marketId: string,
    details: { triggerPrice: string; sellPrice?: string; reason?: string }
  ): Promise<void> {
    const lines = [
      `Market: \`${marketId}\``,
      `Trigger: ${details.triggerPrice}`,
    ];
    if (details.sellPrice) lines.push(`Sell price: ${details.sellPrice}`);
    if (details.reason) lines.push(`Reason: ${details.reason}`);
    await this.notify('STOP_LOSS_TRIGGERED', lines.join('\n'));
  }

  async notifyWsDown(downSince: number): Promise<void> {
    const since = fmtTimestamp(downSince);
    const elapsedSec = Math.max(0, Math.round((Date.now() - downSince) / 1000));
    await this.notify(
      'WS_DOWN',
      `WebSocket connection down since ${since} (${elapsedSec}s ago). Bot is degraded.`
    );
  }

  async notifyOrderRejected(marketId: string, error: string): Promise<void> {
    await this.notify(
      'ORDER_REJECTED',
      `Market \`${marketId}\` order rejected: ${error}`
    );
  }

  async notifyDailyLossHit(
    marketId: string,
    pnlUsd: number,
    capUsd: number
  ): Promise<void> {
    await this.notify(
      'DAILY_LOSS_HIT',
      [
        `Daily loss cap reached on \`${marketId}\`.`,
        `P&L: ${fmtUsd(pnlUsd)}`,
        `Cap: ${fmtUsd(capUsd)}`,
        'Trading on this market is auto-paused for the rest of the session.',
      ].join('\n')
    );
  }

  async notifySessionExpiring(hoursLeft: number): Promise<void> {
    const hrs = Number.isFinite(hoursLeft) ? hoursLeft.toFixed(1) : '?';
    await this.notify(
      'SESSION_EXPIRING',
      `Session expires in ~${hrs} hours. Refresh credentials to avoid downtime.`
    );
  }

  async notifySessionRecovered(newSessionId: string): Promise<void> {
    await this.notify(
      'SESSION_RECOVERED',
      `Session recovered. New session id: \`${newSessionId}\``
    );
  }

  async notifyAutoPaused(marketId: string, reason: string): Promise<void> {
    await this.notify(
      'AUTO_PAUSED',
      `Trading auto-paused on \`${marketId}\`: ${reason}`
    );
  }
}
