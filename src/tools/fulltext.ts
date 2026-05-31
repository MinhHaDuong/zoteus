import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const fulltext: ToolDefinition = {
  name: 'zotero_fulltext',
  title: 'Attachment full-text',
  description:
    "Not a search — to find which items contain a term, use `zotero_search_items` with qmode=everything. This reads, sets, or tracks one attachment's already-extracted full text by key. `action`: \"get\" returns the indexed text content plus indexing stats for an attachment item (only attachment items have full text; returns found:false if none); \"set\" stores extracted text for an attachment (provide `content` and the indexing counts); \"since\" returns the map of attachment keys whose full text changed after a given library `version` (useful for incremental indexing). Only attachment items support full text. \"set\" writes via the cloud Web API.",
  inputSchema: {
    action: z.enum(['get', 'set', 'since']),
    item_key: z.string().optional().describe('Attachment item key (get/set).'),
    since: z.number().int().optional().describe('Library version for "since" (default 0).'),
    content: z.string().optional().describe('Extracted text (set).'),
    indexed_chars: z.number().int().optional(),
    total_chars: z.number().int().optional(),
    indexed_pages: z.number().int().optional(),
    total_pages: z.number().int().optional(),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const readLib = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : ctx.router.defaultLibrary();

    if (args.action === 'get') {
      if (!args.item_key) return err('`item_key` is required for get.');
      const ft = await ctx.web.getFullText(readLib, args.item_key);
      if (!ft) return ok({ found: false, item_key: args.item_key }, `No extracted full text for ${args.item_key}.`);
      const length = typeof ft.content === 'string' ? ft.content.length : 0;
      return ok({ found: true, ...ft }, `Full text for ${args.item_key}: ${length} characters.`);
    }

    if (args.action === 'since') {
      const map = await ctx.web.fullTextSince(readLib, args.since ?? 0);
      return ok({ changed: map, count: Object.keys(map).length }, `${Object.keys(map).length} attachment(s) with full-text changes since v${args.since ?? 0}.`);
    }

    // set
    if (!args.item_key || args.content == null) return err('`item_key` and `content` are required for set.');
    const lib = requireCloudLibrary(ctx, args);
    await ctx.web.setFullText(lib, args.item_key, {
      content: args.content,
      indexedChars: args.indexed_chars,
      totalChars: args.total_chars,
      indexedPages: args.indexed_pages,
      totalPages: args.total_pages,
    });
    return ok({ item_key: args.item_key, length: args.content.length }, `Set full text for ${args.item_key}.`);
  },
};

export default fulltext;
