import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from '../router/capabilities.js';
import type { LibraryRouter } from '../router/library-router.js';
import type { SchemaService } from '../schema/schema-service.js';
import type { WebApiClient, LibraryRef } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';
import type { StyleResolver } from '../features/citation/styles.js';
import type { TranslationServerClient } from '../features/citation/translation-server.js';
import type { SearchIndex } from '../features/search/index-manager.js';
import { ZoteroApiError } from '../api/errors.js';

export interface ToolContext {
  config: ZoteusConfig;
  capabilities: Capabilities;
  router: LibraryRouter;
  schema: SchemaService;
  web: WebApiClient;
  local?: LocalApiClient;
  styles: StyleResolver;
  translation: TranslationServerClient;
  search: SearchIndex;
  logger: Logger;
}

export interface ToolHandlerResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // The SDK's CallToolResult is an open object; this index signature makes
  // ToolHandlerResult structurally assignable to it.
  [key: string]: unknown;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema?: ZodRawShape;
  annotations?: ToolAnnotations;
  deferLoading?: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<ToolHandlerResult>;
}

/** Build a successful result that mirrors structured data into a text block. */
export function ok(structured: Record<string, unknown>, summary: string): ToolHandlerResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

/**
 * Resolve the library a WRITE should target. Writes only go to the cloud Web API
 * (the local API is read-only), so this throws a friendly error when no API key is
 * configured. The thrown message is surfaced to the model as an isError result.
 */
export function requireCloudLibrary(
  ctx: ToolContext,
  args?: { library_type?: 'user' | 'group'; library_id?: number },
): LibraryRef {
  if (args?.library_id) return { type: args.library_type ?? 'group', id: args.library_id };
  const cloud = ctx.capabilities.cloud;
  if (!cloud) {
    throw new Error(
      'This operation writes to Zotero and requires a cloud API key (set ZOTERO_API_KEY). The desktop local API is read-only.',
    );
  }
  return { type: 'user', id: cloud.userID };
}

export function registerAllTools(
  server: McpServer,
  defs: ToolDefinition[],
  ctx: ToolContext,
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
        annotations: { title: def.title, openWorldHint: true, ...def.annotations },
      },
      async (args: unknown) => {
        try {
          return await def.handler(args, ctx);
        } catch (err) {
          const message =
            err instanceof ZoteroApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          ctx.logger.error(`Tool ${def.name} failed:`, message);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }
}
