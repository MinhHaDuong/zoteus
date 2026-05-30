import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import { rankPassages, approxPage, type Passage } from '../features/fulltext/passages.js';
import { extractPdfPages, locatePage } from '../features/fulltext/pdf-pages.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

interface Resolved {
  attachmentKey: string;
  parentKey?: string;
  filename?: string;
  title?: string;
}

async function resolveAttachment(
  ctx: ToolContext,
  itemKey: string,
  library: LibraryRef | undefined,
): Promise<Resolved | { error: string }> {
  const item = await ctx.router.getItem(itemKey, { library });
  const d = item?.data ?? item ?? {};
  if (d.itemType === 'attachment') {
    return { attachmentKey: itemKey, parentKey: d.parentItem, filename: d.filename, title: d.title };
  }
  const children = await ctx.router.getItemChildren(itemKey, { library });
  const atts = (children.data ?? []).filter((c: any) => (c.data?.itemType ?? c.itemType) === 'attachment');
  const pdf = atts.find((c: any) => (c.data?.contentType ?? c.contentType) === 'application/pdf');
  const chosen = pdf ?? atts[0];
  if (!chosen) return { error: `Item ${itemKey} has no attachment with full text. Attach a PDF in Zotero.` };
  const cd = chosen.data ?? chosen;
  return { attachmentKey: chosen.key ?? cd.key, parentKey: itemKey, filename: cd.filename, title: d.title };
}

function parseRange(range: string): { from: number; to: number } | undefined {
  const m = range.match(/^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from > 0 && to >= from ? { from, to } : undefined;
}

const getFulltext: ToolDefinition = {
  name: 'zotero_get_fulltext',
  title: 'Get attachment full text / passages (read-only)',
  description:
    "Retrieve an item's PDF text for grounding. Pass a parent `item_key` (its best PDF attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. \"3-7\"), returns that span; with neither, returns a truncated head. Page numbers are an estimate (pageApprox) unless `precise_pages:true`, which re-extracts the PDF for exact pages when possible (otherwise it degrades to approximate with a notice). Read-only; cloud full text. Use this to cite a claim with a page after finding an item via zotero_search_items / zotero_semantic_search.",
  inputSchema: {
    item_key: z.string().describe('Parent item key or attachment key.'),
    query: z.string().optional().describe('Return top passages relevant to this query.'),
    page_range: z.string().optional().describe('Page span like "3-7" (1-based, inclusive).'),
    max_passages: z.number().int().min(1).max(20).optional().describe('Max passages (default 5).'),
    max_chars: z.number().int().min(500).max(100000).optional().describe('Cap on total returned text (default 12000).'),
    precise_pages: z.boolean().optional().describe('Re-extract the PDF for exact page numbers.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const library: LibraryRef | undefined = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    const lib = library ?? ctx.router.defaultLibrary();

    const resolved = await resolveAttachment(ctx, args.item_key, library);
    if ('error' in resolved) return err(resolved.error);

    const ft = await ctx.web.getFullText(lib, resolved.attachmentKey);
    if (!ft || typeof ft.content !== 'string' || !ft.content.length) {
      return err(
        `No extracted full text for attachment ${resolved.attachmentKey}. Zotero may not have indexed it yet (open it once in Zotero, or check it is a text PDF).`,
      );
    }
    const content: string = ft.content;
    const totalChars: number = typeof ft.totalChars === 'number' && ft.totalChars > 0 ? ft.totalChars : content.length;
    const totalPages: number | undefined = typeof ft.totalPages === 'number' ? ft.totalPages : undefined;
    const maxChars = args.max_chars ?? 12000;

    const base = {
      item_key: args.item_key,
      attachmentKey: resolved.attachmentKey,
      parentKey: resolved.parentKey,
      filename: resolved.filename,
      title: resolved.title,
      totalChars,
      totalPages,
      indexedChars: ft.indexedChars,
      indexedPages: ft.indexedPages,
    };

    // Optionally pull exact pages once (shared by passages / page_range).
    let pages: string[] | null = null;
    if (args.precise_pages) {
      try {
        const dl = await ctx.web.downloadFileBytes(lib, resolved.attachmentKey);
        pages = await extractPdfPages(dl.bytes);
      } catch {
        pages = null;
      }
    }
    const exact = Boolean(pages && pages.length);
    const pageSource = args.precise_pages ? (exact ? 'exact' : 'approximate') : 'approximate';
    const degradeNotice =
      args.precise_pages && !exact
        ? ' Exact pages unavailable (PDF bytes or the optional pdfjs-dist parser missing); pageApprox is an estimate.'
        : '';

    // --- passages mode ---
    if (args.query) {
      const maxPassages = args.max_passages ?? 5;
      const ranked: Passage[] = await rankPassages({
        content,
        query: args.query,
        maxPassages,
        totalChars,
        totalPages,
        embed: ctx.search.hasEmbedder ? (texts) => ctx.search.embed(texts) : undefined,
      });
      let used = 0;
      let truncated = false;
      const passages: Passage[] = [];
      for (const p of ranked) {
        if (used + p.text.length > maxChars && passages.length) {
          truncated = true;
          break;
        }
        if (exact) {
          const pg = locatePage(pages!, p.text);
          if (pg) p.page = pg;
          else p.pageApprox = approxPage(p.charStart, totalChars, totalPages);
        }
        passages.push(p);
        used += p.text.length;
      }
      const summary =
        `${passages.length} passage(s) for "${args.query}" in ${args.item_key}` +
        (totalPages ? ` (${pageSource} pages).` : '.') +
        (truncated ? ' Some lower-ranked passages omitted (max_chars).' : '') +
        degradeNotice;
      return ok({ ...base, mode: 'passages', pageSource, passages, truncated, notice: degradeNotice.trim() || undefined }, summary);
    }

    // --- page_range mode ---
    if (args.page_range) {
      const r = parseRange(args.page_range);
      if (!r) return err('`page_range` must look like "3" or "3-7".');
      let slice: string;
      if (exact && pages) {
        slice = pages.slice(r.from - 1, r.to).join('\n\n');
      } else if (totalPages) {
        const s = Math.floor(((r.from - 1) / totalPages) * totalChars);
        const e = Math.ceil((r.to / totalPages) * totalChars);
        slice = content.slice(Math.max(0, s), Math.min(content.length, e));
      } else {
        slice = content;
      }
      const truncated = slice.length > maxChars;
      const text = truncated ? slice.slice(0, maxChars) : slice;
      return ok(
        {
          ...base,
          mode: 'page_range',
          pageSource,
          page_range: args.page_range,
          text,
          truncated,
          omittedChars: truncated ? slice.length - maxChars : 0,
          notice: degradeNotice.trim() || undefined,
        },
        `Text for pages ${args.page_range} of ${args.item_key} (${pageSource}).` +
          (truncated ? ' Truncated (max_chars).' : '') +
          degradeNotice,
      );
    }

    // --- document mode ---
    const truncated = content.length > maxChars;
    const text = truncated ? content.slice(0, maxChars) : content;
    const notice = truncated
      ? `Truncated to ${maxChars} of ${content.length} chars — pass query (for relevant passages), page_range, or a larger max_chars.`
      : undefined;
    return ok(
      { ...base, mode: 'document', pageSource, text, truncated, omittedChars: truncated ? content.length - maxChars : 0, notice },
      `Full text of ${args.item_key}: ${content.length} chars${truncated ? `, returned first ${maxChars}` : ''}.`,
    );
  },
};

export default getFulltext;
