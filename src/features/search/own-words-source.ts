import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { OwnWordsEntry, VersionBackend } from './backend.js';
import { htmlToText } from '../../lib/html-text.js';

/**
 * Cap on indexed own-words characters per item. Generous: it is the reader's own writing,
 * which is short by nature — a heavily annotated paper is a few thousand characters of
 * highlights and comments, where its PDF is tens of thousands. The cap exists for the
 * single 200-page research note, so one item cannot dominate a build.
 */
export const OWN_WORDS_MAX_CHARS = 40_000;

/** Both Zotero APIs page items 100-at-a-time. */
const CHILD_PAGE_SIZE = 100;

/**
 * Ceiling on child pages walked, so a pathological library cannot page forever. 100k notes
 * and annotations is far past any real library.
 */
const MAX_CHILD_PAGES = 1000;

/**
 * Attachment keys resolved per request. Zotero's `itemKey` filter takes a comma-separated
 * list and the documented ceiling is 50, which is what makes attributing annotations cost
 * a request per fifty ANNOTATED attachments rather than a `/children` request per item.
 */
const KEY_BATCH = 50;

/** Page size for the keys-only census, which returns a key and an integer per child. */
const VERSIONS_PAGE_SIZE = 5000;

/** Ceiling on those pages, so a pathological library cannot page forever. */
const MAX_VERSION_PAGES = 200;

/** An inert source, for "own words wanted but not obtainable". */
function emptySource(unavailable?: string): OwnWordsSource {
  const src: OwnWordsSource = {
    textsFor: () => [],
    itemsFor: () => new Set(),
    notes: 0,
    annotations: 0,
    items: 0,
  };
  if (unavailable) src.unavailable = unavailable;
  return src;
}

/**
 * The census, resident. Both accessors are synchronous because by the time anything holds
 * one of these, every answer is already in memory: the crawl is what `createOwnWordsSource`
 * awaited. The asynchronous face an index build sees is `OwnWordsAccess`, which is this
 * behind a lazy open plus the one question that does NOT need it (`childVersions`).
 */
export interface OwnWordsSource {
  /** The reader's own words for one indexed item, in a stable order, capped per item. */
  textsFor(itemKey: string): OwnWordsEntry[];
  /** The items these note/annotation keys belong to; keys it does not know are dropped. */
  itemsFor(childKeys: Iterable<string>): Set<string>;
  /** Child notes attributed to an indexed item. */
  notes: number;
  /** Annotations attributed to one, through the attachment they sit on. */
  annotations: number;
  /** Items those add up to. */
  items: number;
  /** Set when own words cannot be indexed at all; the build then leaves them out. */
  unavailable?: string;
}

/**
 * Every note and annotation key in the library, mapped to its version, without touching
 * the census.
 *
 * This is the question an update asks FIRST, and usually the only one it asks. Keys and
 * integers only, `?format=versions` with the same `itemType` filter the census crawls by
 * (both APIs honour it — verified against the desktop app, where it answers 616 of 1255
 * items), so it is one request per 5000 children. An update where nothing was written or
 * highlighted compares this against what the index already holds, finds no difference, and
 * never pays for the crawl.
 */
export async function fetchChildVersions(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  backend?: VersionBackend,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let start = 0;
  for (let page = 0; page < MAX_VERSION_PAGES; page++) {
    const res = await ctx.router.itemVersions({
      library,
      backend,
      itemType: 'note || annotation',
      limit: VERSIONS_PAGE_SIZE,
      start,
    });
    const batch = Object.entries(res.versions ?? {});
    for (const [key, version] of batch) out.set(key, Number(version) || 0);
    // Advance by what came back, not by the page size asked for: the endpoint commonly
    // answers with the whole set at once, and may cap the page at its own limit.
    if (!batch.length) break;
    start += batch.length;
    if (res.totalResults && start >= res.totalResults) break;
  }
  return out;
}

/** The reader's own text out of one child item, or '' when it holds none. */
function textOf(d: any): string {
  if (d?.itemType === 'note') return htmlToText(String(d.note ?? ''));
  // A highlight and its comment together: the comment is the reader's own sentence, and
  // the highlighted passage is the judgement they made about someone else's — which is
  // exactly what makes "find where I marked this" a query worth answering.
  const parts = [d?.annotationText, d?.annotationComment].filter((p) => typeof p === 'string' && p.trim());
  return parts.join('\n\n');
}

/**
 * Census the library's child notes and PDF annotations, attributed to the items they hang
 * off, so a build can index the reader's own words alongside each item's metadata (#33).
 *
 * Two reads, both library-wide and both cheap. `itemType=note || annotation` returns every
 * child in one paged crawl (a page per hundred children, not a `/children` request per
 * item), with its text already in the response. Then the one thing that crawl cannot say:
 * an annotation names the ATTACHMENT it sits on, never the item that attachment belongs
 * to, so the attachments that carry annotations are resolved in batches of fifty through
 * the `itemKey` filter. Nothing here is per indexed item.
 *
 * Never throws. A library whose children cannot be listed degrades to an index without own
 * words and a reason the caller can surface, which is what the metadata-only build has
 * always been.
 */
