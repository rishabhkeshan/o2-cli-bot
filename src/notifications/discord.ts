import axios from 'axios';
import type { AlertType } from './index.js';

export interface DiscordNotifierOptions {
  disabledTypes?: AlertType[];
}

export class DiscordNotifier {
  private webhookUrl: string;
  private lastAlertTimes: Map<string, number> = new Map();
  private rateLimitMs = 60000;
  private disabledTypes: Set<string>;

  constructor(webhookUrl: string, options: DiscordNotifierOptions = {}) {
    this.webhookUrl = webhookUrl;
    this.disabledTypes = new Set<string>(options.disabledTypes ?? []);
  }

  async sendAlert(type: string, message: string): Promise<void> {
    if (!this.webhookUrl) return;
    if (this.disabledTypes.has(type)) return;

    const now = Date.now();
    const lastTime = this.lastAlertTimes.get(type) || 0;
    if (now - lastTime < this.rateLimitMs) return;
    this.lastAlertTimes.set(type, now);

    const colorMap: Record<string, number> = {
      BOT_STARTED: 0x00ff00,
      BOT_STOPPED: 0xff0000,
      ORDER_FILLED: 0x00bfff,
      ORDER_PLACED: 0x7289da,
      STOP_LOSS: 0xff4500,
      STOP_LOSS_TRIGGERED: 0xff4500,
      WS_DOWN: 0xffa500,
      ORDER_REJECTED: 0xff4500,
      DAILY_LOSS_HIT: 0xff0000,
      SESSION_EXPIRING: 0xffa500,
      SESSION_RECOVERED: 0x00ff00,
      AUTO_PAUSED: 0xffa500,
      ERROR: 0xff0000,
      WARNING: 0xffa500,
      INFO: 0x7289da,
    };

    try {
      await axios.post(this.webhookUrl, {
        embeds: [
          {
            title: `O2 Bot - ${type}`,
            description: message,
            color: colorMap[type] || 0x7289da,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    } catch (err) {
      console.error('[Discord] Send failed:', err);
    }
  }

  get isEnabled(): boolean {
    return !!this.webhookUrl;
  }
}
