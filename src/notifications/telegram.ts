import TelegramBot from 'node-telegram-bot-api';
import type { CommandRouter } from './command-router.js';
import type { AlertType } from './index.js';

export interface TelegramNotifierOptions {
  /**
   * Opt-in to inbound command polling. Default false (one-way alerts only).
   * Can also be enabled via env var `TELEGRAM_ENABLE_COMMANDS=true`.
   */
  enableCommands?: boolean;
  /**
   * Alert types to suppress on this channel. Other types still send.
   */
  disabledTypes?: AlertType[];
}

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private lastAlertTimes: Map<string, number> = new Map();
  private rateLimitMs = 60000; // 1 alert per type per minute
  private commandsEnabled: boolean;
  private polling = false;
  private router: CommandRouter | null = null;
  private disabledTypes: Set<string>;

  constructor(botToken: string, chatId: string, options: TelegramNotifierOptions = {}) {
    this.chatId = chatId;

    const envFlag = (process.env.TELEGRAM_ENABLE_COMMANDS || '').toLowerCase();
    const envEnabled = envFlag === 'true' || envFlag === '1' || envFlag === 'yes';
    this.commandsEnabled = options.enableCommands === true || envEnabled;

    this.disabledTypes = new Set<string>(options.disabledTypes ?? []);

    try {
      // Always start with polling: false. We flip to a polling instance only
      // when both `commandsEnabled` is true AND a router is attached. This
      // preserves the existing default (one-way alerts) for users who haven't
      // opted in.
      this.bot = new TelegramBot(botToken, { polling: false });
    } catch (err) {
      console.error('[Telegram] Failed to initialize:', err);
    }
  }

  /**
   * Attach a command router and (if commands are enabled) start polling for
   * inbound messages. Safe to call once. No-op when commands are disabled.
   */
  attachCommandRouter(router: CommandRouter): void {
    this.router = router;
    if (!this.commandsEnabled) return;
    if (!this.bot) return;
    if (this.polling) return;
    this.startPolling();
  }

  private startPolling(): void {
    if (!this.bot) return;
    try {
      // node-telegram-bot-api supports flipping polling on at runtime via
      // startPolling(). We swallow the unhandled error path in case the
      // network blips during boot.
      void this.bot.startPolling({ restart: true }).catch((err: unknown) => {
        console.error('[Telegram] startPolling rejected:', err);
      });
      this.polling = true;
    } catch (err) {
      console.error('[Telegram] startPolling threw:', err);
      return;
    }

    this.bot.on('polling_error', (err: Error) => {
      // Network blips, 409 conflicts, etc. — log and keep going.
      console.error('[Telegram] polling_error:', err.message || err);
    });

    this.bot.on('message', (msg) => {
      // Fire-and-forget; the handler swallows its own errors.
      void this.handleIncoming(msg);
    });
  }

  private async handleIncoming(msg: TelegramBot.Message): Promise<void> {
    if (!this.bot || !this.router) return;
    const text = msg.text;
    if (typeof text !== 'string' || text.length === 0) return;
    const fromChatId = msg.chat.id;
    try {
      const response = await this.router.route(fromChatId, text);
      if (response === null) return;
      await this.bot.sendMessage(fromChatId, response, { parse_mode: 'Markdown' }).catch(
        // If markdown parsing fails (user-supplied content), retry plain.
        async () => {
          if (!this.bot) return;
          await this.bot.sendMessage(fromChatId, response).catch((err: unknown) => {
            console.error('[Telegram] reply failed:', err);
          });
        }
      );
    } catch (err) {
      console.error('[Telegram] handleIncoming failed:', err);
    }
  }

  async sendAlert(type: string, message: string): Promise<void> {
    if (!this.bot) return;
    if (this.disabledTypes.has(type)) return;

    // Rate limiting
    const now = Date.now();
    const lastTime = this.lastAlertTimes.get(type) || 0;
    if (now - lastTime < this.rateLimitMs) return;
    this.lastAlertTimes.set(type, now);

    try {
      await this.bot.sendMessage(this.chatId, `*O2 Bot - ${type}*\n\n${message}`, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      console.error('[Telegram] Send failed:', err);
    }
  }

  get isEnabled(): boolean {
    return this.bot !== null;
  }

  get isPolling(): boolean {
    return this.polling;
  }
}
