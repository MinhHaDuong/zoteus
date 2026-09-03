import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools, type ToolContext } from '../../src/registry/registry.js';
import { createMetrics } from '../../src/lib/metrics.js';
import { tools } from '../../src/tools/index.js';
import type { UsageEvent, UsageRecorder } from '../../src/lib/usage/event.js';

/** The narrowest context zotero_search_items needs, plus the telemetry under test. */
function harness(searchItems: () => Promise<unknown>) {
  const events: UsageEvent[] = [];
  const usage: UsageRecorder = {
    record: (e) => events.push(e),
    flush: async () => {},
    close: async () => {},
  };
  const metrics = createMetrics();
  const cloud = { userID: 19552201, username: 'oscardvs', access: { user: { write: true } } };
  const ctx: ToolContext = {
    config: { local: 'off', libraryType: 'user' } as any,
    capabilities: { cloud: cloud as any, localApi: false, localGroupIds: [] },
    router: {
      whoami: () => cloud,
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      searchItems: vi.fn(searchItems),
    } as any,
    schema: {} as any,
    web: {} as any,
    styles: {} as any,
    translation: {} as any,
    search: {} as any,
    scholar: {} as any,
    fetcher: {} as any,
    searchIndexPath: '/tmp/unused-index.json',
    reopenSearchIndex: async () => ({}) as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    zoteroUserId: 19552201,
    metrics,
    usage,
  };
  return { ctx, events, metrics };
}

async function connect(ctx: ToolContext) {
  const server = new McpServer(
    { name: 'zoteus-test', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, tools, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const ONE_HIT = async () => ({
  data: [
    { key: 'ABCD1234', version: 1, data: { itemType: 'journalArticle', title: 'Deep Learning' } },
  ],
  totalResults: 1,
  lastModifiedVersion: 1,
});

describe('tool call instrumentation', () => {
  it('records a successful call without recording what was searched for', async () => {
    const { ctx, events, metrics } = harness(ONE_HIT);
    const client = await connect(ctx);
    await client.callTool({
      name: 'zotero_search_items',
      arguments: { q: 'meningococcal vaccination uptake', limit: 5, top: true },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'tool',
      name: 'zotero_search_items',
      ok: true,
      userId: 19552201,
    });
    expect(events[0]!.ms).toBeGreaterThanOrEqual(0);
    // The shape says which arguments were used and how big they were; the query itself is
    // nowhere in the record, which is the property the whole design turns on.
    expect(JSON.parse(events[0]!.shape!)).toEqual({ q: 'string(32)', limit: 'number', top: true });
    expect(JSON.stringify(events)).not.toContain('meningococcal');

    expect(metrics.snapshot()['tool_calls_total{outcome="ok",tool="zotero_search_items"}']).toBe(1);
    expect(metrics.snapshot()['tool_duration_ms_count{tool="zotero_search_items"}']).toBe(1);
  }, 20_000);

  it('classifies a thrown Zotero error by status, with no message in the record', async () => {
    const { ctx, events, metrics } = harness(async () => {
      throw Object.assign(new Error('Access denied for library 19552201'), { status: 403 });
    });
    const client = await connect(ctx);
    const res = await client.callTool({ name: 'zotero_search_items', arguments: { q: 'x' } });

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(events[0]).toMatchObject({ ok: false, errorKind: 'zotero_4xx' });
    expect(JSON.stringify(events)).not.toContain('Access denied');
    expect(metrics.snapshot()['tool_calls_total{outcome="error",tool="zotero_search_items"}']).toBe(
      1,
    );
  }, 20_000);
});
