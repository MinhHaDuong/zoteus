import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { VersionBackend } from './backend.js';

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
  /**
   * Concatenated, capped full text of one item's attachments, or undefined when the item
   * has none.
   *
   * THROWS when the text could not be read, and that distinction is the point: an
   * attachment whose read failed, and a source that never opened, used to answer with the
   * same `undefined` an item with no extracted text gets, so an update indexed that
   * nothing over the body passages it already held and then stamped past the item (#67).
   * Callers catch this per item, so one unreadable PDF still cannot abort a job.
   */
  textFor(itemKey: string): Promise<string | undefined>;
  /** Attachments with indexed full text that this source can serve. */
  attachments: number;
  /** Items those attachments belong to. */
  items: number;
  /**
   * The item keys this source can actually serve text for. Lets a build's full-text pass
   * skip everything else outright instead of asking item by item and being told no: it is
   * already resident in the map behind `textFor`, and is bounded by the attachments that
   * have extracted text, not by the size of the library.
   */
  itemKeys: Set<string>;
  /**
   * The items those attachment keys belong to. Zotero's `/fulltext?since=` answers in
   * attachment keys, and everything the index holds is keyed by the parent item, so the
   * map this source already built is what turns one into the other (#26). Attachments the
   * map does not know are dropped: they belong to items outside this library view.
   */
  itemsFor(attachmentKeys: Iterable<string>): Set<string>;
  /**
   * Highest version in Zotero's full-text sequence this source saw, i.e. the cursor to
   * store once its text has been indexed. 0 when the library has no extracted text.
   */
  maxVersion: number;
  /** Set when full text cannot be indexed at all; the build then stays metadata-only. */
  unavailable?: string;
  /**
   * Set when this source holds only part of the library's body text, or none of it because
   * it never opened: the attachment crawl did not reach the end of the library (a failed
   * request, its page ceiling, or a listing that stopped serving pages short of its own
   * total), or the census behind it failed. The cause alone, short enough to sit inside a
   * sentence the caller composes.
   *
   * What it does NOT mean is a library with nothing extracted in it, which is a complete
   * answer. An incomplete source cannot tell "this item has no text" from "this item is on
   * the part of the map I never read", so it refuses to answer at all rather than let an
   * update index that nothing over the text it already holds (#67).
   */
  incomplete?: string;
  /**
   * Attachments whose text could not be READ, as opposed to items that simply have none.
   *
   * One unreadable PDF must not abort a build, so those failures are caught and skipped —
   * but they must still be countable. A desktop app that quits partway through a full-text
   * crawl makes every remaining read fail, and without this the build would finish, report
   * `done`, and stamp itself complete with most of the body text silently missing.
   */
  readFailures(): number;
}

/**
 * An inert source, for "full text requested but not obtainable".
 *
 * `incomplete` separates the two ways of being inert. A library with nothing extracted in
 * it answers "no text" truthfully, so this source may say so. One whose census could not be
 * read knows nothing about any item, and must say THAT instead: it refuses every read, so
 * an update keeps the body text it holds and comes back for it (#67).
 */
