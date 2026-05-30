import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const MAX_LIMIT = 100;

export function creatorSummary(creators: Array<{ lastName?: string; name?: string }> = []): string {
  const names = creators.map((c) => c.lastName ?? c.name).filter(Boolean) as string[];
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(' & ');
  return `${names[0]} et al.`;
}

function project(item: any, detailed: boolean): Record<string, unknown> {
  const d = item.data ?? item;
  const base: Record<string, unknown> = {
    key: item.key ?? d.key,
    itemType: d.itemType,
    title: d.title ?? d.caseName ?? d.subject ?? '(untitled)',
    creatorSummary: creatorSummary(d.creators),
    date: d.date,
  };
  if (detailed) {
    base.version = item.version ?? d.version;
    base.tags = (d.tags ?? []).map((t: any) => t.tag);
    base.collections = d.collections ?? [];
    base.DOI = d.DOI;
    base.url = d.url;
  }
  return base;
}

const searchItems: ToolDefinition = {
  name: 'zotero_search_items',
  title: 'Search Zotero items',
  description:
    'Search or list items in a Zotero library or collection. Supports full-text/quick search via `q` (`qmode`: titleCreatorYear=default, everything=includes notes & attachment full text), boolean `itemType` filters (use `||` for OR, repeat or `&&` for AND, leading `-` to negate, e.g. "journalArticle || book", "-attachment"), boolean `tag` filters (same syntax; escape a literal leading hyphen as "\\-"), `since` (version) for incremental queries, `sort`/`direction`, and `limit`/`start` paging. Set `response_format` to "detailed" to also return technical fields (version, tags, collections, DOI, url) needed before chaining a write; the default "concise" returns high-signal projections (key, itemType, title, creators, date). Reads are served from the fast desktop local API when available, otherwise the cloud Web API. Returns `totalResults` so you can tell when to page rather than assuming you saw everything. For conceptual/"papers about X" queries by meaning rather than exact fields, use zotero_semantic_search instead.',
  inputSchema: {
    q: z.string().optional().describe('Quick/full-text search string.'),
    qmode: z.enum(['titleCreatorYear', 'everything']).optional(),
    itemType: z.string().optional().describe('Boolean itemType filter, e.g. "journalArticle || book".'),
    tag: z.string().optional().describe('Boolean tag filter, e.g. "to-read && 2024".'),
    collectionKey: z.string().optional().describe('Restrict to a collection by key.'),
    top: z.boolean().optional().describe('Only top-level items (exclude child notes/attachments).'),
    since: z.number().int().optional().describe('Return items modified after this library version.'),
    includeTrashed: z.boolean().optional(),
    sort: z.string().optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max items (default 25, max 100).'),
    start: z.number().int().min(0).optional(),
    response_format: z.enum(['concise', 'detailed']).optional().describe('Detail level of returned items.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const detailed = args.response_format === 'detailed';
    const library = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    const result = await ctx.router.searchItems({
      q: args.q,
      qmode: args.qmode,
      itemType: args.itemType,
      tag: args.tag,
      collectionKey: args.collectionKey,
      top: args.top,
      since: args.since,
      includeTrashed: args.includeTrashed,
      sort: args.sort,
      direction: args.direction,
      limit: args.limit ?? 25,
      start: args.start,
      library,
    });
    const items = result.data.map((i) => project(i, detailed));
    const shown = items.length;
    const summary =
      `Found ${result.totalResults} item(s); showing ${shown}.` +
      (result.totalResults > shown + (args.start ?? 0)
        ? ' More available — narrow with q/tag/itemType or page with start.'
        : '');
    return ok(
      { items, totalResults: result.totalResults, libraryVersion: result.lastModifiedVersion },
      summary,
    );
  },
};

export default searchItems;
