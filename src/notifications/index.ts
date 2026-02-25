import { TelegramNotifier } from './telegram.js';
import { DiscordNotifier } from './discord.js';
import type { Config } from '../config/index.js';

export class NotificationManager {
  private telegram: TelegramNotifier | null = null;
  private discord: DiscordNotifier | null = null;

  constructor(config: Config) {
    if (config.notifications.telegram.botToken && config.notifications.telegram.chatId) {
      this.telegram = new TelegramNotifier(
        config.notifications.telegram.botToken,
        config.notifications.telegram.chatId
      );
    }

    if (config.notifications.discord.webhookUrl) {
      this.discord = new DiscordNotifier(config.notifications.discord.webhookUrl);
    }
  }

  async notify(type: string, message: string): Promise<void> {
    const promises: Promise<void>[] = [];
    if (this.telegram?.isEnabled) {
      promises.push(this.telegram.sendAlert(type, message));
    }
    if (this.discord?.isEnabled) {
      promises.push(this.discord.sendAlert(type, message));
    }
    await Promise.allSettled(promises);
  }

  get hasChannels(): boolean {
    return !!(this.telegram?.isEnabled || this.discord?.isEnabled);
  }
}
