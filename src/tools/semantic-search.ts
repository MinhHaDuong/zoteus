import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { progressLine, startIndexBuild } from '../features/search/build.js';

const semanticSearch: ToolDefinition = {
  name: 'zotero_semantic_search',
  title: 'Semantic / hybrid library search',
  description:
    'Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). The index must be built once before first use: when it is empty this tool starts a background build automatically (`auto_build`, on by default) and tells you to poll zotero_index action:"status" and retry — pass `auto_build:false` to opt out. For exact field/tag/itemType filtering use zotero_search_items instead; use this for conceptual/"papers about X" queries. To read the actual passages of a found item (with page locators) use zotero_get_fulltext.',
  inputSchema: {
    q: z.string().min(1).describe('Natural-language query.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
    mode: z.enum(['auto', 'keyword', 'semantic']).optional(),
    auto_build: z
      .boolean()
      .optional()
      .describe('Start building the index automatically in the background when it is empty (default true).'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (ctx.search.isEmpty) {
      // A build is already on its way (started here or via zotero_index): report progress.
      if (ctx.search.isBuilding) {
        const s = ctx.search.buildStatus();
        return {
          content: [
            {
              type: 'text',
              text:
                `The semantic-search index is being built right now — ${progressLine(s)}. ` +
                'Poll zotero_index with action:"status" until state is "done", then retry this search.',
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      if (args.auto_build !== false) {
        // First use: populate the index on the fly instead of leaving the user stranded.
        const s = startIndexBuild(ctx);
        return {
          content: [
            {
              type: 'text',
              text:
                'The semantic-search index is empty, so a background build was started automatically ' +
                `(first-time setup; ${progressLine(s)}). Poll zotero_index with action:"status" every few seconds ` +
                'until state is "done", then retry this search. Pass auto_build:false to opt out.',
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: 'The search index is empty. Run zotero_index with action:"build" first, then retry.',
          },
        ],
        isError: true,
      };
    }
    const hits = await ctx.search.query(args.q, { limit: args.limit ?? 10, mode: args.mode });
    const summary = hits.length
      ? `Top ${hits.length} match(es) for "${args.q}" (${ctx.search.embedderName}).`
      : `No matches for "${args.q}".`;
    return ok({ hits, embedder: ctx.search.embedderName }, summary);
  },
};

export default semanticSearch;