export async function createOwnWordsSource(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  opts: { maxChars?: number; backend?: VersionBackend } = {},
): Promise<OwnWordsSource> {
  const maxChars = opts.maxChars ?? OWN_WORDS_MAX_CHARS;
  // The build that asked for this has already routed itself; own words must come from the
  // same API as the metadata they hang off, and must not switch under it.
  const backend = opts.backend;

  /** Children by the key they name as their parent: an item for notes, an attachment for annotations. */
  const byParent = new Map<string, OwnWordsEntry[]>();
  /** The attachment keys that turned up as annotation parents, awaiting their own parents. */
  const attachments = new Set<string>();
  let notes = 0;
  let annotations = 0;

  try {
    let start = 0;
    for (let page = 0; page < MAX_CHILD_PAGES; page++) {
      const res = await ctx.router.searchItems({
        library,
        backend,
        // The boolean filter both APIs accept, so one crawl covers both kinds. A library
        // that holds none of either answers `Total-Results: 0` and this stops at once.
        itemType: 'note || annotation',
        limit: CHILD_PAGE_SIZE,
        start,
      });
      const items = res.data ?? [];
      if (items.length === 0) break;
      for (const it of items) {
        const d = it.data ?? it;
        const key = it.key ?? d.key;
        const parent = d?.parentItem;
        // A note with no parent is a top-level item in its own right: the metadata crawl
        // already indexes it, `note` included, and claiming it here would index it twice.
        if (!key || !parent) continue;
        const text = textOf(d);
        if (!text) continue;
        const kind: 'note' | 'annotation' = d.itemType === 'annotation' ? 'annotation' : 'note';
        if (kind === 'annotation') attachments.add(parent);
        const list = byParent.get(parent);
        if (list) list.push({ key, kind, text });
        else byParent.set(parent, [{ key, kind, text }]);
        if (kind === 'annotation') annotations++;
        else notes++;
      }
      start += items.length;
      if (res.totalResults && start >= res.totalResults) break;
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (byParent.size === 0) {
      return emptySource(
        `The library's notes and annotations could not be listed (${why}), so the index holds each item's ` +
          'metadata but not the reader\'s own words. Re-run zotero_index action:"build" to try again.',
      );
    }
    ctx.logger.warn(`Own-words census stopped early after ${byParent.size} parent(s): ${why}`);
  }

  if (byParent.size === 0) return emptySource();

  /** attachment key -> the item it belongs to (itself, when it is top-level). */
  const itemOfAttachment = new Map<string, string>();
  if (attachments.size) {
    const keys = [...attachments];
    for (let i = 0; i < keys.length; i += KEY_BATCH) {
      const batch = keys.slice(i, i + KEY_BATCH);
      try {
        const res = await ctx.router.searchItems({
          library,
          backend,
          itemKey: batch.join(','),
          // Not decoration: the desktop API answers an `itemKey` lookup with the named
          // items AND every descendant they have, so a batch of fifty annotated
          // attachments comes back as thousands of annotation rows and the attachments
          // this is looking for fall off the end of the page. Naming the type asks for
          // exactly the fifty rows wanted, on both APIs.
          itemType: 'attachment',
          limit: KEY_BATCH,
        });
        for (const it of res.data ?? []) {
          const d = it.data ?? it;
          const key = it.key ?? d.key;
          if (!key) continue;
          // A top-level attachment (no parent) is itself the indexed item, the same rule
          // the full-text source resolves attachments by.
          itemOfAttachment.set(key, d.parentItem ?? key);
        }
      } catch (e) {
        // The annotations on this batch stay unattributed rather than mis-attributed, and
        // the rest of the census is still worth having.
        ctx.logger.warn(
          `Could not resolve ${batch.length} annotated attachment(s) to their items: ` +
            `${e instanceof Error ? e.message : String(e)}. Those annotations are not indexed.`,
        );
      }
    }
  }

  /** The finished census: item key -> its own words, and the reverse map for a delta. */
  const byItem = new Map<string, OwnWordsEntry[]>();
  const itemOfChild = new Map<string, string>();
  for (const [parent, entries] of byParent) {
    for (const entry of entries) {
      // Notes name their item directly; annotations name an attachment that had to be
      // resolved, and one that could not be is dropped rather than attributed to itself.
      const item = entry.kind === 'annotation' ? itemOfAttachment.get(parent) : parent;
      if (!item) continue;
      const list = byItem.get(item);
      if (list) list.push(entry);
      else byItem.set(item, [entry]);
      itemOfChild.set(entry.key, item);
    }
  }
  // Sorted by child key so a rebuild produces the same passages in the same order whatever
  // order the API paged them in.
  for (const entries of byItem.values()) entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  ctx.logger.info(
    `Own words: ${notes} note(s) and ${annotations} annotation(s) over ${byItem.size} item(s).`,
  );

  return {
    textsFor: (itemKey) => {
      const entries = byItem.get(itemKey);
      if (!entries) return [];
      if (maxChars <= 0) return entries;
      // Capped across the item's own words as a whole, in child-key order, so the cap
      // takes effect at the same place on every rebuild.
      const out: OwnWordsEntry[] = [];
      let used = 0;
      for (const entry of entries) {
        if (used >= maxChars) break;
        const text = entry.text.slice(0, maxChars - used);
        out.push({ ...entry, text });
        used += text.length;
      }
      return out;
    },
    itemsFor: (childKeys) => {
      const items = new Set<string>();
      for (const key of childKeys) {
        const item = itemOfChild.get(key);
        if (item) items.add(item);
      }
      return items;
    },
    notes,
    annotations,
    items: byItem.size,
  };
}
