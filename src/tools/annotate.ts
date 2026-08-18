import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, requireCloudLibrary, isLocalWritesUnavailable, ensureLocalApi } from '../registry/registry.js';

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
    .describe('Zotero position: {"pageIndex": N, "rects": [[x1,y1,x2,y2],...]} (points, bottom-left origin), its JSON string, or shorthand [N, [x1,y1,x2,y2]]. Required for highlights/underlines to render in place.'),
  sort_index: z.string().optional().describe('Explicit annotationSortIndex; computed from position when omitted.'),
  char_offset: z.number().int().optional().describe('Reading-order character offset of the passage start on the page (refines sort_index).'),
  page_height: z.number().optional().describe('Page height in points (refines sort_index, e.g. 841.89 for A4).'),
  tags: z.array(z.string()).optional().describe('Tags to attach to the annotation.'),
});

const annotateTool: ToolDefinition = {
  name: 'zotero_annotate',
  title: 'Annotate a PDF (highlights, notes)',
  description:
    'Add or delete Zotero PDF annotations (highlights, underlines, notes) — the same objects you create in the Zotero PDF reader. `action:"add"` needs `parent` (a regular item key OR a PDF attachment key) and `annotations`: each with `type` (highlight|note|underline, default highlight), `text` (the exact highlighted passage), optional `comment`, `color`, `page` (0-based page index), and `position` ({"pageIndex":N,"rects":[[x1,y1,x2,y2],...]} in PDF points with bottom-left origin — without a position a highlight cannot render in place). `action:"delete"` trashes the annotations in `annotation_keys`. Writes go to the running Zotero desktop app for your personal library (via its connector protocol, or its local-API writes where available), otherwise to the cloud Web API.',
  inputSchema: {
    action: z.enum(['add', 'delete']).optional().describe('Default "add".'),
    parent: z.string().optional().describe('Item key or PDF attachment key to annotate.'),
    annotations: z.array(annotationSchema).optional().describe('Annotations to add.'),
    annotation_keys: z.array(z.string()).optional().describe('Annotation keys to trash (action:"delete").'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
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

    // Build annotation items in Zotero's data model.
    const items: Record<string, unknown>[] = [];
    const problems: string[] = [];
    anns.forEach((a: any, i: number) => {
      const type = a.type ?? 'highlight';
      if ((type === 'highlight' || type === 'underline') && !a.text) {
        problems.push(`annotations[${i}]: ${type} requires \`text\` (the exact passage).`);
        return;
      }
      const pos = normalizePosition(a.position, a.page);
      if ((type === 'highlight' || type === 'underline') && !pos?.rects?.length) {
        problems.push(`annotations[${i}]: ${type} needs \`position\` ({"pageIndex":N,"rects":[[x1,y1,x2,y2],...]}) to render in place.`);
        return;
      }
      const pageIndex = pos?.pageIndex ?? a.page ?? 0;
      const item: Record<string, unknown> = {
        itemType: 'annotation',
        parentItem: targetAttachment,
        annotationType: type,
        annotationColor: a.color ?? (type === 'note' ? '#26a69a' : '#ffd400'),
        annotationSortIndex:
          a.sort_index ?? buildSortIndex(pageIndex, pos?.rects ?? [], { offset: a.char_offset, pageHeight: a.page_height }),
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
            created: result.successful.map((s, i) => ({ key: s.key, type: items[i]?.annotationType, text: items[i]?.annotationText ?? '', comment: items[i]?.annotationComment ?? '' })),
          },
          `Added ${result.successful.length} annotation(s) to PDF ${targetAttachment} via the Zotero desktop app.`,
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
          created,
          note: created.length < items.length
            ? 'Some annotations could not be matched back yet; they may still appear in Zotero (check the PDF sidebar).'
            : undefined,
        },
        `Added ${created.length}/${items.length} annotation(s) to PDF ${targetAttachment} via the running Zotero desktop app.`,
      );
    }
    const lib = requireCloudLibrary(ctx, args);
    const result = await ctx.web.writeItems(lib, items);
    return ok(
      {
        target: 'cloud',
        attachment: targetAttachment,
        created: result.successful.map((s, i) => ({ key: s.key, type: items[i]?.annotationType })),
        failed: result.failed,
      },
      `Added ${result.successful.length} annotation(s) to PDF ${targetAttachment} via the cloud Web API.`,
    );
  },
};

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
