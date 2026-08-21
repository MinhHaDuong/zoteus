import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';

/**
 * Default cap on indexed full-text characters per item (~13 pages of dense text, so a
 * typical paper is covered end to end). The cost of full-text indexing scales linearly
 * with this: passages per item are roughly maxChars / FULLTEXT_CHUNK_SIZE, and each one
 * is a vector to compute, hold in memory, and write into search-index.json. 0 = no cap.
 */
export const DEFAULT_FULLTEXT_MAX_CHARS = 40_000;

/** Both Zotero APIs page items 100-at-a-time. */
const ATTACHMENT_PAGE_SIZE = 100;

/**
 * Ceiling on attachment pages walked while mapping attachments to their parent items, so
 * a library with a pathological number of attachments cannot page forever. The walk also
 * stops as soon as every attachment that HAS full text has been located, which is the
 * usual exit.
 */
const MAX_ATTACHMENT_PAGES = 500;

/**
 * Pages walked when NOTHING in the library is extracted yet.
 *
 * That walk cannot produce a single character of text — it buys only the
 * present-without-text record — so it is capped far below MAX_ATTACHMENT_PAGES. The record
 * is a bounded hint, for reporting and for re-probing; correctness rests on the delta's
 * `fullTextSince` sweep, which names a newly extracted attachment whether or not it was
 * ever listed here.
 */
const MAX_PENDING_PAGES = 20;

/** Ceiling on the pending set, for the same reason: it is a hint, not an inventory. */
const MAX_PENDING_ITEMS = 2000;

export interface FulltextSource {
  /** Concatenated, capped full text of one item's attachments (undefined when it has none). */
  textFor(itemKey: string): Promise<string | undefined>;
  /** Attachments with indexed full text that this source can serve. */
  attachments: number;
  /** Items those attachments belong to. */
  items: number;
  /**
   * Items carrying an attachment Zotero has **not extracted yet** — present without text.
   *
   * These used to be skipped, and skipping is what made "no text yet" indistinguishable
   * from "no attachment": both produced an item with no full-text passages and nothing
   * anywhere recording the difference, so nothing ever went back to look. Recorded here,
   * a later delta can re-probe them.
   *
   * Best effort, and honestly so: the attachment walk below stops as soon as every
   * attachment that HAS text has been located, so attachments sitting past that point are
   * not seen. Correctness does not rest on this list — the delta's `fullTextSince` sweep
   * finds a newly extracted attachment whether or not it was ever listed here — which is
   * why the early exit is worth keeping.
   */
  pendingItems: string[];
  /**
   * Highest full-text version this source saw, and the seed for the index's full-text
   * watermark (ticket 0012).
   *
   * It costs nothing to produce: the `/fulltext?since=0` request below is made anyway, to
   * find which attachments have text at all, and its values are that sequence. Seeding
   * from it is what keeps the FIRST delta after a build correct — a full-text watermark of
   * 0 would report every extracted attachment in the library as newly extracted, which is
   * the defect 0012 measured (7 453 of 8 037 entries, against a library version of 410).
   *
   * 0 when nothing is extracted or the endpoint was unreachable, which reads as "no
   * full-text history recorded" and is the same thing an index built before this field
   * existed says.
   */
  fulltextVersion: number;
  /** Set when full text cannot be indexed at all; the build then stays metadata-only. */
  unavailable?: string;
}

/** An inert source, for "full text requested but not obtainable". */
function emptySource(unavailable?: string, pendingItems: string[] = [], fulltextVersion = 0): FulltextSource {
  const src: FulltextSource = { textFor: async () => undefined, attachments: 0, items: 0, pendingItems, fulltextVersion };
  if (unavailable) src.unavailable = unavailable;
  return src;
}

/** Highest value in a Zotero `key -> version` map; 0 for an empty or malformed one. */
export function highestVersion(map: Record<string, number>): number {
  let max = 0;
  for (const v of Object.values(map)) if (Number.isFinite(v) && v > max) max = v;
  return max;
}

/**
 * Build the attachment -> parent-item map the index build needs to attach PDF body text to
 * the item it belongs to.
 *
 * Two cheap library-wide reads instead of per-item probing: `/fulltext?since=0` names every
 * attachment that HAS extracted text (one request), and paging `itemType=attachment` gives
 * each one its `parentItem`. Only the intersection is ever fetched, so the number of
 * full-text GETs equals the number of attachments that actually have text, the minimum
 * possible. Resolving it per item instead would cost an extra children request for all
 * 5000 items, most of them for nothing.
 *
 * Never throws: a library whose full-text endpoints are unreachable (a cloud key without
 * file access, an offline desktop app) degrades to a metadata-only build with a reason
 * the caller can surface, rather than failing the whole index.
 */
