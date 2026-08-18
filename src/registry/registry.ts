import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from '../router/capabilities.js';
import type { LibraryRouter } from '../router/library-router.js';
import type { SchemaService } from '../schema/schema-service.js';
import type { WebApiClient, LibraryRef } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { LocalWriteClient } from '../api/local-writes.js';
import type { ConnectorWriteClient } from '../api/connector-writes.js';
import type { Logger } from '../lib/logger.js';
import type { StyleResolver } from '../features/citation/styles.js';
import type { TranslationServerClient } from '../features/citation/translation-server.js';
import type { SearchIndex } from '../features/search/index-manager.js';
import type { ScholarGraph } from '../features/scholar/graph.js';
import type { RateLimitedFetcher } from '../api/http.js';
import { ZoteroApiError } from '../api/errors.js';

export interface ToolContext {
  config: ZoteusConfig;
  capabilities: Capabilities;
  router: LibraryRouter;
  schema: SchemaService;
  web: WebApiClient;
  local?: LocalApiClient;
  /** Zotero 9+ desktop local-API writes (user-granted key); undefined when unavailable. */
  localWrites?: LocalWriteClient;
  /** Desktop connector-API writes (Zotero 7+): saveItems/saveAttachment/updateSession. */
  connectorWrites?: ConnectorWriteClient;
  styles: StyleResolver;
  translation: TranslationServerClient;
  search: SearchIndex;
  scholar: ScholarGraph;
  /** Shared rate-limited fetcher (used by built-in import resolution). */
  fetcher: RateLimitedFetcher;
  logger: Logger;
  /** Absolute path to this context's semantic-search index file (per-user in multi-tenant mode). */
  searchIndexPath: string;
  /** Lightweight catalog of all registered tools (for search_tools discovery). */
  toolCatalog?: Array<{ name: string; title: string; description: string; deferLoading?: boolean }>;
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

/**
 * Build a successful result. The data is mirrored into a text content block (as
 * JSON) in addition to `structuredContent`, because many MCP clients (e.g. the
 * claude.ai web connector) surface only text content to the model and ignore
 * `structuredContent` — without the mirror, tools appear to "succeed" but the
 * model sees only the summary line and none of the payload (no item keys,
 * snippets, etc.), which silently breaks chaining into get_item/bibliography.
 */
export function ok(structured: Record<string, unknown>, summary: string): ToolHandlerResult {
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(structured, null, 2) },
    ],
    structuredContent: structured,
  };
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
      'This operation writes to a cloud/group library and requires a cloud API key (set ZOTERO_API_KEY). ' +
        'For the personal library, writes can instead go through the running Zotero 9+ desktop app (local API).',
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


/**
 * True when a local-API write failure means the running Zotero simply does not have
 * (or accept) local writes yet — e.g. Zotero <= 9.0 whose local API is read-only
 * ("No endpoint found", 501 "Endpoint does not support method") — as opposed to a
 * real write failure (denied grant, validation error, stale version). Callers use
 * this to fall back to the connector protocol or the cloud Web API.
 */
export function isLocalWritesUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /local api/i.test(msg) && /404|no endpoint|not implemented|not supported|unreachable/i.test(msg);
}


/**
 * The local-API capability is probed at startup, but Zotero may be restarted (or
 * briefly unresponsive) during a long-lived server process. This re-pings once and
 * refreshes the flag so desktop write paths recover without a restart.
 */
export async function ensureLocalApi(ctx: ToolContext): Promise<boolean> {
  if (ctx.capabilities.localApi) return true;
  if (!ctx.local || ctx.config.local === 'off') return false;
  const up = await ctx.local.ping().catch(() => false);
  if (up) ctx.capabilities.localApi = true;
  return up;
}
