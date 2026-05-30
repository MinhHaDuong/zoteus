import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { saveIndex } from '../features/search/persistence.js';
import type { LibraryRef } from '../api/web-client.js';

const MAX_ITEMS = 5000;

async function fetchAllItems(ctx: ToolContext, lib: LibraryRef): Promise<any[]> {
  const all: any[] = [];
  let start = 0;
  for (;;) {
    const page = await ctx.web.listItems(lib, { limit: 100, start, top: true });
    all.push(...page.data);
    start += page.data.length;
    if (page.data.length === 0 || all.length >= page.totalResults || all.length >= MAX_ITEMS) break;
  }
  return all;
}

const indexTool: ToolDefinition = {
  name: 'zotero_index',
  title: 'Build the semantic search index',
  description:
    "Build, refresh, or report the status of the local hybrid-search index used by zotero_semantic_search. `action: \"build\"` (or \"refresh\") fetches the library's top-level items and indexes their text (title, abstract, creators, tags) for BM25 keyword search and — if an embedding provider is configured — vector search; the index is persisted under the Zoteus data dir. `action: \"status\"` reports the index size and which embedder is active (it falls back to keyword-only when no local model or embedding API is available). Run a build before semantic searching, and refresh after large library changes.",
  inputSchema: {
    action: z.enum(['build', 'refresh', 'status']),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'status') {
      const s = ctx.search.status();
      return ok({ ...s }, `Index: ${s.documents} passages over ${s.items} items; embedder=${s.embedder}.`);
    }
    const lib = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : ctx.router.defaultLibrary();
    const items = await fetchAllItems(ctx, lib);
    const status = await ctx.search.build(items, { version: items.length });
    await saveIndex(ctx.search, ctx.searchIndexPath).catch((e) =>
      ctx.logger.warn(`Could not persist index: ${e instanceof Error ? e.message : String(e)}`),
    );
    return ok(
      { ...status },
      `Indexed ${status.documents} passages over ${status.items} items (embedder=${status.embedder}).`,
    );
  },
};

export default indexTool;
