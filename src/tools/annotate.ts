import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary, isLocalWritesUnavailable, ensureLocalApi } from '../registry/registry.js';
import { locatePassages, type PassageAnchor } from '../features/fulltext/pdf-locate.js';
import { DEFAULT_PRECISE_MAX_BYTES } from '../features/fulltext/pdf-pages.js';
import { loadAttachmentBytes } from '../features/attachments/bytes.js';

/**
 * Normalize a caller-supplied position into Zotero's stored form:
 *   {"pageIndex": <0-based page>, "rects": [[x1, y1, x2, y2], ...]}
 * Points, origin at the BOTTOM-LEFT of the page (native PDF coordinate space, y
 * increasing upward). Accepts
 * either that object directly (or its JSON string) or the shorthand
 * [pageIndex, [x1, y1, x2, y2]].
 */
export function normalizePosition(
  position: unknown,
  page?: number,
): { pageIndex: number; rects: number[][] } | null {
  if (position == null) {
    return page != null ? { pageIndex: page, rects: [] } : null;
  }
  if (typeof position === 'string') {
    try {
      return normalizePosition(JSON.parse(position), page);
    } catch {
      return null;
    }
  }
  if (Array.isArray(position) && position.length === 2 && typeof position[0] === 'number') {
    const rect = position[1];
    if (Array.isArray(rect) && rect.length === 4 && rect.every((n) => typeof n === 'number')) {
      return { pageIndex: position[0] as number, rects: [rect as number[]] };
    }
    return null;
  }
  const p = position as { pageIndex?: unknown; rects?: unknown };
  if (typeof p.pageIndex === 'number' && Array.isArray(p.rects)) {
    const rects = (p.rects as unknown[]).filter(
      (r): r is number[] => Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number'),
    );
    return { pageIndex: p.pageIndex, rects };
  }
  return null;
}

/**
 * Replicates the PDF reader's sort-index scheme so annotations order correctly in
 * the sidebar: `PPPPP|OOOOOO|TTTTT` (5-digit page | 6-digit char offset | 5-digit
 * distance of the topmost rect from the page bottom). Callers that extracted the
 * highlight from the PDF itself can pass the exact offset; otherwise offset 0 with
 * the rect-derived `top` still keeps same-page highlights in reading order.
 */
export function buildSortIndex(
  pageIndex: number,
  rects: number[][],
  opts: { offset?: number; pageHeight?: number } = {},
): string {
  const pad = (n: number, w: number) => String(Math.max(0, Math.floor(n))).slice(0, w).padStart(w, '0');
  let top = 0;
  if (rects.length && opts.pageHeight) {
    // Topmost rect: the reader sorts rects by their third coordinate descending
    // and takes the first; mirror that exactly.
    const topRect = rects.slice().sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0))[0] ?? [0, 0, 0, 0];
    top = Math.max(0, opts.pageHeight - (topRect[3] ?? 0));
  }
  return `${pad(pageIndex, 5)}|${pad(opts.offset ?? 0, 6)}|${pad(Math.floor(top), 5)}`;
}

const annotationSchema = z.object({
  type: z.enum(['highlight', 'note', 'underline', 'image']).optional()
    .describe('Annotation type; default "highlight".'),
  text: z.string().optional()
    .describe('The highlighted/underlined passage itself (required for highlight/underline). For notes, goes in annotationText of an extracted-text style note or leave to `comment`.'),
  comment: z.string().optional().describe('Comment attached to the annotation (markdown-ish plain text).'),
  color: z.string().optional().describe('Hex color, e.g. "#ffd400" (highlight default) or "#26a69a".'),
  page: z.number().int().optional().describe('0-based PDF page index (annotationPageLabel uses page+1 when unset).'),
  page_label: z.string().optional().describe('Explicit page label (overrides page+1).'),
  position: z.union([z.string(), z.any()]).optional()
    .describe('Zotero position: {"pageIndex": N, "rects": [[x1,y1,x2,y2],...]} (points, bottom-left origin), its JSON string, or shorthand [N, [x1,y1,x2,y2]]. Optional: when omitted, the passage in `text` is located in the PDF and its coordinates are computed for you.'),
  occurrence: z.number().int().min(1).optional()
    .describe('Which occurrence of `text` to anchor when the passage appears more than once (1-based, in reading order). Only needed when a first attempt reports an ambiguous passage.'),
  sort_index: z.string().optional().describe('Explicit annotationSortIndex; computed from position when omitted.'),
  char_offset: z.number().int().optional().describe('Reading-order character offset of the passage start on the page (refines sort_index).'),
  page_height: z.number().optional().describe('Page height in points (refines sort_index, e.g. 841.89 for A4).'),
  tags: z.array(z.string()).optional().describe('Tags to attach to the annotation.'),
});

