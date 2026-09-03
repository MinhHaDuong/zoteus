import type { Request, Response, NextFunction } from 'express';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';
import type { UsageRecorder } from './usage/event.js';

const SKIP = new Set(['/healthz', '/readyz', '/metrics', '/usage.json']);
const statusClass = (s: number): string => `${Math.floor(s / 100)}xx`;

/**
 * Every path this server actually answers. Anything else that 404s is somebody scanning.
 *
 * A list rather than a regex over the router because the OAuth routes come from the SDK
 * and are not introspectable at this point in the stack. It is only used to classify, so
 * a route added here late costs a mislabel, never a dropped request.
 */
const KNOWN_ROUTES = [
  '/authorize',
  '/token',
  '/register',
  '/revoke',
  '/consent',
  '/license',
  '/oauth/zotero/callback',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
];

export interface RequestLoggerOptions {
  metrics?: Metrics;
  usage?: UsageRecorder;
  /** The MCP endpoint path, so it is labelled as itself rather than as `other`. */
  mcpPath?: string;
}

/**
 * One structured line per request: method, route, status, latency, client/session/user id.
 *
 * Two things here are about making the numbers mean something rather than about logging.
 * The route label is normalised, so a metric can be grouped by endpoint without the
 * cardinality of raw paths. And a 404 on a path this server does not have is counted
 * separately as a scanner hit: the live instance takes a steady trickle of bots probing
 * `/credentials.json`, `/key.json` and friends, and left in the general error bucket they
 * were most of the 4xx — an error rate that moved with the internet's weather rather than
 * with anything we shipped.
 */
export function requestLogger(logger: Logger, opts: RequestLoggerOptions = {}) {
  const { metrics, usage } = opts;
  const mcpPath = opts.mcpPath ?? '/mcp';
  const routeOf = (path: string): string | undefined =>
    path === mcpPath ? mcpPath : KNOWN_ROUTES.includes(path) ? path : undefined;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (SKIP.has(req.path)) return next();
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const auth = (req as Request & { auth?: { clientId?: string; extra?: unknown } }).auth;
      const userId = (auth?.extra as { zoteroUserId?: number } | undefined)?.zoteroUserId;
      const sid = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      const known = routeOf(req.path);
      const scanner = !known && res.statusCode === 404;
      const route = known ?? 'other';
      const fields = {
        method: req.method,
        path: req.path, // never originalUrl → no query string in logs
        status: res.statusCode,
        ms,
        clientId: auth?.clientId,
        sessionId,
        userId,
      };

      if (scanner) {
        metrics?.inc('http_scanner_requests_total');
        // Debug, not info: this is the internet knocking on doors, and at info it drowns
        // out the requests an operator is actually reading the log for.
        logger.debug('http scan', fields);
        return;
      }

      metrics?.inc('http_requests_total', 1, { status_class: statusClass(res.statusCode), route });
      // Named for what it counts. It was `tool_calls_total`, which it never was: an
      // `initialize`, a `tools/list` and a notification all land here, and a batch of five
      // tool calls lands once. The real per-tool counter is incremented in the tool
      // registry, where the tool name exists.
      if (req.method === 'POST' && req.path === mcpPath) metrics?.inc('mcp_requests_total');
      logger.info('http', fields);
      usage?.record({
        ts: Date.now(),
        kind: 'http',
        name: `${req.method} ${route}`,
        userId,
        clientId: auth?.clientId,
        sessionId,
        ok: res.statusCode < 400,
        errorKind: res.statusCode >= 400 ? statusClass(res.statusCode) : undefined,
        ms,
        status: res.statusCode,
        bytes: Number(res.getHeader('content-length')) || undefined,
      });
    });
    next();
  };
}
