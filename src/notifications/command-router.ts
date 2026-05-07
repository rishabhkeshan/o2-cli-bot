/**
 * Telegram inbound command router.
 *
 * Wave 3 will wire actual handler implementations. This module only provides:
 * - The `BotCommandHandlers` interface that the wiring layer must implement.
 * - The `CommandRouter` class that parses inbound chat messages, enforces an
 *   allowlist of chat IDs, dispatches to handlers, and returns a response
 *   string (or `null` if the message should be ignored).
 *
 * The router never throws — handler errors are caught and converted into a
 * safe error message so the Telegram polling loop can keep running.
 */

export interface BotCommandHandlers {
  status: () => Promise<string>;
  pause: () => Promise<string>;
  resume: () => Promise<string>;
  cancelAll: (marketId?: string) => Promise<string>;
  flatten: (marketId?: string) => Promise<string>;
  setStrategy: (preset: string, marketId?: string) => Promise<string>;
  listMarkets: () => Promise<string>;
  help: () => Promise<string>;
}

export type AllowedChatId = number | string;

/**
 * Normalises a chat ID to its string form for consistent set lookups.
 * Telegram delivers chat IDs as numbers, but the env var is parsed as strings.
 */
function normaliseChatId(id: AllowedChatId): string {
  return String(id).trim();
}

export class CommandRouter {
  private allowed: Set<string>;

  constructor(
    private handlers: BotCommandHandlers,
    allowedChatIds: Set<AllowedChatId> | Iterable<AllowedChatId>
  ) {
    this.allowed = new Set<string>();
    for (const id of allowedChatIds) {
      const norm = normaliseChatId(id);
      if (norm.length > 0) this.allowed.add(norm);
    }
  }

  /**
   * Returns true if the chat ID is allowed to issue commands.
   * Public for debugging / unit tests.
   */
  isAuthorized(chatId: AllowedChatId): boolean {
    return this.allowed.has(normaliseChatId(chatId));
  }

  /**
   * Routes a Telegram message text for a given chat ID.
   *
   * Returns:
   *  - a response string to send back to the user, or
   *  - `null` if the message is not a recognised command (no reply).
   *
   * Unauthorized chat IDs receive a polite "not authorized" message AND
   * trigger a console warning so operators can detect probing.
   */
  async route(chatId: AllowedChatId, text: string): Promise<string | null> {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    // Strip a possible "@botname" suffix that Telegram appends in groups.
    // e.g. "/status@MyBot foo" -> ["/status", "foo"]
    const parts = trimmed.split(/\s+/);
    const head = parts[0] ?? '';
    const cmd = head.split('@')[0]?.toLowerCase() ?? '';
    const args = parts.slice(1);

    if (!this.isAuthorized(chatId)) {
      console.warn(
        `[CommandRouter] Unauthorized command "${cmd}" from chat ${normaliseChatId(chatId)}`
      );
      return 'You are not authorized to control this bot.';
    }

    try {
      switch (cmd) {
        case '/start':
        case '/help':
          return await this.handlers.help();

        case '/status':
          return await this.handlers.status();

        case '/pause':
          return await this.handlers.pause();

        case '/resume':
          return await this.handlers.resume();

        case '/cancel': {
          const market = args[0];
          return await this.handlers.cancelAll(market);
        }

        case '/flatten': {
          const market = args[0];
          return await this.handlers.flatten(market);
        }

        case '/strategy': {
          if (args.length < 1) {
            return 'Usage: /strategy <preset> [MARKET]';
          }
          const preset = args[0] as string;
          const market = args[1];
          return await this.handlers.setStrategy(preset, market);
        }

        case '/markets':
          return await this.handlers.listMarkets();

        default:
          // Unknown slash command — stay silent so we don't spam groups.
          return null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CommandRouter] Handler for "${cmd}" threw:`, err);
      return `Command failed: ${msg}`;
    }
  }
}
