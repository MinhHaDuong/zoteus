import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { MAX_ITEMS, progressLine, startIndexBuild, statusSummary } from '../features/search/build.js';
import type { LibraryRef } from '../api/web-client.js';

const indexTool: ToolDefinition = {
  name: 'zotero_index',
  title: 'Build the semantic search index',
  description:
    "Manage the local hybrid-search index used by zotero_semantic_search. The build runs as a background job on the server, so this tool returns immediately — never blocks on large libraries. `action: \"build\"` (or \"refresh\") starts a background build: it pages the library's top-level items (100-at-a-time, capped at 5000 items unless a smaller `limit` is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and — if an embedding provider is configured — vector search, persisting partial progress atomically as it goes. Start a build, then POLL `action: \"status\"` every few seconds until `state` is \"done\" (or \"error\"); calling build again while one is running just returns current progress. `action: \"status\"` reports the build state (idle|building|done|error), fetch/embed progress, index size and the active embedder. `action: \"stop\"` cancels a running build (partial data is kept and stays searchable). A partially built index is always usable for keyword search. Local embeddings are CPU-bound (see ZOTEUS_EMBEDDINGS), so large builds take a while — poll status rather than retrying build.",
  inputSchema: {
    action: z.enum(['build', 'refresh', 'status', 'stop']),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ITEMS)
      .optional()
      .describe(`Max items to index (default ${MAX_ITEMS}, which is also the hard cap).`),
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
    const maxItems = Math.min(args.limit ?? MAX_ITEMS, MAX_ITEMS);
    const s = startIndexBuild(ctx, lib, maxItems);
    return ok(
      { ...s },
      `Index build started in the background (up to ${maxItems} items). ` +
        'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.',
    );
  },
};

export default indexTool;