const annotateTool: ToolDefinition = {
  name: 'zotero_annotate',
  title: 'Annotate a PDF (highlights, notes)',
  description:
    'Add or delete Zotero PDF annotations (highlights, underlines, notes), the same objects you create in the Zotero PDF reader. `action:"add"` needs `parent` (a regular item key OR a PDF attachment key) and `annotations`: each with `type` (highlight|note|underline, default highlight), `text` (the exact passage to highlight), optional `comment`, `color`, `page` (0-based page index). **You do not need page coordinates**: give the passage in `text` and it is located in the PDF and anchored to the exact lines it occupies, so quoting a passage is enough to highlight it. Pass `page` to disambiguate a passage that repeats, or `occurrence` to pick among repeats; pass `position` ({"pageIndex":N,"rects":[[x1,y1,x2,y2],...]} in PDF points, bottom-left origin) only to place a highlight yourself. `action:"delete"` trashes the annotations in `annotation_keys`. Writes go to the running Zotero desktop app for your personal library (via its connector protocol, or its local-API writes where available), otherwise to the cloud Web API.',
  inputSchema: {
    action: z.enum(['add', 'delete']).optional().describe('Default "add".'),
    parent: z.string().optional().describe('Item key or PDF attachment key to annotate.'),
    annotations: z.array(annotationSchema).optional().describe('Annotations to add.'),
    annotation_keys: z.array(z.string()).optional().describe('Annotation keys to trash (action:"delete").'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const action = args.action ?? 'add';

    if (action === 'delete') {
      const keys: string[] = args.annotation_keys ?? [];
      if (!keys.length) {
        return { content: [{ type: 'text', text: '`annotation_keys` is required for action:"delete".' }], isError: true };
      }
      if (!args.library_id && (await ensureLocalApi(ctx)) && ctx.localWrites) {
        try {
          // `deleted: 1` (reversible trash), not DELETE — the local API's DELETE erases.
          const result = await ctx.localWrites.setDeleted(keys, 1);
          const trashed = [...result.successful.map((s) => s.key), ...result.unchanged];
          return ok(
            { trashed, failed: result.failed, target: 'local' },
            `Trashed ${trashed.length} annotation(s) via the Zotero desktop app.`,
          );
        } catch (e) {
          if (!isLocalWritesUnavailable(e)) throw e;
          // Running Zotero has no local-API writes; fall through to cloud/guidance.
        }
      }
      if (ctx.capabilities.cloud) {
        const lib = requireCloudLibrary(ctx, args);
        const objects: any[] = [];
        for (const key of keys) {
          const item = await ctx.web.getItem(lib, key);
          objects.push({ key, version: item?.version ?? item?.data?.version, deleted: 1 });
        }
        const result = await ctx.web.writeItems(lib, objects);
        return ok(
          { trashed: result.successful.map((s) => s.key), failed: result.failed, target: 'cloud' },
          `Trashed ${result.successful.length} annotation(s) via the cloud Web API.`,
        );
      }
      return {
        content: [{
          type: 'text',
          text: 'Deleting annotations needs write access this Zotero cannot grant: the running app\u2019s local API is read-only (local-API writes ship in Zotero 10) and the connector protocol cannot delete. Set ZOTERO_API_KEY for cloud writes, upgrade to Zotero 10 or newer, or delete the annotations manually in Zotero\u2019s PDF reader.',
        }],
        isError: true,
      };
    }

    // --- add ---
    if (!args.parent) {
      return { content: [{ type: 'text', text: '`parent` (item key or PDF attachment key) is required for action:"add".' }], isError: true };
    }
    const parentKey: string = args.parent;
    const anns = args.annotations ?? [];
    if (!anns.length) {
      return { content: [{ type: 'text', text: '`annotations` must contain at least one entry.' }], isError: true };
    }

    // Resolve the PDF attachment: the parent may be the attachment itself or any
    // regular item whose children include a stored/linked PDF.
    const parentItem = await ctx.router.getItem(parentKey);
    const parentData = parentItem?.data ?? parentItem;
    let attachmentKey: string | undefined;
    if (parentData?.itemType === 'attachment') {
      attachmentKey = parentData.key ?? parentKey;
    } else {
      const children = await ctx.router.getItemChildren(parentKey);
      const pdf = children.data
        .map((c: any) => c?.data ?? c)
        .filter((c: any) => c?.itemType === 'attachment')
        .sort((a: any, b: any) => scorePdf(b) - scorePdf(a))[0];
      attachmentKey = pdf?.key;
      if (!attachmentKey) {
        return {
          content: [{ type: 'text', text: `No PDF attachment found under item ${parentKey}. Add the PDF first (or pass the attachment key directly).` }],
          isError: true,
        };
      }
    }

    if (!attachmentKey) {
      return { content: [{ type: 'text', text: 'Could not resolve a PDF attachment.' }], isError: true };
    }
    const targetAttachment: string = attachmentKey;

    // Anchor every passage-only highlight to the lines it occupies in the PDF, so a caller
    // that can quote a passage never has to supply coordinates it has no way to know.
    const problems: string[] = [];
    const anchored = await anchorPassages(ctx, args, targetAttachment, anns, problems);

    // Build annotation items in Zotero's data model.
    const items: Record<string, unknown>[] = [];
    anns.forEach((a: any, i: number) => {
      const type = a.type ?? 'highlight';
      if ((type === 'highlight' || type === 'underline') && !a.text) {
        problems.push(`annotations[${i}]: ${type} requires \`text\` (the exact passage).`);
        return;
      }
      // A caller-supplied position always wins; the located passage fills in for its absence.
      const given = normalizePosition(a.position, a.page);
      const found = anchored.get(i);
      const pos = given?.rects?.length ? given : found ? { pageIndex: found.pageIndex, rects: found.rects } : given;
      if ((type === 'highlight' || type === 'underline') && !pos?.rects?.length) {
        // anchorPassages has already explained why, in the terms the caller can act on.
        if (!problems.some((p) => p.startsWith(`annotations[${i}]:`))) {
          problems.push(`annotations[${i}]: ${type} could not be placed: the passage was not found in the PDF, and no \`position\` was given.`);
        }
        return;
      }
      const pageIndex = pos?.pageIndex ?? a.page ?? 0;
      const item: Record<string, unknown> = {
        itemType: 'annotation',
        parentItem: targetAttachment,
        annotationType: type,
        annotationColor: a.color ?? (type === 'note' ? '#26a69a' : '#ffd400'),
        annotationSortIndex:
          a.sort_index ??
          buildSortIndex(pageIndex, pos?.rects ?? [], {
            offset: a.char_offset ?? anchored.get(i)?.charOffset,
            pageHeight: a.page_height ?? anchored.get(i)?.pageHeight,
          }),
        annotationPosition: JSON.stringify(pos ?? { pageIndex, rects: [] }),
        tags: (a.tags ?? []).map((t: string) => ({ tag: t })),
      };
      if (a.text) item.annotationText = a.text;
      if (a.comment) item.annotationComment = a.comment;
      const label = a.page_label ?? String(pageIndex + 1);
      if (label) item.annotationPageLabel = label;
      items.push(item);
    });
    if (problems.length) {
      return { content: [{ type: 'text', text: `Nothing was written:\n- ${problems.join('\n- ')}` }], isError: true };
    }

    // Prefer the desktop app for the personal library; fall back to the cloud.
    // (a) Zotero 10+ local-API writes (the first one asks for a key in-app — choose
    //     "Always Allow" to be asked once), or (b) the connector protocol that every
    //     recent Zotero exposes while running.
    if (!args.library_id && (await ensureLocalApi(ctx)) && ctx.localWrites) {
      try {
        const result = await ctx.localWrites.writeItems(items);
        if (result.failed.length) {
          return { content: [{ type: 'text', text: `Local write failed: ${JSON.stringify(result.failed)}` }], isError: true };
        }
        return ok(
          {
            target: 'local',
            attachment: targetAttachment,
            anchoredFromText: anchored.size,
            created: result.successful.map((s, i) => ({ key: s.key, type: items[i]?.annotationType, text: items[i]?.annotationText ?? '', comment: items[i]?.annotationComment ?? '' })),
          },
          `Added ${result.successful.length} annotation(s) to PDF ${targetAttachment} via the Zotero desktop app.` + anchorNote(anchored.size),
        );
      } catch (e) {
        if (!isLocalWritesUnavailable(e)) throw e;
        ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); using the connector protocol.`);
      }
    }
    if (!args.library_id && ctx.connectorWrites && (await ensureLocalApi(ctx))) {
      const { sessionID } = await ctx.connectorWrites.saveItems(items, { uri: 'zotero://zoteus/annotate' });
      // The connector returns no keys; recover them by querying the local API.
      const created = await pollCreatedAnnotations(ctx, targetAttachment, items);
      return ok(
        {
          target: 'desktop',
          sessionID,
          attachment: targetAttachment,
          anchoredFromText: anchored.size,
          created,
          note: created.length < items.length
            ? 'Some annotations could not be matched back yet; they may still appear in Zotero (check the PDF sidebar).'
            : undefined,
        },
        `Added ${created.length}/${items.length} annotation(s) to PDF ${targetAttachment} via the running Zotero desktop app.` + anchorNote(anchored.size),
      );
    }
    const lib = requireCloudLibrary(ctx, args);
    const result = await ctx.web.writeItems(lib, items);
    return ok(
      {
        target: 'cloud',
        attachment: targetAttachment,
        anchoredFromText: anchored.size,
        created: result.successful.map((s, i) => ({ key: s.key, type: items[i]?.annotationType })),
        failed: result.failed,
      },
      `Added ${result.successful.length} annotation(s) to PDF ${targetAttachment} via the cloud Web API.` + anchorNote(anchored.size),
    );
  },
};

/**
 * Resolve the on-page geometry of every highlight/underline given as a passage rather than
 * as coordinates.
 *
 * This is what makes a highlight reachable from text alone. Zotero anchors a highlight by
 * page rects, which a caller reading extracted text cannot know; inventing them draws a
 * box over the wrong lines, so the honest fallback used to be a page-anchored note. Here
 * the passage is found in the PDF itself and its real rects computed, and where it cannot
 * be found nothing is written and the reason says which of the two it was: the passage is
 * not in the document, or it is there more than once.
 *
 * Annotations that already carry a `position`, and notes (which are placed by page, not by
 * passage), are left alone, and when nothing needs anchoring the PDF is never fetched.
 */
async function anchorPassages(
  ctx: ToolContext,
  args: any,
  attachmentKey: string,
  anns: any[],
  problems: string[],
): Promise<Map<number, PassageAnchor>> {
  const resolved = new Map<number, PassageAnchor>();
  const pending: Array<{ index: number; text: string; pageIndex?: number }> = [];
  anns.forEach((a, i) => {
    const type = a.type ?? 'highlight';
    if (type !== 'highlight' && type !== 'underline') return;
    if (!a.text) return;
    if (normalizePosition(a.position, a.page)?.rects?.length) return;
    pending.push({ index: i, text: a.text, pageIndex: typeof a.page === 'number' ? a.page : undefined });
  });
  if (!pending.length) return resolved;

  const bytes = await loadPdfBytes(ctx, args, attachmentKey);
  if (!bytes) {
    for (const p of pending) {
      problems.push(
        `annotations[${p.index}]: the PDF could not be read, so the passage cannot be placed. ` +
          `Zoteus reads it from the running Zotero desktop app, or downloads it from Zotero storage when the file has synced. ` +
          `Neither worked here (a linked file with no stored copy, or an unsynced attachment on a hosted Zoteus). ` +
          `Pass an explicit \`position\` instead, or use type:"note" with \`page\`.`,
      );
    }
    return resolved;
  }

  const hits = await locatePassages(
    bytes,
    pending.map((p) => ({ text: p.text, pageIndex: p.pageIndex })),
  );
  if (!hits) {
    const maxMb = Math.round(DEFAULT_PRECISE_MAX_BYTES / (1024 * 1024));
    for (const p of pending) {
      problems.push(
        `annotations[${p.index}]: the PDF could not be parsed for text positions ` +
          `(a scanned/corrupt PDF, a file over the ${maxMb} MB parsing limit, or the optional pdfjs-dist parser is missing). ` +
          `Pass an explicit \`position\`, or use type:"note" with \`page\`.`,
      );
    }
    return resolved;
  }

  pending.forEach((p, n) => {
    const found = hits[n] ?? [];
    const where = p.pageIndex != null ? ` on page ${p.pageIndex + 1} (page index ${p.pageIndex})` : '';
    if (!found.length) {
      problems.push(
        `annotations[${p.index}]: passage not found in the PDF${where}: ${JSON.stringify(p.text.slice(0, 60))}. ` +
          `Quote it exactly as zotero_get_fulltext returns it (line breaks, hyphenation and spacing are ignored, but altered wording is not)` +
          (p.pageIndex != null ? ', or drop `page` to search the whole document.' : '.'),
      );
      return;
    }
    const pick = anns[p.index]?.occurrence;
    if (typeof pick === 'number') {
      const chosen = found[pick - 1];
      if (!chosen) {
        problems.push(`annotations[${p.index}]: occurrence ${pick} requested but the passage occurs ${found.length} time(s).`);
        return;
      }
      resolved.set(p.index, chosen);
      return;
    }
    if (found.length > 1) {
      // Placing the wrong one of several identical passages is the failure this whole path
      // exists to avoid, so ask rather than guess.
      const list = found
        .map((h, k) => `  ${k + 1}. page ${h.pageIndex + 1}: …${h.context.slice(0, 90)}…`)
        .join('\n');
      problems.push(
        `annotations[${p.index}]: the passage occurs ${found.length} times${where ? where : ''}; ` +
          `re-send it with \`occurrence\` (or a \`page\`) to say which:\n${list}`,
      );
      return;
    }
    resolved.set(p.index, found[0]!);
  });
  return resolved;
}

