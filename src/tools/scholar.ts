import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { markInLibrary, type ScholarList } from '../features/scholar/graph.js';

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
    'Explore the EXTERNAL scholarly graph around a paper (OpenAlex, Crossref fallback). This does NOT search, list, or read your Zotero library — it queries the open web, and results are works from the scholarly web, not your items. To search or inspect YOUR library use zotero_search_items, zotero_semantic_search, zotero_get_item, or zotero_list_tags instead. Provide a `doi` and an `action`: "lookup" (metadata + citation count), "references" (works this paper cites), "citations" (works that cite this paper, most-cited first), or "related" (similar works). Set `include_in_library: true` to additionally flag which results your library already holds (off by default because it scans the library); otherwise every result is just a web record. `limit` caps results (default 20); every list answer also carries `total`, the size of the list the results were cut from, and `truncated: true` when the limit dropped some, so a review with 150 references never looks like one with 20. Read-only; calls external scholarly APIs. This is a thin citation-graph helper around a single DOI: for full OpenAlex querying (keyword search, filters, paging, `select`) call https://api.openalex.org directly, see the LLM quick reference in the OpenAlex help pages.',
  inputSchema: {
    action: z.enum(['lookup', 'references', 'citations', 'related']),
    doi: z.string().describe('The DOI of the paper (with or without the https://doi.org/ prefix).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20). The answer says how many there were in total.'),
    include_in_library: z.boolean().optional().describe('Also scan the library and flag results already saved (default false; scanning is expensive).'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const limit = args.limit ?? 20;

    if (args.action === 'lookup') {
      let primary = await ctx.scholar.lookup(args.doi);
      if (!primary) {
        return { content: [{ type: 'text', text: `No scholarly record found for DOI ${args.doi}.` }], isError: true };
      }
      const canMatch = ctx.capabilities.cloud != null || ctx.capabilities.localApi;
      if (args.include_in_library === true && canMatch) {
        primary = markInLibrary([primary], await libraryDoiSet(ctx))[0]!;
      }
      return ok({ action: args.action, work: primary }, `${primary.title ?? args.doi} — ${primary.citationCount ?? 0} citations.`);
    }

    const list: ScholarList =
      args.action === 'references'
        ? await ctx.scholar.references(args.doi, limit)
        : args.action === 'citations'
          ? await ctx.scholar.citations(args.doi, limit)
          : await ctx.scholar.related(args.doi, limit);
    let results = list.works;

    const canMatch = ctx.capabilities.cloud != null || ctx.capabilities.localApi;
    // Opt-in (default false): the library scan pages every item, so only pay for it
    // when the caller explicitly wants inLibrary flags.
    if (args.include_in_library === true && canMatch) {
      results = markInLibrary(results, await libraryDoiSet(ctx));
    }

    // The count the list was cut from rides along with the page, so twenty references out
    // of a hundred and fifty read as exactly that and not as the whole list (#76).
    const truncated = list.total > results.length;
    const shown = truncated ? `${results.length} of ${list.total}` : `${results.length}`;
    const inLib = results.filter((w) => w.inLibrary).length;
    const summary = `${shown} ${args.action} for ${args.doi}` +
      (args.include_in_library === true && canMatch ? ` (${inLib} already in your library, ${results.length - inLib} not).` : '.');
    return ok(
      {
        action: args.action,
        doi: args.doi,
        results,
        count: results.length,
        total: list.total,
        truncated,
        inLibrary: args.include_in_library === true ? inLib : undefined,
      },
      summary,
    );
  },
};

export default scholar;
