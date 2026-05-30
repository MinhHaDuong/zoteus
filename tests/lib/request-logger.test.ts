import { describe, it, expect } from 'vitest';
import { requestLogger } from '../../src/lib/request-logger.js';
import { createMetrics } from '../../src/lib/metrics.js';
import type { Logger } from '../../src/lib/logger.js';

function fakeRes() {
  const handlers: Record<string, () => void> = {};
  return {
    statusCode: 200,
    on: (ev: string, cb: () => void) => {
      handlers[ev] = cb;
    },
    finish: () => handlers.finish?.(),
  };
}

describe('requestLogger', () => {
  it('logs method/path/status, skips /healthz, increments metrics, never logs query', () => {
    const lines: unknown[][] = [];
    const logger = { info: (...a: unknown[]) => lines.push(a), debug() {}, warn() {}, error() {} } as Logger;
    const metrics = createMetrics();
    const mw = requestLogger(logger, metrics);

    const res1 = fakeRes();
    mw({ method: 'POST', path: '/mcp', originalUrl: '/mcp?secret=x', headers: {} } as never, res1 as never, () => {});
    res1.finish();
    const res2 = fakeRes();
    mw({ method: 'GET', path: '/healthz', headers: {} } as never, res2 as never, () => {});
    res2.finish();

    const joined = JSON.stringify(lines);
    expect(joined).toContain('/mcp');
    expect(joined).not.toContain('secret=x');
    expect(joined).not.toContain('/healthz'); // health skipped
    expect(metrics.snapshot()['http_requests_total{status_class="2xx"}']).toBe(1);
  });
});
