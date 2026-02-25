import axios from 'axios';

export class DiscordNotifier {
  private webhookUrl: string;
  private lastAlertTimes: Map<string, number> = new Map();
  private rateLimitMs = 60000;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  async sendAlert(type: string, message: string): Promise<void> {
    if (!this.webhookUrl) return;

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
