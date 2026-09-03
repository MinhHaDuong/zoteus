import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { createMetrics } from '../../src/lib/metrics.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DailyRow } from '../../src/lib/usage/rollup.js';

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});
const bare = () => new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } });

const row = (over: Partial<DailyRow> = {}): DailyRow => ({
  day: '2026-09-03',
  kind: 'tool',
  name: 'zotero_search_items',
  userId: 777,
  calls: 3,
  errors: 1,
  msSum: 300,
  msP50: 100,
  msP95: 180,
  msMax: 180,
  ...over,
});

async function serve(over: Parameters<typeof startHttp>[1] = {}): Promise<string> {
  const metrics = createMetrics();
  metrics.inc('http_requests_total', 1, { status_class: '2xx', route: '/mcp' });
  metrics.observe('tool_duration_ms', 42, { tool: 'zotero_search_items' });
  httpServer = await startHttp(() => bare(), {
    port: 0,
    host: '127.0.0.1',
    metrics,
    usageRollups: () => [row()],
    ...over,
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

describe('usage and metrics endpoints', () => {
  it('renders labelled counters and a latency histogram with TYPE headers', async () => {
    const text = await (await fetch(`${await serve()}/metrics`)).text();
    expect(text).toContain('# TYPE zoteus_http_requests_total counter');
    expect(text).toContain('zoteus_http_requests_total{route="/mcp",status_class="2xx"} 1');
    expect(text).toContain('# TYPE zoteus_tool_duration_ms histogram');
    expect(text).toContain('zoteus_tool_duration_ms_bucket{le="100",tool="zotero_search_items"} 1');
    // Cumulative: a 42 ms call is not in the 25 ms bucket but is in every bucket above it.
    expect(text).not.toContain('zoteus_tool_duration_ms_bucket{le="25"');
    expect(text).toContain(
      'zoteus_tool_duration_ms_bucket{le="+Inf",tool="zotero_search_items"} 1',
    );
    expect(text).toContain('zoteus_tool_duration_ms_count{tool="zotero_search_items"} 1');
  }, 20_000);

  it('serves rollups from /usage.json', async () => {
    const res = await fetch(`${await serve()}/usage.json?days=7`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; rows: DailyRow[] };
    expect(body.days).toBe(7);
    expect(body.rows[0]).toMatchObject({ name: 'zotero_search_items', calls: 3, userId: 777 });
  }, 20_000);

  it('demands the token on both endpoints once one is configured', async () => {
    const base = await serve({ metricsToken: 's3cret-token' });
    for (const path of ['/metrics', '/usage.json']) {
      expect((await fetch(`${base}${path}`)).status).toBe(401);
      expect(
        (await fetch(`${base}${path}`, { headers: { authorization: 'Bearer wrong' } })).status,
      ).toBe(401);
      // A prefix of the real token must not pass: the comparison is over hashes of both.
      expect(
        (await fetch(`${base}${path}`, { headers: { authorization: 'Bearer s3cret' } })).status,
      ).toBe(401);
      expect(
        (await fetch(`${base}${path}`, { headers: { authorization: 'Bearer s3cret-token' } }))
          .status,
      ).toBe(200);
    }
  }, 20_000);

  it('leaves /usage.json unmounted when there is no usage log', async () => {
    const base = await serve({ usageRollups: undefined });
    expect((await fetch(`${base}/usage.json`)).status).toBe(404);
  }, 20_000);
});