/**
 * The attachment's PDF bytes, from whichever side of Zoteus can reach them: the desktop
 * app reads them off its own disk (so unsynced and storage-quota-less libraries work), the
 * Zotero storage folder answers when the app is not running but shares the machine, and a
 * hosted Zoteus downloads them from Zotero storage. Returns null when none can.
 */
async function loadPdfBytes(ctx: ToolContext, args: any, attachmentKey: string): Promise<Uint8Array | null> {
  const library = args.library_id
    ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
    : undefined;
  const loaded = await loadAttachmentBytes(ctx, {
    key: attachmentKey,
    library,
    maxBytes: DEFAULT_PRECISE_MAX_BYTES,
  });
  if (loaded.bytes) return loaded.bytes;
  if (loaded.reasons.length) ctx.logger.debug(`No PDF bytes for ${attachmentKey}: ${loaded.reasons.join('; ')}`);
  return null;
}

/** Says so when highlights were placed from their text rather than from caller coordinates. */
function anchorNote(count: number): string {
  if (!count) return '';
  return ` ${count} highlight(s) were positioned by locating their text in the PDF.`;
}

/** Rank attachment children: stored PDFs first, then linked PDFs, then anything else. */
function scorePdf(att: any): number {
  if (att?.contentType !== 'application/pdf') return 0;
  const lm = att?.linkMode;
  if (lm === 'imported_file') return 3;
  if (lm === 'imported_url') return 2;
  if (lm === 'linked_file' || lm === 'linked_url') return 1;
  return 1;
}

