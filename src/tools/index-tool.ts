import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { progressLine, startIndexBuild, statusSummary } from '../features/search/build.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from '../features/search/fulltext-source.js';
import type { LibraryRef } from '../api/web-client.js';

const indexTool: ToolDefinition = {
  name: 'zotero_index',
  title: 'Build the semantic search index',
  description:
    "Manage the local hybrid-search index used by zotero_semantic_search. The build runs as a background job on the server, so this tool returns immediately — never blocks on large libraries. `action: \"build\"` (or \"refresh\") starts a background build: it pages the library's top-level items (100-at-a-time, capped at 5000 items unless a smaller `limit` is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and — if an embedding provider is configured — vector search, persisting partial progress atomically as it goes. Set `fulltext:true` to ALSO index the body text Zotero extracted from each item's attachments, which is what makes semantic search match a claim buried in a PDF rather than only its title and abstract; it is off by default because it multiplies build time and index size (default cap: 40000 characters per item, tunable with `fulltext_max_chars`), and only attachments Zotero has already extracted are available. Start a build, then POLL `action: \"status\"` every few seconds until `state` is \"done\" (or \"error\"); calling build again while one is running just returns current progress. `action: \"status\"` reports the build state (idle|building|done|error), fetch/embed progress, index size, the active embedder, and (when full text was requested) `fulltextItems`/`fulltextPassages` plus `fulltextReason` if it produced nothing. `action: \"stop\"` cancels a running build (partial data is kept and stays searchable). A partially built index is always usable for keyword search. Local embeddings are CPU-bound (see ZOTEUS_EMBEDDINGS), so large builds take a while — poll status rather than retrying build.",
  inputSchema: {
    action: z.enum(['build', 'refresh', 'status', 'stop']),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Max items to index. Lowers the configured cap for this build only; it cannot raise it. ' +
          'The cap defaults to 5000 and is set by ZOTEUS_INDEX_MAX_ITEMS.',
      ),
    fulltext: z
      .boolean()
      .optional()
      .describe(
        'Also index the full text Zotero extracted from each item\'s attachments, so searches match the body of a PDF. ' +
          'Resource-intensive (slower build, much larger index); defaults to ZOTEUS_INDEX_FULLTEXT (off unless set).',
      ),
    fulltext_max_chars: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe(
        `Cap on indexed full-text characters per item; 0 means no cap (default ${DEFAULT_FULLTEXT_MAX_CHARS}). Only used with fulltext.`,
      ),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'status') {
      const s = ctx.search.buildStatus();
      return ok({ ...s }, statusSummary(s));
    }
    if (args.action === 'stop') {
      const stopped = ctx.search.requestStop();
      if (stopped) {
        return ok(
          { ...ctx.search.buildStatus() },
          'Stop requested — the build halts after the current page/batch and keeps the partial index. Poll action:"status".',
        );
      }
      return ok({ ...ctx.search.buildStatus() }, 'No build is currently running.');
    }

    // build / refresh: kick off a background job and return immediately.
    if (ctx.search.isBuilding) {
      const s = ctx.search.buildStatus();
      return ok(
        { ...s },
        `A build is already in progress — ${progressLine(s)}. Poll action:"status" instead of starting another build.`,
      );
    }
    const lib: LibraryRef | undefined = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    const maxItems = Math.min(args.limit ?? ctx.config.indexMaxItems, ctx.config.indexMaxItems);
    const fulltext = args.fulltext ?? ctx.config.indexFulltext;
    const s = startIndexBuild(ctx, lib, maxItems, {
      fulltext,
      fulltextMaxChars: args.fulltext_max_chars,
    });
    const ftNote = fulltext
      ? ' Attachment full text is included, so expect a noticeably longer build and a larger index.'
      : '';
    return ok(
      { ...s },
      `Index build started in the background (up to ${maxItems} items).${ftNote} ` +
        'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.',
    );
  },
};

export default indexTool;