function emptySource(unavailable?: string, incomplete?: string): FulltextSource {
  const src: FulltextSource = {
    textFor: incomplete
      ? async () => {
          throw new Error(incomplete);
        }
      : async () => undefined,
    attachments: 0,
    items: 0,
    itemKeys: new Set(),
    itemsFor: () => new Set(),
    maxVersion: 0,
    readFailures: () => 0,
  };
  if (unavailable) src.unavailable = unavailable;
  if (incomplete) src.incomplete = incomplete;
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
 * possible. Resolving it per item instead would cost an extra children request for every
 * item in the build, most of them for nothing.
 *
 * Never throws: a library whose full-text endpoints are unreachable (a cloud key without
 * file access, an offline desktop app) degrades to a metadata-only build with a reason
 * the caller can surface, rather than failing the whole index.
 */
export async function createFulltextSource(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  opts: { maxChars?: number; backend?: VersionBackend } = {},
): Promise<FulltextSource> {
  const maxChars = opts.maxChars ?? DEFAULT_FULLTEXT_MAX_CHARS;
  // The build that asked for this source has already routed itself; body text has to come
  // from the same API as the metadata it hangs off, and must not switch under it.
  const backend = opts.backend;

  let withText: Record<string, number>;
  try {
    withText = (await ctx.router.fullTextSince(0, { library, backend })) ?? {};
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return emptySource(
      `Zotero's full-text index could not be listed (${why}). The index was built from metadata only. ` +
        'Full-text indexing needs either the Zotero desktop app running, or a cloud API key with file access.',
      `Zotero's full-text index could not be listed: ${why}`,
    );
  }

  const total = Object.keys(withText).length;
  if (total === 0) {
    // Complete, and empty: Zotero was asked and answered. Not `incomplete`, so an update
    // over a library nobody has opened a PDF in goes on stamping normally.
    return emptySource(
      'Zotero reports no attachments with extracted full text in this library, so there was nothing to index. ' +
        'Zotero extracts a PDF the first time it is opened in the app; open some, then rebuild.',
    );
  }

  // The census is versioned on Zotero's own full-text sequence, so its high-water mark is
  // the cursor a later update hands back to `/fulltext?since=` (#26).
  const maxVersion = Object.values(withText).reduce((hi, v) => (v > hi ? v : hi), 0);

  const byItem = new Map<string, string[]>();
  /** The reverse of `byItem`: what `/fulltext?since=` answers in, mapped to what we index. */
  const parentOf = new Map<string, string>();
  let mapped = 0;
  /** What this map is missing, if anything; becomes `incomplete` on the source. */
  let incomplete: string | undefined;
  /**
   * Whether the crawl below got to the end of what it was walking, which is the only thing
   * that makes "this item is not in the map" mean "this item has no extracted text".
   *
   * It is tracked rather than inferred because the loop has four exits and only one of them
   * throws. Two of them are ends: every attachment that HAS text has been located (the
   * usual one, and it does not need the rest of the library), or the listing has been
   * walked to its own stated total. The other two are truncations that raise no error at
   * all: the page ceiling, and a page that comes back empty while the listing's own total
   * says there is more to come. Deriving the flag from the `catch` alone left
   * both of those stamping a census-wide cursor over a map that covered a fraction of the
   * library (#78).
   */
  let reachedEnd = false;
  /** Why the crawl stopped short, when it did so without a request failing. */
  let stoppedShort: string | undefined;
  try {
    let start = 0;
    for (let page = 0; ; page++) {
      // Every attachment with text is located. The rest of the library holds none, so
      // there is nothing further this map could learn: a complete answer, not a truncation.
      if (mapped >= total) {
        reachedEnd = true;
        break;
      }
      if (page >= MAX_ATTACHMENT_PAGES) {
        stoppedShort =
          `the crawl hit its ceiling of ${MAX_ATTACHMENT_PAGES} pages of ` +
          `${ATTACHMENT_PAGE_SIZE} attachments without reaching the end of the library`;
        break;
      }
      const res = await ctx.router.searchItems({
        library,
        backend,
        itemType: 'attachment',
        limit: ATTACHMENT_PAGE_SIZE,
        start,
      });
      const items = res.data ?? [];
      if (items.length === 0) {
        // Nothing left to read. Against the listing's own total that is either the end of
        // it, or Zotero stopping short of what it said it had; with no total to check it
        // against, an empty page is the only end there is.
        if (res.totalResults && start < res.totalResults) {
          stoppedShort = `Zotero stopped serving the attachment listing at ${start} of ${res.totalResults}`;
        } else {
          reachedEnd = true;
        }
        break;
      }
      for (const it of items) {
        const d = it.data ?? it;
        const key = it.key ?? d.key;
        if (!key || !(key in withText)) continue;
        // A top-level attachment (no parent) is itself the indexed item.
        const parent = d.parentItem ?? key;
        const list = byItem.get(parent);
        if (list) list.push(key);
        else byItem.set(parent, [key]);
        parentOf.set(key, parent);
        mapped++;
      }
      start += items.length;
      if (res.totalResults && start >= res.totalResults) {
        reachedEnd = true;
        break;
      }
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // Whatever was mapped before the failure is still usable; only say so when nothing was.
    if (mapped === 0) {
      return emptySource(
        `Attachments could not be listed (${why}). The index was built from metadata only.`,
        `attachments could not be listed: ${why}`,
      );
    }
    stoppedShort = why;
  }
  if (!reachedEnd) {
    // Usable, but no longer able to say that an item it does not hold has no text: the item
    // may simply sit on the pages this crawl never reached (#67). Same sentence whichever
    // door the crawl left by, and the same one it has always had when a request threw,
    // because that text is what a report of this quotes.
    incomplete = `the attachment map stopped early after ${mapped}/${total} attachment(s): ${stoppedShort}`;
    ctx.logger.warn(
      `Full-text mapping stopped early after ${mapped}/${total} attachments: ${stoppedShort}`,
    );
  }

  let failures = 0;
  const textFor = async (itemKey: string): Promise<string | undefined> => {
    const keys = byItem.get(itemKey);
    // Not in the map. Over a complete map that means the item has no extracted text, which
    // is an answer. Over one that stopped early it means nothing at all, and answering "no
    // text" would let an update index that over the body it already holds (#67).
    if (!keys) {
      if (incomplete) throw new Error(incomplete);
      return undefined;
    }
    const parts: string[] = [];
    let used = 0;
    for (const key of keys) {
      if (maxChars > 0 && used >= maxChars) break;
      let content = '';
      try {
        const ft = await ctx.router.getFullText(key, { library, backend });
        content = typeof ft?.content === 'string' ? ft.content : '';
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // One unreadable attachment must not abort the build, and it does not: every caller
        // catches this per item and carries on. What it must not do either is come back as
        // the `undefined` an item with no extracted text gets, because that answer is
        // indexed over the body text the item already has and stamped past (#67). The
        // item's other attachments are not read: half a body indexed under this item's
        // `#f<n>` ids would look complete to the resume filter and to the next update.
        if (failures++ === 0) {
          ctx.logger.warn(
            `Could not read full text for attachment ${key}: ${why}. Those items are indexed from metadata only.`,
          );
        }
        throw new Error(why);
      }
      if (!content) continue;
      const slice = maxChars > 0 ? content.slice(0, maxChars - used) : content;
      parts.push(slice);
      used += slice.length;
    }
    return parts.length ? parts.join('\n\n') : undefined;
  };

  return {
    textFor,
    attachments: mapped,
    items: byItem.size,
    itemKeys: new Set(byItem.keys()),
    itemsFor: (attachmentKeys) => {
      const items = new Set<string>();
      for (const key of attachmentKeys) {
        const parent = parentOf.get(key);
        if (parent) items.add(parent);
      }
      return items;
    },
    maxVersion,
    readFailures: () => failures,
    ...(incomplete ? { incomplete } : {}),
  };
}
