import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../lib/logger.js';
import type { BuiltOAuth } from '../auth/router.js';

export interface HttpOptions {
  port?: number;
  host?: string;
  path?: string;
  logger?: Logger;
  /** When provided, OAuth endpoints are mounted and /mcp requires a bearer token. */
  oauth?: BuiltOAuth;
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
  /** Permit binding a non-loopback host without OAuth (escape hatch; default false). */
  allowInsecureBind?: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Start the MCP server on a Streamable HTTP transport (stateless JSON responses)
 * via Express. When `oauth` is provided, the OAuth 2.1 metadata/DCR/token/authorize
 * endpoints are mounted and `/mcp` is protected by bearer-token auth; otherwise
 * `/mcp` is unauthenticated and must stay on loopback. Resolves with the underlying
 * http.Server (its address().port is useful when port=0).
 */
export async function startHttp(server: McpServer, opts: HttpOptions = {}): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';

  // Safety: never expose an unauthenticated MCP endpoint on a non-loopback interface.
  if (!opts.oauth && !opts.allowInsecureBind && !LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to bind ${host} without OAuth: an unauthenticated MCP endpoint must stay on loopback. ` +
        `Enable OAuth (ZOTEUS_OAUTH_ENABLED=true) or set ZOTEUS_ALLOW_INSECURE_HTTP=true to override.`,
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    enableDnsRebindingProtection: opts.enableDnsRebindingProtection ?? false,
    allowedHosts: opts.allowedHosts,
  });
  await server.connect(transport);

  const app = express();
  app.disable('x-powered-by');

  if (opts.oauth) opts.oauth.mount(app);

  const guards = opts.oauth
    ? [requireBearerAuth({ verifier: opts.oauth.provider, resourceMetadataUrl: opts.oauth.resourceMetadataUrl })]
    : [];

  const handle = async (req: express.Request, res: express.Response): Promise<void> => {
    await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
  };
  const wrap = (req: express.Request, res: express.Response): void => {
    handle(req, res).catch((err) => {
      opts.logger?.error('HTTP request failed:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  };

  // CORS for web-based MCP clients + OPTIONS preflight (before bearer auth so
  // preflight is not rejected). The SDK already CORS-enables its own routes.
  app.use(path, cors());
  app.post(path, ...guards, express.json({ limit: '8mb' }), wrap);
  app.get(path, ...guards, wrap);
  app.delete(path, ...guards, wrap);
  app.use((_req, res) => res.status(404).json({ error: `Not found. MCP endpoint is ${path}.` }));

  const httpServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(opts.port ?? 0, host, () => resolve(s));
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  opts.logger?.info(
    `Zoteus MCP server listening on http://${host}:${port}${path}${opts.oauth ? ' (OAuth 2.1 enabled)' : ''}`,
  );
  return httpServer;
}
