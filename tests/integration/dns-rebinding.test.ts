import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});

function bareServer(): McpServer {
  return new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } });
}

describe('DNS rebinding protection', () => {
  it('rejects requests whose Host header is not allow-listed', async () => {
    httpServer = await startHttp(bareServer(), {
      port: 0,
      host: '127.0.0.1',
      enableDnsRebindingProtection: true,
      allowedHosts: ['zoteus.test'], // request Host will be 127.0.0.1:<port> → rejected
    });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(403);
  });
});

describe('insecure public bind guard', () => {
  it('refuses to bind a non-loopback host without OAuth', async () => {
    await expect(startHttp(bareServer(), { port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/i);
  });

  it('allows a non-loopback bind when explicitly overridden', async () => {
    httpServer = await startHttp(bareServer(), { port: 0, host: '0.0.0.0', allowInsecureBind: true });
    expect(httpServer.listening).toBe(true);
  });
});
