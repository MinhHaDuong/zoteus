import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZoteusConfig } from './config.js';
import { createLogger } from './lib/logger.js';
import { RateLimitedFetcher } from './api/http.js';
import { WebApiClient } from './api/web-client.js';
import { LocalApiClient } from './api/local-client.js';
import { probeCapabilities } from './router/capabilities.js';
import { LibraryRouter } from './router/library-router.js';
import { SchemaService } from './schema/schema-service.js';
import { registerAllTools, type ToolContext } from './registry/registry.js';
import { registerResources } from './resources/index.js';
import { tools } from './tools/index.js';

export interface BuiltServer {
  server: McpServer;
  ctx: ToolContext;
}

const VERSION = '0.2.0';

export async function buildServer(config: ZoteusConfig): Promise<BuiltServer> {
  const logger = createLogger(config.logLevel);
  const fetcher = new RateLimitedFetcher({ maxConcurrency: 4, logger });
  const web = new WebApiClient({
    apiKey: config.apiKey,
    fetcher,
    contactEmail: config.contactEmail,
    logger,
  });
  const local = config.local !== 'off' ? new LocalApiClient({ port: config.localPort, fetcher }) : undefined;

  const capabilities = await probeCapabilities(config, { web, local, logger });
  const router = new LibraryRouter({ config, capabilities, web, local });
  const schema = new SchemaService({ web });

  const ctx: ToolContext = { config, capabilities, router, schema, web, local, logger };

  const server = new McpServer(
    { name: 'zoteus', version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions:
        'Zoteus exposes your Zotero library. Call zotero_whoami first to resolve identity. Prefer zotero_search_items for discovery and zotero_get_item for full records. Use zotero_schema before constructing items.',
    },
  );

  registerAllTools(server, tools, ctx);
  registerResources(server, ctx);

  return { server, ctx };
}
