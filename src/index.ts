#!/usr/bin/env node
import { loadConfig } from './config.js';
import { buildServer, createServer, ContextCache } from './server.js';
import { startStdio } from './transports/stdio.js';
import { startHttp } from './transports/http.js';
import { buildOAuth } from './auth/router.js';
import { createLogger } from './lib/logger.js';
import { createMetrics } from './lib/metrics.js';
import { makeReadiness, storeCheck, zoteroPingCheck } from './lib/health.js';
import { installShutdownHandlers } from './lib/lifecycle.js';
import type { Server } from 'node:http';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

const VERSION = '0.12.0';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, config.logFormat);
  const { server, ctx } = await buildServer(config);

  const httpFlag = flag('http');
  if (httpFlag !== undefined) {
    const port = Number(flag('port') ?? process.env.PORT ?? 3939);
    const oauth = await buildOAuth(config);
    const host = flag('host') ?? process.env.HOST ?? (oauth ? '0.0.0.0' : '127.0.0.1');
    const cache = new ContextCache(config, ctx);
    const metrics = config.metricsEnabled ? createMetrics() : undefined;
    const readiness = makeReadiness(
      {
        store: storeCheck(oauth?.store),
        ...(config.readyzCheckZotero ? { zotero: zoteroPingCheck() } : {}),
      },
      30_000,
    );

    let lifecycle: { drainSessions: (ms: number) => Promise<void>; activeSessions: () => number } | undefined;
    const httpServer: Server = await startHttp(async (authInfo) => createServer(await cache.resolve(authInfo)), {
      port,
      host,
      logger,
      oauth,
      metrics,
      readiness,
      version: VERSION,
      rateLimit: config.mcpRateLimit,
      enableDnsRebindingProtection: Boolean(oauth),
      allowedHosts: oauth?.allowedHosts,
      allowInsecureBind: config.allowInsecureHttp,
      registerLifecycle: (h) => {
        lifecycle = h;
      },
    });

    installShutdownHandlers({
      server: httpServer,
      logger,
      timeoutMs: 25_000,
      drainSessions: (ms) => lifecycle?.drainSessions(ms) ?? Promise.resolve(),
      flush: async () => {
        await oauth?.store.flush();
        await cache.flushIndexes();
      },
    });
  } else {
    await startStdio(server);
    logger.info('Zoteus MCP server started on stdio.');
  }
}

main().catch((err) => {
  process.stderr.write(`[zoteus] FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
