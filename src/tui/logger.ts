import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private logFile: string | null = null;
  private level: LogLevel = 'info';
  private listeners: Array<(level: LogLevel, message: string) => void> = [];
  private levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(dataDir?: string, level: LogLevel = 'info') {
    this.level = level;
    if (dataDir) {
      const logDir = resolve(dataDir, 'logs');
      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }
      const date = new Date().toISOString().split('T')[0];
      this.logFile = resolve(logDir, `o2-bot-${date}.log`);
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  onLog(listener: (level: LogLevel, message: string) => void): void {
    this.listeners.push(listener);
  }

  debug(message: string, context?: string): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: string): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: string): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: string): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context?: string): void {
    if (this.levelPriority[level] < this.levelPriority[this.level]) return;

    const timestamp = new Date().toISOString().slice(11, 23);
    const prefix = context ? `[${context}]` : '';
    const formatted = `${timestamp} ${level.toUpperCase().padEnd(5)} ${prefix} ${message}`;

    // Write to log file
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, formatted + '\n');
      } catch {
        // Ignore file write errors
      }
    }

    // Notify TUI listeners
    for (const listener of this.listeners) {
      listener(level, formatted);
    }
  }
}
