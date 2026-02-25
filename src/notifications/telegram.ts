import TelegramBot from 'node-telegram-bot-api';

export class TelegramNotifier {
  private bot: TelegramBot | null = null;
  private chatId: string;
  private lastAlertTimes: Map<string, number> = new Map();
  private rateLimitMs = 60000; // 1 alert per type per minute

  constructor(botToken: string, chatId: string) {
    this.chatId = chatId;
    try {
      this.bot = new TelegramBot(botToken, { polling: false });
    } catch (err) {
      console.error('[Telegram] Failed to initialize:', err);
    }
  }

  async sendAlert(type: string, message: string): Promise<void> {
    if (!this.bot) return;

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
}
