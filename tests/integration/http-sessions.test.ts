import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});

function makePing(): McpServer {
  const s = new McpServer({ name: 'sess', version: '0.0.0' }, { capabilities: { tools: {} } });
  s.registerTool('ping', { description: 'ping', inputSchema: { msg: z.string() } }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong:${msg}` }],
  }));
  return s;
}

describe('per-session transports (factory mode)', () => {
  it('supports multiple concurrent sessions without "Server already initialized"', async () => {
    // Factory form: a fresh McpServer per MCP session (what claude.ai needs).
    httpServer = await startHttp(() => makePing(), { port: 0, host: '127.0.0.1' });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = (): URL => new URL(`http://127.0.0.1:${port}/mcp`);

    const c1 = new Client({ name: 'c1', version: '0.0.0' });
    const c2 = new Client({ name: 'c2', version: '0.0.0' });
    await c1.connect(new StreamableHTTPClientTransport(url()));
    await c2.connect(new StreamableHTTPClientTransport(url())); // 2nd initialize: would 400 on a shared transport

    const r1 = (await c1.callTool({ name: 'ping', arguments: { msg: 'a' } })) as { content: { text: string }[] };
    const r2 = (await c2.callTool({ name: 'ping', arguments: { msg: 'b' } })) as { content: { text: string }[] };
    expect(r1.content[0].text).toBe('pong:a');
    expect(r2.content[0].text).toBe('pong:b');

    await c1.close();
    await c2.close();
  }, 20_000);

  /**
   * Regression: a redeploy drops every in-memory session, and the client then presents a
   * session ID this process never issued. Answering 400 wedged the connector (every later
   * call failed, plain reads included, until the user reconnected by hand); 404 is the
   * spec's signal to re-initialize, so clients heal themselves.
   */
  it('answers an unknown session ID with 404 so the client re-initializes', async () => {
    httpServer = await startHttp(() => makePing(), { port: 0, host: '127.0.0.1' });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'a-session-from-a-previous-process',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe(-32001);

    // A request with no session ID at all is still a plain bad request, not a dead session.
    const noSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(noSession.status).toBe(400);

    // ...and a fresh client still connects against the same server.
    const c = new Client({ name: 'fresh', version: '0.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const r = (await c.callTool({ name: 'ping', arguments: { msg: 'ok' } })) as { content: { text: string }[] };
    expect(r.content[0].text).toBe('pong:ok');
    await c.close();
  }, 20_000);
});
