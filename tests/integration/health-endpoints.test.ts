import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { createMetrics } from '../../src/lib/metrics.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});
const bare = () => new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } });

describe('ops endpoints', () => {
  it('serves /healthz, /readyz, /metrics outside the /mcp path', async () => {
    const metrics = createMetrics();
    // Seed a counter so /metrics has something to render in Prometheus text format.
    metrics.inc('http_requests_total', 1, { status_class: '2xx' });
    httpServer = await startHttp(() => bare(), {
      port: 0,
      host: '127.0.0.1',
      version: '0.12.0',
      metrics,
      readiness: async () => ({ ok: true, checks: { store: { ok: true } } }),
    });
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(200);
    expect((await h.json()).version).toBe('0.12.0');

    const r = await fetch(`${base}/readyz`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);

    const m = await fetch(`${base}/metrics`);
    expect(m.status).toBe(200);
    expect(await m.text()).toContain('zoteus_');
  }, 20_000);

  it('/readyz returns 503 when a check fails', async () => {
    httpServer = await startHttp(() => bare(), {
      port: 0,
      host: '127.0.0.1',
      readiness: async () => ({ ok: false, checks: { zotero: { ok: false, detail: 'down' } } }),
    });
    const port = (httpServer.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(r.status).toBe(503);
  }, 20_000);
});
