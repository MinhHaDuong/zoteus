import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const semanticSearch: ToolDefinition = {
  name: 'zotero_semantic_search',
  title: 'Semantic / hybrid library search',
  description:
    'Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). Requires the index to be built first with zotero_index (action:"build"); if it is empty, this returns guidance to build it. For exact field/tag/itemType filtering use zotero_search_items instead; use this for conceptual/"papers about X" queries. To read the actual passages of a found item (with page locators) use zotero_get_fulltext.',
  inputSchema: {
    q: z.string().min(1).describe('Natural-language query.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
    mode: z.enum(['auto', 'keyword', 'semantic']).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (ctx.search.isEmpty) {
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
