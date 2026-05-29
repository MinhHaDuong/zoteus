// IMPORTANT: stdout carries the JSON-RPC stream on stdio transport.
// All logging MUST go to stderr.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel | string = 'info'): Logger {
  const threshold = ORDER[level as LogLevel] ?? ORDER.info;
  const emit = (lvl: LogLevel, args: unknown[]) => {
    if (ORDER[lvl] < threshold) return;
    const parts = args.map((a) => (typeof a === 'string' ? a : safeStringify(a)));
    process.stderr.write(`[zoteus] ${lvl.toUpperCase()} ${parts.join(' ')}\n`);
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
