#!/usr/bin/env node
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { startStdio } from './transports/stdio.js';
import { startHttp } from './transports/http.js';
import { createLogger } from './lib/logger.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { server } = await buildServer(config);

  const httpFlag = flag('http');
  if (httpFlag !== undefined) {
    const port = Number(flag('port') ?? process.env.PORT ?? 3939);
    const host = flag('host') ?? process.env.HOST ?? '127.0.0.1';
    await startHttp(server, { port, host, logger });
  } else {
    await startStdio(server);
    logger.info('Zoteus MCP server started on stdio.');
  }
}

main().catch((err) => {
  process.stderr.write(`[zoteus] FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
