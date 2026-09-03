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

export function createLogger(
  level: LogLevel | string = 'info',
  format: LogFormat = 'text',
): Logger {
  const threshold = ORDER[level as LogLevel] ?? ORDER.info;
  const emit = (lvl: LogLevel, args: unknown[]) => {
    if (ORDER[lvl] < threshold) return;
    const redacted = redactArgs(args);
    if (format === 'json') {
      // A trailing plain object becomes TOP-LEVEL keys, not text inside `msg`. Every call
      // site here already passes one — logger.info('http', { method, path, status, ms }) —
      // and stringifying it into the message made the whole structured format useless:
      // `docker logs | jq 'select(.status >= 500)'` matched nothing, because there was no
      // `.status`, only a `.msg` with an escaped JSON document inside it.
      const fields = trailingFields(redacted);
      const text = (fields ? redacted.slice(0, -1) : redacted)
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      process.stderr.write(
        `${safeStringify({ level: lvl, time: new Date().toISOString(), msg: text, ...fields })}\n`,
      );
    } else {
      const text = redacted.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
      process.stderr.write(`[zoteus] ${lvl.toUpperCase()} ${text}\n`);
    }
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

/**
 * The last argument, when it is a plain object worth spreading into the record.
 *
 * Deliberately narrow. An Error has no enumerable own properties, so spreading one would
 * silently drop it; an array would spread as `0`, `1`, `2`; and the reserved keys are
 * dropped rather than allowed to overwrite the record's own, so no caller can move the
 * meaning of `level` or `time` by naming a field after it.
 */
function trailingFields(args: unknown[]): Record<string, unknown> | undefined {
  const last = args[args.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last) || last instanceof Error)
    return undefined;
  const entries = Object.entries(last as Record<string, unknown>).filter(
    ([k, v]) => v !== undefined && k !== 'level' && k !== 'time' && k !== 'msg',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
