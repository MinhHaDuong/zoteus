#!/usr/bin/env node
import { loadConfig } from './config.js';
import { buildServer, createServer, createDeferredServer, toolSelectionNotice, ContextCache } from './server.js';
import { startStdio } from './transports/stdio.js';
import { startHttp } from './transports/http.js';
import { buildOAuth } from './auth/router.js';
import { createLogger } from './lib/logger.js';
import { createMetrics } from './lib/metrics.js';
import { makeReadiness, storeCheck, zoteroPingCheck } from './lib/health.js';
import { installShutdownHandlers } from './lib/lifecycle.js';
import type { ToolContext } from './registry/registry.js';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

const VERSION: string = createRequire(import.meta.url)('../package.json').version;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, config.logFormat);
  // Held by loadConfig rather than printed there: it runs before this logger exists, and a
  // setting it could not use must not be the reason the server never starts (#18).
  for (const warning of config.warnings) logger.warn(`Configuration: ${warning}`);

  const httpFlag = flag('http');
  if (httpFlag !== undefined) {
    const { ctx } = await buildServer(config);
    const port = Number(flag('port') ?? process.env.PORT ?? 3939);
    const metrics = config.metricsEnabled ? createMetrics() : undefined;
    const oauth = await buildOAuth(config, {
      onEvent: metrics ? (e) => metrics.inc(`${e === 'token_issued' ? 'tokens_issued' : 'auth_failures'}_total`) : undefined,
    });
    const host = flag('host') ?? process.env.HOST ?? (oauth ? '0.0.0.0' : '127.0.0.1');
    const cache = new ContextCache(config, ctx);
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
    // Connect first, build second. The context probe takes a couple of seconds (it retries
    // the desktop app while Zotero starts, checks the cloud key, opens the search index),
    // and a host that expects a prompt `initialize` will have given up by then — Claude
    // Desktop's shared Cowork/Code pool allows well under a second before it tears the
    // server down (#18). Tool calls await the build, so none of them sees a half-built
    // context; only the handshake stops waiting on it.
    const { server, context } = createDeferredServer(config);
    // Held for the shutdown flush, and only once the build has succeeded: a session that
    // ends before then has nothing of its own to write, and must not start a build on its
    // way out.
    let built: ToolContext | undefined;
    await startStdio(server, {
      logger,
      flush: async () => {
        if (!built) return;
        // save() can refuse (an index whose store never opened); close() is what
        // checkpoints the write-ahead log, so it runs either way.
        await built.search.save().catch((e) => logger.debug(`Index save on shutdown: ${message(e)}`));
        await built.search.close().catch((e) => logger.debug(`Index close on shutdown: ${message(e)}`));
      },
    });
    logger.info('Zoteus MCP server started on stdio.');
    const notice = toolSelectionNotice(config);
    if (notice) logger.info(notice);
    // Warmed now rather than on the first tool call. A failure is reported and left for
    // that call to retry, instead of taking the process down with it.
    void context()
      .then((ctx) => {
        built = ctx;
      })
      .catch((err) => {
        logger.error(`Startup failed (the next tool call retries): ${message(err)}`);
      });
  }
}

main().catch((err) => {
  process.stderr.write(`[zoteus] FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
