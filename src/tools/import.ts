import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult, ToolContext } from '../registry/registry.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { arxivItem, fromScholarWork, parseIdentifier, bareDoi, type ResolvedItem } from '../features/resolve/resolve.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Built-in resolution fallback used when no translation-server is reachable.
 * Handles arXiv ids (direct Atom fetch) and DOIs (OpenAlex primary, Crossref
 * fallback — the same scholar providers zotero_scholar uses). ISBN/PMID/
 * bibcodes and web URLs cannot be resolved server-side and return a clear error.
 */
async function resolveBuiltin(ctx: ToolContext, id: string): Promise<{ items: ResolvedItem[]; source: string }> {
  const parsed = parseIdentifier(id);
  if (!parsed) {
    throw new Error(
      `Could not parse "${id}" as a known identifier. Try a DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode — or start a translation-server for URL imports.`,
    );
  }
  switch (parsed.type) {
    case 'arxiv': {
      const item = await arxivItem(parsed.value, (url, init) => ctx.fetcher.fetch(url, init, { maxRetries: 0, deadlineMs: 60_000 }));
      if (!item) throw new Error(`arXiv returned no record for "${parsed.value}".`);
      return { items: [item], source: 'arxiv' };
    }
    case 'doi': {
      const doi = bareDoi(parsed.value);
      const work = await ctx.scholar.lookup(doi);
      if (!work) throw new Error(`No scholarly record found for DOI "${doi}".`);
      return { items: [fromScholarWork(work, doi)], source: 'scholar' };
    }
    case 'pmid':
      throw new Error(`PMID resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    case 'isbn':
      throw new Error(`ISBN resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    case 'bibcode':
      throw new Error(`ADS bibcode resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    default:
      throw new Error(`Unsupported identifier type "${parsed.type}".`);
  }
}

const importTool: ToolDefinition = {
  name: 'zotero_import',
  title: 'Import items by identifier or URL',
  description:
    'Resolve bibliographic metadata to Zotero item-data and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`); `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items (requires a cloud API key); otherwise the resolved metadata is returned without saving. When a Zotero translation-server is reachable (ZOTEUS_TRANSLATION_SERVER_URL, default http://127.0.0.1:1969) it is the primary path; if none is running, DOI and arXiv ids fall back to built-in resolution (OpenAlex/Crossref and the arXiv API respectively) — the result then carries a `source` field ("scholar" or "arxiv"). ISBN/PMID/bibcode and web URLs require a translation-server.',
  inputSchema: {
    action: z.enum(['by_identifier', 'by_url']),
    identifier: z.string().optional().describe('DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode.'),
    url: z.string().optional().describe('Web page URL to scrape (needs a translation-server).'),
    save_to_library: z.boolean().optional().describe('Persist the resolved items (needs a cloud key).'),
    collection_key: z.string().optional().describe('Collection to add saved items to.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const tsUp = await ctx.translation.isUp();
    if (!tsUp && !args.identifier) {
      // A URL with no translation-server is unresolvable server-side; say so plainly.
      if (args.action === 'by_url') {
        return err(
          `No Zotero translation-server reachable at ${ctx.config.translationServerUrl}, and URL scraping has no built-in fallback. Start one with \`docker run -d -p 1969:1969 zotero/translation-server\` (or set ZOTEUS_TRANSLATION_SERVER_URL), then retry.`,
        );
      }
      return err(
        `No Zotero translation-server reachable at ${ctx.config.translationServerUrl}. DOI/arXiv ids can still be resolved via built-in fallbacks; ISBN/PMID/bibcode and URLs need the server (start it with \`docker run -d -p 1969:1969 zotero/translation-server\`, or set ZOTEUS_TRANSLATION_SERVER_URL).`,
      );
    }
    if (args.action === 'by_identifier') {
      if (!args.identifier) return err('`identifier` is required for by_identifier.');
      if (tsUp) {
        const items = await ctx.translation.search(args.identifier);
        if (items.length) return maybeSave(ctx, args, items, 'translation-server');
      }
      // translation-server down (or the identifier failed): try the built-in path.
      try {
        const { items, source } = await resolveBuiltin(ctx, args.identifier);
        return maybeSave(ctx, args, items, source);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
    // by_url
    if (!args.url) return err('`url` is required for by_url.');
    const result = await ctx.translation.web(args.url);
    if (result.multiple) {
      return ok(
        { multiple: result.multiple },
        `The page offers multiple items. Inspect "multiple.items" (key->label) and re-run with a more specific URL, or save a chosen item.`,
      );
    }
    const items = result.items ?? [];
    if (!items.length) return err(`No items found at ${args.url}.`);
    return maybeSave(ctx, args, items, 'translation-server');
  },
};

/** Save resolved items, tagging the resolution source for provenance. */
async function maybeSave(ctx: ToolContext, args: any, items: any[], source: string): Promise<ToolHandlerResult> {
  const tagged = items.map((it) => ({
    ...it,
    extra: [it?.extra, `resolved:${source}`].filter(Boolean).join('\n'),
  }));
  const payload = tagged;
  if (!args.save_to_library) {
    return ok(
      { items: payload, count: payload.length, saved: false, source },
      `Resolved ${payload.length} item(s) via ${source} (not saved to library).`,
    );
  }
  const lib = requireCloudLibrary(ctx, args);
  if (args.collection_key) {
    for (const it of payload) it.collections = [...(it.collections ?? []), args.collection_key];
  }
  const result = await ctx.web.writeItems(lib, payload);
  return ok(
    { created: result.successful.map((s) => s.key), failed: result.failed, resolved: payload.length, source },
    `Imported ${result.successful.length} of ${payload.length} resolved item(s) via ${source} into the library.`,
  );
}

export default importTool;
