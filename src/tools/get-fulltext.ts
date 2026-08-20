import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import { rankPassages, approxPage, type Passage } from '../features/fulltext/passages.js';
import { extractPdfPages, locatePage, pdfPagesToText, DEFAULT_PRECISE_MAX_BYTES } from '../features/fulltext/pdf-pages.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

interface Resolved {
  attachmentKey: string;
  parentKey?: string;
  filename?: string;
  title?: string;
  /** Attachment file size in bytes, when known (used to skip oversized PDF re-extraction). */
  size?: number;
}

/** Best-effort attachment file size from Zotero item metadata (links.enclosure.length). */
function fileSize(raw: any): number | undefined {
  const len = raw?.links?.enclosure?.length ?? raw?.data?.links?.enclosure?.length;
  return typeof len === 'number' && len > 0 ? len : undefined;
}

async function resolveAttachment(
  ctx: ToolContext,
  itemKey: string,
  library: LibraryRef | undefined,
): Promise<Resolved | { error: string }> {
  const item = await ctx.router.getItem(itemKey, { library });
  const d = item?.data ?? item ?? {};
  if (d.itemType === 'attachment') {
    return { attachmentKey: itemKey, parentKey: d.parentItem, filename: d.filename, title: d.title, size: fileSize(item) };
  }
  const children = await ctx.router.getItemChildren(itemKey, { library });
  const atts = (children.data ?? []).filter((c: any) => (c.data?.itemType ?? c.itemType) === 'attachment');
  const pdf = atts.find((c: any) => (c.data?.contentType ?? c.contentType) === 'application/pdf');
  const chosen = pdf ?? atts[0];
  if (!chosen) return { error: `Item ${itemKey} has no attachment with full text. Attach a PDF in Zotero.` };
  const cd = chosen.data ?? chosen;
  return { attachmentKey: chosen.key ?? cd.key, parentKey: itemKey, filename: cd.filename, title: d.title, size: fileSize(chosen) };
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
    "Retrieve an item's PDF text for grounding. Pass a parent `item_key` (its best PDF attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. \"3-7\"), returns that span; with neither, returns a truncated head. Text comes from Zotero's full-text index when available; when the attachment is NOT indexed yet, the PDF itself is downloaded and parsed on the fly (`fallback`, on by default — set `fallback:false` to disable), so unindexed PDFs still return text (marked fulltextSource:\"pdf\"). Page numbers are exact in that case, and otherwise an estimate (pageApprox) unless `precise_pages:true`, which re-extracts the PDF for exact pages when possible (otherwise it degrades to approximate with a notice). Read-only; the indexed text is served by the running Zotero desktop app when there is one, otherwise by the cloud Web API. Use this to cite a claim with a page after finding an item via zotero_search_items / zotero_semantic_search.",
  inputSchema: {
    item_key: z.string().describe('Parent item key or attachment key.'),
    query: z.string().optional().describe('Return top passages relevant to this query.'),
    page_range: z.string().optional().describe('Page span like "3-7" (1-based, inclusive).'),
    max_passages: z.number().int().min(1).max(20).optional().describe('Max passages (default 5).'),
    max_chars: z
      .number()
      .int()
      .min(500)
      .max(100000)
      .optional()
      .describe(
        'Best-effort cap on total returned text (default 12000); a single passage is never split, so one passage may slightly exceed it.',
      ),
    precise_pages: z.boolean().optional().describe('Re-extract the PDF for exact page numbers.'),
    fallback: z
      .boolean()
      .optional()
      .describe(
        'When Zotero has no indexed full text for the attachment, download the PDF and extract it directly (default true).',
      ),
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

    const maxMb = Math.round(DEFAULT_PRECISE_MAX_BYTES / (1024 * 1024));
    // Routed, not cloud-only: Zotero 7+ serves /fulltext locally, so a running desktop app
    // answers this without a cloud key (and for items that never synced).
    const ft = await ctx.router.getFullText(resolved.attachmentKey, { library });
    const indexed = Boolean(ft && typeof ft.content === 'string' && ft.content.length);

    // Where the text comes from: Zotero's index when available, otherwise (fallback,
    // on by default) the attachment PDF itself, parsed on the fly with pdfjs.
    let content: string;
    let totalChars: number;
    let totalPages: number | undefined;
    let pages: string[] | null = null;
    let fulltextSource: 'zotero' | 'pdf' = 'zotero';
    let sourceNotice = '';

    if (indexed) {
      content = ft.content;
      totalChars = typeof ft.totalChars === 'number' && ft.totalChars > 0 ? ft.totalChars : content.length;
      totalPages = typeof ft.totalPages === 'number' ? ft.totalPages : undefined;
    } else if (args.fallback === false) {
      return err(
        `No extracted full text for attachment ${resolved.attachmentKey}. Zotero has not indexed it yet ` +
          `(open it once in Zotero to index it, or retry with fallback enabled to parse the PDF directly).`,
      );
    } else {
      // --- PDF fallback: download the attachment and extract text directly ---
      const noText = `No extracted full text for attachment ${resolved.attachmentKey} (Zotero has not indexed it)`;
      if (resolved.size && resolved.size > DEFAULT_PRECISE_MAX_BYTES) {
        return err(
          `${noText}, and direct PDF extraction is skipped: the file is larger than the ${maxMb} MB limit for on-the-fly parsing. ` +
            `Open the PDF once in Zotero to have it indexed, then retry.`,
        );
      }
      let bytes: Uint8Array;
      try {
        const dl = await ctx.web.downloadFileBytes(lib, resolved.attachmentKey);
        bytes = dl.bytes;
      } catch (e) {
        return err(
          `${noText}, and the attachment file could not be downloaded either (${e instanceof Error ? e.message : String(e)}). ` +
            `It may be a linked file with no stored copy.`,
        );
      }
      const extracted = await extractPdfPages(bytes);
      if (!extracted || !extracted.some((p) => p.trim())) {
        return err(
          `${noText}, and direct PDF extraction yielded nothing (corrupt/scanned PDF, oversized file, or the optional pdfjs-dist parser is missing). ` +
            `Open the PDF once in Zotero to have it indexed, then retry.`,
        );
      }
      pages = extracted;
      content = pdfPagesToText(extracted);
      totalChars = content.length;
      totalPages = extracted.length;
      fulltextSource = 'pdf';
      sourceNotice = ` Zotero had no indexed full text for this attachment; the text was extracted directly from the PDF (fallback).`;
    }
    const maxChars = args.max_chars ?? 12000;

    const base = {
      item_key: args.item_key,
      attachmentKey: resolved.attachmentKey,
      parentKey: resolved.parentKey,
      filename: resolved.filename,
      title: resolved.title,
      fulltextSource,
      totalChars,
      totalPages,
      indexedChars: indexed ? ft.indexedChars : undefined,
      indexedPages: indexed ? ft.indexedPages : undefined,
    };

    // Optionally pull exact pages once (shared by passages / page_range). When the text
    // came from the PDF fallback we already hold the exact pages.
    let tooLarge = false;
    if (!pages && args.precise_pages) {
      // Pre-download guard: skip the (potentially large) file transfer + pdfjs extraction
      // when the attachment is already known to exceed the safe size for this host. pdfjs can
      // balloon to many× the file size and OOM a small instance (see DEFAULT_PRECISE_MAX_BYTES).
      if (resolved.size && resolved.size > DEFAULT_PRECISE_MAX_BYTES) {
        tooLarge = true;
      } else {
        try {
          const dl = await ctx.web.downloadFileBytes(lib, resolved.attachmentKey);
          // extractPdfPages self-guards on byte size too (catches unknown-size attachments).
          pages = await extractPdfPages(dl.bytes);
          if (!pages && dl.bytes.byteLength > DEFAULT_PRECISE_MAX_BYTES) tooLarge = true;
        } catch {
          pages = null;
        }
      }
    }
    const exact = Boolean(pages && pages.length);
    const pageSource = exact ? 'exact' : 'approximate';
    const degradeNotice =
      indexed && args.precise_pages && !exact
        ? tooLarge
          ? ` Exact pages skipped: this PDF exceeds the ${maxMb} MB re-extraction limit on this instance; pageApprox is an estimate.`
          : ' Exact pages unavailable (PDF bytes or the optional pdfjs-dist parser missing); pageApprox is an estimate.'
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
        sourceNotice +
        degradeNotice;
      return ok(
        { ...base, mode: 'passages', pageSource, passages, truncated, notice: (sourceNotice + degradeNotice).trim() || undefined },
        summary,
      );
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
      const emptyNotice =
        !text && totalPages ? ` Pages ${args.page_range} appear to be beyond the document (~${totalPages} pages).` : '';
      return ok(
        {
          ...base,
          mode: 'page_range',
          pageSource,
          page_range: args.page_range,
          text,
          truncated,
          omittedChars: truncated ? slice.length - maxChars : 0,
          notice: (sourceNotice + degradeNotice + emptyNotice).trim() || undefined,
        },
        `Text for pages ${args.page_range} of ${args.item_key} (${pageSource}).` +
          (truncated ? ' Truncated (max_chars).' : '') +
          sourceNotice +
          degradeNotice +
          emptyNotice,
      );
    }

    // --- document mode ---
    const truncated = content.length > maxChars;
    const text = truncated ? content.slice(0, maxChars) : content;
    const truncNotice = truncated
      ? ` Truncated to ${maxChars} of ${content.length} chars — pass query (for relevant passages), page_range, or a larger max_chars.`
      : '';
    const notice = (sourceNotice + truncNotice).trim() || undefined;
    return ok(
      { ...base, mode: 'document', pageSource, text, truncated, omittedChars: truncated ? content.length - maxChars : 0, notice },
      `Full text of ${args.item_key}: ${content.length} chars${truncated ? `, returned first ${maxChars}` : ''} ` +
        `(${fulltextSource === 'pdf' ? 'extracted from the PDF directly' : 'from the Zotero full-text index'}).`,
    );
  },
};

export default getFulltext;
