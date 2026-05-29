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

describe('Streamable HTTP transport', () => {
  it('serves tools over HTTP to a real MCP client', async () => {
    const server = new McpServer({ name: 'zoteus-http-test', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.registerTool(
      'ping',
      { description: 'ping', inputSchema: { msg: z.string() } },
      async ({ msg }) => ({ content: [{ type: 'text', text: `pong:${msg}` }] }),
    );

    httpServer = await startHttp(server, { port: 0, host: '127.0.0.1' });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const client = new Client({ name: 'http-test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');

    const res: any = await client.callTool({ name: 'ping', arguments: { msg: 'hi' } });
    expect(res.content[0].text).toBe('pong:hi');

    await client.close();
  }, 20_000);
});
