#!/usr/bin/env node
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { startStdio } from './transports/stdio.js';
import { createLogger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { server } = await buildServer(config);
  // Only stdio in M0-M2. HTTP transport arrives in a later milestone.
  await startStdio(server);
  logger.info('Zoteus MCP server started on stdio.');
}

main().catch((err) => {
  process.stderr.write(`[zoteus] FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
