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

export interface FulltextSource {
  /** Concatenated, capped full text of one item's attachments (undefined when it has none). */
  textFor(itemKey: string): Promise<string | undefined>;
  /** Attachments with indexed full text that this source can serve. */
  attachments: number;
  /** Items those attachments belong to. */
  items: number;
  /** Set when full text cannot be indexed at all; the build then stays metadata-only. */
  unavailable?: string;
}

/** An inert source, for "full text requested but not obtainable". */
function emptySource(unavailable?: string): FulltextSource {
  const src: FulltextSource = { textFor: async () => undefined, attachments: 0, items: 0 };
  if (unavailable) src.unavailable = unavailable;
  return src;
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
  if (total === 0) {
    return emptySource(
      'Zotero reports no attachments with extracted full text in this library, so there was nothing to index. ' +
        'Zotero extracts a PDF the first time it is opened in the app; open some, then rebuild.',
    );
  }

  const byItem = new Map<string, string[]>();
  let mapped = 0;
  try {
    let start = 0;
    for (let page = 0; page < MAX_ATTACHMENT_PAGES && mapped < total; page++) {
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
        if (!key || !(key in withText)) continue;
        // A top-level attachment (no parent) is itself the indexed item.
        const parent = d.parentItem ?? key;
        const list = byItem.get(parent);
        if (list) list.push(key);
        else byItem.set(parent, [key]);
        mapped++;
      }
      start += items.length;
      if (res.totalResults && start >= res.totalResults) break;
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // Whatever was mapped before the failure is still usable; only say so when nothing was.
    if (mapped === 0) {
      return emptySource(`Attachments could not be listed (${why}). The index was built from metadata only.`);
    }
    ctx.logger.warn(`Full-text mapping stopped early after ${mapped}/${total} attachments: ${why}`);
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

  return { textFor, attachments: mapped, items: byItem.size };
}