export async function createFulltextSource(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  opts: { maxChars?: number } = {},
): Promise<FulltextSource> {
  const maxChars = opts.maxChars ?? DEFAULT_FULLTEXT_MAX_CHARS;

  let withText: Record<string, number>;
  try {
    withText = (await ctx.router.fullTextSince(0, { library })) ?? {};
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return emptySource(
      `Zotero's full-text index could not be listed (${why}). The index was built from metadata only. ` +
        'Full-text indexing needs either the Zotero desktop app running, or a cloud API key with file access.',
    );
  }

  const total = Object.keys(withText).length;
  // A library with nothing extracted used to return here, and that early return was itself
  // the skip this ticket is about: it is precisely the case where EVERY attachment is
  // present without text, and it recorded none of them. So the walk below still runs, on a
  // much shorter leash (MAX_PENDING_PAGES), for the record alone.
  const pageCeiling = total === 0 ? MAX_PENDING_PAGES : MAX_ATTACHMENT_PAGES;

  const byItem = new Map<string, string[]>();
  const pending = new Set<string>();
  let mapped = 0;
  try {
    let start = 0;
    for (let page = 0; page < pageCeiling; page++) {
      const res = await ctx.router.searchItems({
        library,
        itemType: 'attachment',
        limit: ATTACHMENT_PAGE_SIZE,
        start,
      });
      const items = res.data ?? [];
      if (items.length === 0) break;
      for (const it of items) {
        const d = it.data ?? it;
        const key = it.key ?? d.key;
        if (!key) continue;
        // A top-level attachment (no parent) is itself the indexed item.
        const parent = d.parentItem ?? key;
        if (!(key in withText)) {
          // Present without text: Zotero holds the attachment but has not extracted it
          // (a PDF never opened in the app). Recorded, not skipped — see pendingItems.
          if (pending.size < MAX_PENDING_ITEMS) pending.add(parent);
          continue;
        }
        const list = byItem.get(parent);
        if (list) list.push(key);
        else byItem.set(parent, [key]);
        mapped++;
      }
      start += items.length;
      if (res.totalResults && start >= res.totalResults) break;
      // Every attachment that HAS text has been located, so nothing further can be mapped.
      // The pending record is best effort past this point — see FulltextSource.pendingItems.
      if (total > 0 && mapped >= total) break;
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (total === 0) {
      // No text was ever going to come of this walk; it was buying the pending record.
      ctx.logger.debug(`Attachment walk stopped early while recording pending items: ${why}`);
    } else if (mapped === 0) {
      // Whatever was mapped before the failure is still usable; only say so when nothing was.
      return emptySource(`Attachments could not be listed (${why}). The index was built from metadata only.`);
    } else {
      ctx.logger.warn(`Full-text mapping stopped early after ${mapped}/${total} attachments: ${why}`);
    }
  }

  let failures = 0;
  const textFor = async (itemKey: string): Promise<string | undefined> => {
    const keys = byItem.get(itemKey);
    if (!keys) return undefined;
    const parts: string[] = [];
    let used = 0;
    for (const key of keys) {
      if (maxChars > 0 && used >= maxChars) break;
      let content = '';
      try {
        const ft = await ctx.router.getFullText(key, { library });
        content = typeof ft?.content === 'string' ? ft.content : '';
      } catch (e) {
        // One unreadable attachment must not abort the build: skip it, and say so once.
        if (failures++ === 0) {
          ctx.logger.warn(
            `Could not read full text for attachment ${key}: ${e instanceof Error ? e.message : String(e)}. ` +
              'Those items are indexed from metadata only.',
          );
        }
        continue;
      }
      if (!content) continue;
      const slice = maxChars > 0 ? content.slice(0, maxChars - used) : content;
      parts.push(slice);
      used += slice.length;
    }
    return parts.length ? parts.join('\n\n') : undefined;
  };

  // An item with both an extracted attachment and an unextracted one is not pending: it
  // already contributes body text, and a delta re-probing it would buy a second copy of
  // what the index has. Pending means "this item has nothing indexed and might later".
  for (const key of byItem.keys()) pending.delete(key);

  if (total === 0) {
    const waiting = pending.size
      ? ` ${pending.size} item(s) hold an attachment awaiting extraction; a later refresh will index them.`
      : '';
    return emptySource(
      'Zotero reports no attachments with extracted full text in this library, so there was nothing to index. ' +
        `Zotero extracts a PDF the first time it is opened in the app; open some, then rebuild.${waiting}`,
      [...pending],
    );
  }

  // Advance the full-text watermark ONLY when every attachment that has text was located.
  // The walk above exits early on an error, and `mapped < total` then means some extracted
  // attachments were never mapped to a parent and so were never indexed. Seeding the
  // watermark past them would hide them from every future delta — seeding it wrong in the
  // direction where nothing ever looks newly extracted, which 0012 names as the failure
  // that hides itself.
  const fulltextVersion = mapped >= total ? highestVersion(withText) : 0;
  return { textFor, attachments: mapped, items: byItem.size, pendingItems: [...pending], fulltextVersion };
}
