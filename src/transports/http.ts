import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Logger } from '../lib/logger.js';
import type { BuiltOAuth } from '../auth/router.js';

/**
 * A factory that produces a fresh McpServer per MCP session. Receives the session's
 * {@link AuthInfo} (from the bearer middleware) so the server can be bound to a per-user
 * ToolContext; `undefined` on the no-auth path → the operator/shared context.
 */
export type McpServerFactory = (authInfo?: AuthInfo) => McpServer | Promise<McpServer>;

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

/** True if a parsed JSON-RPC body is (or contains) an MCP `initialize` request. */
function isInitialize(body: unknown): boolean {
  const one = (m: unknown): boolean =>
    typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize';
  return Array.isArray(body) ? body.some(one) : one(body);
}

/**
 * Start the MCP server on a Streamable HTTP transport via Express.
 *
 * Pass a {@link McpServerFactory} to get **per-session** transports (a fresh server +
 * transport per `Mcp-Session-Id`) — required for remote/multi-client use such as a
 * claude.ai connector, where each connection sends its own `initialize`. Passing a
 * single {@link McpServer} keeps the legacy single-shared-transport behaviour (fine for
 * one client / local use).
 *
 * When `oauth` is provided the OAuth 2.1 metadata/DCR/token/authorize endpoints are
 * mounted and `/mcp` is protected by bearer-token auth; otherwise `/mcp` is
 * unauthenticated and must stay on loopback. Resolves with the underlying http.Server.
 */
export async function startHttp(
  serverOrFactory: McpServer | McpServerFactory,
  opts: HttpOptions = {},
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';

  // Safety: never expose an unauthenticated MCP endpoint on a non-loopback interface.
  if (!opts.oauth && !opts.allowInsecureBind && !LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to bind ${host} without OAuth: an unauthenticated MCP endpoint must stay on loopback. ` +
        `Enable OAuth (ZOTEUS_OAUTH_ENABLED=true) or set ZOTEUS_ALLOW_INSECURE_HTTP=true to override.`,
    );
  }

  const makeTransport = (
    onsessioninitialized?: (sessionId: string) => void,
  ): StreamableHTTPServerTransport =>
    new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      enableDnsRebindingProtection: opts.enableDnsRebindingProtection ?? false,
      allowedHosts: opts.allowedHosts,
      onsessioninitialized,
    });

  // Build the request router: either a single shared transport (legacy) or a
  // per-session map keyed by Mcp-Session-Id (factory mode).
  let route: (req: express.Request, res: express.Response) => Promise<void>;

  if (typeof serverOrFactory !== 'function') {
    const transport = makeTransport();
    await serverOrFactory.connect(transport);
    route = (req, res) => transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
  } else {
    const factory = serverOrFactory;
    const transports = new Map<string, StreamableHTTPServerTransport>();
    route = async (req, res) => {
      const body = req.method === 'POST' ? req.body : undefined;
      const header = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(header) ? header[0] : header;

      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (!sessionId && req.method === 'POST' && isInitialize(body)) {
        transport = makeTransport((sid) => transports.set(sid, transport!));
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transports.delete(sid);
        };
        const server = await factory((req as express.Request & { auth?: AuthInfo }).auth);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: No valid session ID' },
          id: null,
        });
        return;
      }
      await transport!.handleRequest(req, res, body);
    };
  }

  const app = express();
  app.disable('x-powered-by');
  // Behind a TLS proxy/tunnel (OAuth deployments) so express-rate-limit keys on the
  // forwarded client IP instead of throwing on the X-Forwarded-For header.
  if (opts.oauth) app.set('trust proxy', 1);

  if (opts.oauth) opts.oauth.mount(app);

  const guards = opts.oauth
    ? [requireBearerAuth({ verifier: opts.oauth.provider, resourceMetadataUrl: opts.oauth.resourceMetadataUrl })]
    : [];

  const wrap = (req: express.Request, res: express.Response): void => {
    route(req, res).catch((err) => {
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
