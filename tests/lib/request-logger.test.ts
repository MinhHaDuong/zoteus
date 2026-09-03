import { describe, it, expect } from 'vitest';
import { requestLogger } from '../../src/lib/request-logger.js';
import { createMetrics } from '../../src/lib/metrics.js';
import type { Logger } from '../../src/lib/logger.js';
import type { UsageEvent, UsageRecorder } from '../../src/lib/usage/event.js';

function fakeRes(statusCode = 200) {
  const handlers: Record<string, () => void> = {};
  return {
    statusCode,
    getHeader: () => undefined,
    on: (ev: string, cb: () => void) => {
      handlers[ev] = cb;
    },
    finish: () => handlers.finish?.(),
  };
}

function harness() {
  const info: unknown[][] = [];
  const debug: unknown[][] = [];
  const logger = {
    info: (...a: unknown[]) => info.push(a),
    debug: (...a: unknown[]) => debug.push(a),
    warn() {},
    error() {},
  } as Logger;
  const events: UsageEvent[] = [];
  const usage: UsageRecorder = {
    record: (e) => events.push(e),
    flush: async () => {},
    close: async () => {},
  };
  const metrics = createMetrics();
  return { info, debug, logger, events, usage, metrics };
}

describe('requestLogger', () => {
  it('logs method/path/status, skips /healthz, increments metrics, never logs query', () => {
    const { info, logger, metrics } = harness();
    const mw = requestLogger(logger, { metrics });

    const res1 = fakeRes();
    mw(
      { method: 'POST', path: '/mcp', originalUrl: '/mcp?secret=x', headers: {} } as never,
      res1 as never,
      () => {},
    );
    res1.finish();
    const res2 = fakeRes();
    mw({ method: 'GET', path: '/healthz', headers: {} } as never, res2 as never, () => {});
    res2.finish();

    const joined = JSON.stringify(info);
    expect(joined).toContain('/mcp');
    expect(joined).not.toContain('secret=x');
    expect(joined).not.toContain('/healthz'); // health skipped
    expect(metrics.snapshot()['http_requests_total{route="/mcp",status_class="2xx"}']).toBe(1);
    // Renamed from tool_calls_total, which counted POST /mcp and never a tool.
    expect(metrics.snapshot()['mcp_requests_total']).toBe(1);
  });

  it('classifies a 404 on an unknown path as a scanner, not an error', () => {
    const { info, debug, logger, metrics, usage, events } = harness();
    const mw = requestLogger(logger, { metrics, usage });

    const scan = fakeRes(404);
    mw({ method: 'GET', path: '/credentials.json', headers: {} } as never, scan as never, () => {});
    scan.finish();

    expect(metrics.snapshot()['http_scanner_requests_total']).toBe(1);
    expect(
      metrics.snapshot()['http_requests_total{route="other",status_class="4xx"}'],
    ).toBeUndefined();
    // Kept out of the durable log and off the info stream: it is the internet knocking.
    expect(events).toHaveLength(0);
    expect(info).toHaveLength(0);
    expect(JSON.stringify(debug)).toContain('/credentials.json');
  });

  it('records a usage event with the caller identity and no query string', () => {
    const { logger, metrics, usage, events } = harness();
    const mw = requestLogger(logger, { metrics, usage });

    const res = fakeRes(401);
    mw(
      {
        method: 'POST',
        path: '/mcp',
        originalUrl: '/mcp?q=cats',
        headers: { 'mcp-session-id': 'sess-1' },
        auth: { clientId: 'client-9', extra: { zoteroUserId: 777 } },
      } as never,
      res as never,
      () => {},
    );
    res.finish();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'http',
      name: 'POST /mcp',
      userId: 777,
      clientId: 'client-9',
      sessionId: 'sess-1',
      ok: false,
      errorKind: '4xx',
      status: 401,
    });
    expect(JSON.stringify(events)).not.toContain('cats');
  });
});
