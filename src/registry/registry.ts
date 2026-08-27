import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from '../router/capabilities.js';
import type { LocalApiStatus } from '../router/local-status.js';
import type { LibraryRouter } from '../router/library-router.js';
import type { SchemaService } from '../schema/schema-service.js';
import type { WebApiClient, LibraryRef } from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { LocalWriteClient } from '../api/local-writes.js';
import type { ConnectorWriteClient } from '../api/connector-writes.js';
import type { Logger } from '../lib/logger.js';
import type { StyleResolver } from '../features/citation/styles.js';
import type { TranslationServerClient } from '../features/citation/translation-server.js';
import type { SearchIndex } from '../features/search/backend.js';
import type { ScholarGraph } from '../features/scholar/graph.js';
import type { RateLimitedFetcher } from '../api/http.js';
import type { UpdateChecker } from '../lib/update-check.js';
import { ZoteroApiError } from '../api/errors.js';

export interface ToolContext {
  config: ZoteusConfig;
  capabilities: Capabilities;
  router: LibraryRouter;
  schema: SchemaService;
  web: WebApiClient;
  local?: LocalApiClient;
  /** Zotero 10+ desktop local-API writes (user-granted key); undefined when unavailable. */
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
  /**
   * Absolute path to this context's legacy JSON search index (per-user in multi-tenant
   * mode). The SQLite backend keeps its database beside it, under the same name; both are
   * opened by createSearchIndex, so tools go through `search` rather than this path.
   */
  searchIndexPath: string;
  /**
   * Close this context's search index and open a fresh one from the same options, putting
   * it in `search`. The only sanctioned writer of that field.
   *
   * This is what lets a fault be cleared at all. A fault is never cleared in place — the
   * index refuses for as long as it lives — so repairing means replacing the object the
   * context holds, and only the code that built it knows what to build it from.
   */
  reopenSearchIndex(): Promise<SearchIndex>;
  /**
   * Keeps `capabilities.localApi` live rather than frozen at what the startup probe saw.
   * Optional so a hand-built test context need not supply one; where it is absent the
   * capability simply stays as it was set.
   */
  localStatus?: LocalApiStatus;
  /** Release update check (operator context only); zotero_whoami surfaces its result. */
  updates?: UpdateChecker;
  /** Lightweight catalog of all registered tools (for search_tools discovery). */
  toolCatalog?: Array<{ name: string; title: string; description: string; deferLoading?: boolean }>;
}

/**
 * How a registered handler reaches its context: the built context itself, or a thunk that
 * resolves it. The thunk form is what lets a transport connect — and answer `initialize` —
 * before the (slow) context build has finished; see createDeferredServer.
 */
export type ToolContextSource = ToolContext | (() => Promise<ToolContext>);

export function resolveContext(source: ToolContextSource): Promise<ToolContext> {
  return typeof source === 'function' ? source() : Promise.resolve(source);
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
 * Resolve the library a WRITE should target on the cloud Web API. Group libraries (and
 * any library the running desktop app cannot reach) are cloud-only, so this throws a
 * friendly error when no API key is configured. The thrown message is surfaced to the
 * model as an isError result.
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
        'For the personal library, writes can instead go through the running Zotero 10+ desktop app (local API).',
    );
  }
  return { type: 'user', id: cloud.userID };
}

export function registerAllTools(
  server: McpServer,
  defs: ToolDefinition[],
  source: ToolContextSource,
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
        // Resolved inside the handler, not at registration: with a deferred context this
        // is where the call waits for the build (and where a failed build is retried).
        let ctx: ToolContext | undefined;
        try {
          ctx = await resolveContext(source);
          // Every tool gets a current answer about the desktop app, because the startup
          // probe's answer is a function of launch order and nothing else (#22). Costs a
          // boolean where no desktop app can apply (hosted per-user contexts), a clock
          // comparison while the cached answer is fresh, and at most one bounded loopback
          // connect per TTL window otherwise, shared across concurrent calls.
          await ctx.localStatus?.ensure();
          return await def.handler(args, ctx);
        } catch (err) {
          const message =
            err instanceof ZoteroApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          ctx?.logger.error(`Tool ${def.name} failed:`, message);
          return { content: [{ type: 'text' as const, text: message }], isError: true };
        }
      },
    );
  }
}


/**
 * True when a local-API write failure means the running Zotero simply does not have
 * (or accept) local writes — i.e. Zotero 9 and earlier, whose local API is GET-only, so
 * write paths answer "No endpoint found" (404) or 501 "Endpoint does not support
 * method" and no response carries a Zotero-Server-ID header — as opposed to a real
 * write failure (denied grant, validation error, stale version). Callers use this to
 * fall back to the connector protocol or the cloud Web API.
 */
export function isLocalWritesUnavailable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /local api/i.test(msg) &&
    /404|no endpoint|not implemented|not supported|does not support|unreachable/i.test(msg)
  );
}


/**
 * A current answer to "is the desktop app reachable", for the write paths that must not
 * act on a stale one. Delegates to `LocalApiStatus`, which caches, backs off and shares
 * one in-flight probe; the inline path below is the fallback for a context built without
 * one (hand-made test fixtures).
 *
 * The group list travels with it: the startup probe skips it whenever the app was down,
 * leaving `localGroupIds` frozen at []. A keyless local-only user who starts Zotero after
 * the server would otherwise never reach a group the desktop holds, since the router keeps
 * routing it to a cloud API that has no key.
 */
export async function ensureLocalApi(ctx: ToolContext): Promise<boolean> {
  if (ctx.localStatus) return ctx.localStatus.ensure();
  if (ctx.capabilities.localApi) return true;
  if (!ctx.local || ctx.config.local === 'off') return false;
  const up = await ctx.local.ping().catch(() => false);
  if (up) {
    ctx.capabilities.localApi = true;
    ctx.capabilities.localGroupIds = await ctx.local.listLocalGroupIds().catch(() => []);
  }
  return up;
}
