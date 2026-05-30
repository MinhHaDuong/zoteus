// IMPORTANT: stdout carries the JSON-RPC stream on stdio transport.
// All logging MUST go to stderr.
import { redactArgs } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel | string = 'info', format: LogFormat = 'text'): Logger {
  const threshold = ORDER[level as LogLevel] ?? ORDER.info;
  const emit = (lvl: LogLevel, args: unknown[]) => {
    if (ORDER[lvl] < threshold) return;
    const parts = redactArgs(args).map((a) => (typeof a === 'string' ? a : safeStringify(a)));
    const msg = parts.join(' ');
    if (format === 'json') {
      process.stderr.write(`${safeStringify({ level: lvl, time: new Date().toISOString(), msg })}\n`);
    } else {
      process.stderr.write(`[zoteus] ${lvl.toUpperCase()} ${msg}\n`);
    }
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
