import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../lib/logger.js';

export interface HttpOptions {
  port?: number;
  host?: string;
  path?: string;
  logger?: Logger;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Start the server on a Streamable HTTP transport (stateless, JSON responses).
 * Binds to 127.0.0.1 by default for safety. OAuth is intentionally out of scope
 * for v1 — run this only on trusted networks or behind your own auth proxy.
 * Resolves with the HTTP server (its address().port is useful when port=0).
 */
export async function startHttp(server: McpServer, opts: HttpOptions = {}): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);

  const httpServer = http.createServer((req, res) => {
    if (!req.url || !req.url.startsWith(path)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found. MCP endpoint is ${path}.` }));
      return;
    }
    const handle = async () => {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      await transport.handleRequest(req as any, res, body);
    };
    handle().catch((err) => {
      opts.logger?.error('HTTP request failed:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, host, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  opts.logger?.info(`Zoteus MCP server listening on http://${host}:${port}${path}`);
  return httpServer;
}
