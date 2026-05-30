import type { Request, Response, NextFunction } from 'express';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

const SKIP = new Set(['/healthz', '/readyz', '/metrics']);
const statusClass = (s: number): string => `${Math.floor(s / 100)}xx`;

/** One structured line per request: method, path (no query), status, latency, client/session id. */
export function requestLogger(logger: Logger, metrics?: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SKIP.has(req.path)) return next();
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const auth = (req as Request & { auth?: { clientId?: string } }).auth;
      const sid = req.headers['mcp-session-id'];
      metrics?.inc('http_requests_total', 1, { status_class: statusClass(res.statusCode) });
      if (req.method === 'POST' && req.path === '/mcp') metrics?.inc('tool_calls_total');
      logger.info('http', {
        method: req.method,
        path: req.path, // never originalUrl → no query string in logs
        status: res.statusCode,
        ms,
        clientId: auth?.clientId,
        sessionId: Array.isArray(sid) ? sid[0] : sid,
      });
    });
    next();
  };
}
