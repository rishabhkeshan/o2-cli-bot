import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config();

export interface Config {
  o2: {
    apiUrl: string;
    wsUrl: string;
    networkUrl: string;
  };
  wallet: {
    privateKey: string;
    type: 'fuel' | 'evm';
  };
  session: {
    password?: string;
    expiryMs: number;
  };
  notifications: {
    telegram: {
      botToken?: string;
      chatId?: string;
    };
    discord: {
      webhookUrl?: string;
    };
  };
  dataDir: string;
  strategiesDir: string;
}

export const DEFAULT_SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export function loadConfig(): Config {
  // Re-read .env in case it was written after initial import
  dotenv.config({ override: true });

  const apiUrl = process.env.O2_API_URL || 'https://api.o2.app';

  // Validate wallet type at runtime
  const rawWalletType = process.env.O2_WALLET_TYPE || 'fuel';
  if (rawWalletType !== 'fuel' && rawWalletType !== 'evm') {
    throw new Error(`Invalid O2_WALLET_TYPE: "${rawWalletType}". Must be "fuel" or "evm".`);
  }

  return {
    o2: {
      apiUrl,
      wsUrl: apiUrl.replace('https://', 'wss://').replace('http://', 'ws://'),
      networkUrl: process.env.O2_NETWORK_URL || 'https://mainnet.fuel.network/v1/graphql',
    },
    wallet: {
      privateKey: process.env.O2_PRIVATE_KEY || '',
      type: rawWalletType,
    },
    session: {
      password: process.env.O2_SESSION_PASSWORD,
      expiryMs: parseInt(process.env.O2_SESSION_EXPIRY_MS || '') || DEFAULT_SESSION_EXPIRY_MS,
    },
    notifications: {
      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
      },
      discord: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      },
    },
    dataDir: resolve(process.cwd(), process.env.O2_DATA_DIR || 'data'),
    strategiesDir: resolve(process.cwd(), process.env.O2_STRATEGIES_DIR || 'strategies'),
  };
}