export default annotateTool;


/**
 * Recover the item keys of annotations just created through the connector protocol
 * (which returns no payload) by querying the desktop local API for the attachment's
 * annotation children and matching them against what we sent.
 */
async function pollCreatedAnnotations(
  ctx: any,
  attachmentKey: string,
  sent: Record<string, unknown>[],
): Promise<Array<{ key: string; type?: unknown; text?: unknown; comment?: unknown }>> {
  const wanted = new Map<string, Record<string, unknown>>();
  for (const it of sent) {
    const fingerprint = `${it.annotationType ?? ''}::${(it.annotationText ?? '') as string}`;
    wanted.set(fingerprint, it);
  }
  const found: Array<{ key: string; type?: unknown; text?: unknown; comment?: unknown }> = [];
  const deadline = Date.now() + 15_000;
  while (wanted.size && Date.now() < deadline) {
    try {
      // Must be the /children endpoint: the local API ignores a `parentItem` filter
      // on /items and would hand back the entire library instead.
      const res = await ctx.local.getItemChildren(attachmentKey, { itemType: 'annotation', limit: 100 });
      for (const child of res.data) {
        const d = child?.data ?? child;
        if (d?.itemType && d.itemType !== 'annotation') continue;
        const fingerprint = `${d?.annotationType ?? ''}::${d?.annotationText ?? ''}`;
        if (wanted.has(fingerprint)) {
          wanted.delete(fingerprint);
          found.push({
            key: d.key,
            type: d.annotationType,
            text: d.annotationText ?? '',
            comment: d.annotationComment ?? '',
          });
        }
      }
    } catch {
      // Local API hiccup; keep polling until the deadline.
    }
    if (wanted.size) await new Promise((r) => setTimeout(r, 750));
  }
  return found;
}
