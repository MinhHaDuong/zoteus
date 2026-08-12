import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { markInLibrary, type ScholarWork } from '../features/scholar/graph.js';

const MAX_LIB_ITEMS = 5000;

async function libraryDoiSet(ctx: ToolContext): Promise<Set<string>> {
  const set = new Set<string>();
  let start = 0;
  for (;;) {
    const page = await ctx.router.searchItems({ limit: 100, start });
    for (const it of page.data) {
      const doi = (it as any).data?.DOI ?? (it as any).DOI;
      if (doi) set.add(String(doi).toLowerCase());
    }
    start += page.data.length;
    if (!page.data.length || start >= page.totalResults || start >= MAX_LIB_ITEMS) break;
  }
  return set;
}

const scholar: ToolDefinition = {
  name: 'zotero_scholar',
  title: 'Scholarly context (references, citations, related)',
  description:
    'Explore the EXTERNAL scholarly graph around a paper (OpenAlex, Crossref fallback). This does NOT search, list, or read your Zotero library — it queries the open web, and results are works from the scholarly web, not your items. To search or inspect YOUR library use zotero_search_items, zotero_semantic_search, zotero_get_item, or zotero_list_tags instead. Provide a `doi` and an `action`: "lookup" (metadata + citation count), "references" (works this paper cites), "citations" (works that cite this paper, most-cited first), or "related" (similar works). Set `include_in_library: true` to additionally flag which results your library already holds (off by default because it scans the library); otherwise every result is just a web record. `limit` caps results (default 20). Read-only; calls external scholarly APIs.',
  inputSchema: {
    action: z.enum(['lookup', 'references', 'citations', 'related']),
    doi: z.string().describe('The DOI of the paper (with or without the https://doi.org/ prefix).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20).'),
    include_in_library: z.boolean().optional().describe('Also scan the library and flag results already saved (default false; scanning is expensive).'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const limit = args.limit ?? 20;
    let primary: ScholarWork | null = null;
    let results: ScholarWork[] = [];

    switch (args.action) {
      case 'lookup':
        primary = await ctx.scholar.lookup(args.doi);
        if (!primary) {
          return { content: [{ type: 'text', text: `No scholarly record found for DOI ${args.doi}.` }], isError: true };
        }
        break;
      case 'references':
        results = await ctx.scholar.references(args.doi, limit);
        break;
      case 'citations':
        results = await ctx.scholar.citations(args.doi, limit);
        break;
      case 'related':
        results = await ctx.scholar.related(args.doi, limit);
        break;
    }

    const canMatch = ctx.capabilities.cloud != null || ctx.capabilities.localApi;
    // Opt-in (default false): the library scan pages every item, so only pay for it
    // when the caller explicitly wants inLibrary flags.
    if (args.include_in_library === true && canMatch) {
      const dois = await libraryDoiSet(ctx);
      if (primary) primary = markInLibrary([primary], dois)[0]!;
      results = markInLibrary(results, dois);
    }

    if (args.action === 'lookup') {
      return ok({ action: args.action, work: primary }, `${primary!.title ?? args.doi} — ${primary!.citationCount ?? 0} citations.`);
    }
    const inLib = results.filter((w) => w.inLibrary).length;
    const summary = `${results.length} ${args.action} for ${args.doi}` +
      (args.include_in_library === true && canMatch ? ` (${inLib} already in your library, ${results.length - inLib} not).` : '.');
    return ok({ action: args.action, doi: args.doi, results, count: results.length, inLibrary: args.include_in_library === true ? inLib : undefined }, summary);
  },
};

export default scholar;
