import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { VersionBackend } from './backend.js';
import { htmlToText } from '../fulltext/epub.js';

/** Both Zotero APIs page items 100-at-a-time. */
const PAGE_SIZE = 100;

/**
 * Ceiling on pages of child notes and annotations walked, so a library with a pathological
 * number of them cannot page forever. The walk also stops as soon as a page comes back
 * empty or the endpoint's own total is reached, which is the usual exit.
 */
const MAX_PAGES = 500;

/**
 * How many attachment keys one `itemKey=` lookup asks for; also the page size the update's
 * own-words catch-up re-reads items in. Fifty is the Web API's documented ceiling for that
 * parameter.
 *
 * An annotation names the attachment it sits on, never the item that attachment belongs to,
 * so that second hop has to be resolved somewhere. Asking for exactly the attachments that
 * carry an annotation costs a handful of requests, where paging the whole attachment set
 * costs one per hundred attachments in the library, most of them for nothing.
 */
export const OWN_WORDS_KEY_BATCH = 50;

/**
 * Cap on indexed own-words characters per item. Well below the full-text cap on purpose:
 * this is what a reader wrote, not what a publisher printed, and an item carrying more of
 * its reader's text than of its own is a note used as a scratch file rather than a body of
 * prose worth chunking end to end. 0 = no cap.
 */
export const DEFAULT_OWN_WORDS_MAX_CHARS = 20_000;

/** One passage of the reader's own text, and which kind of thing he wrote it in. */
export interface OwnWords {
  kind: 'note' | 'annotation';
  text: string;
}

export interface OwnWordsSource {
  /**
   * The notes and annotations hanging off one item, capped, in crawl order. Resident by the
   * time anything asks: the whole census is one paged read plus one lookup per fifty
   * annotated attachments, so this is a map lookup rather than a request per item.
   */
  wordsFor(itemKey: string): OwnWords[];
  /**
   * Every item this crawl saw a child note or annotation on, whether or not that child had
   * any text left in it. Wider than the key set behind `wordsFor` for one case that matters
   * to an update: emptying a note is a change, and the item still has to be re-indexed for
   * the passage it used to have to go away.
   */
  itemKeys: Set<string>;
  /** Child notes this source found text in. */
  notes: number;
  /** Annotations it found text in, and could attribute to an item. */
  annotations: number;
  /** Items those notes and annotations belong to. */
  items: number;
  /** Set when own words cannot be crawled at all; the build then indexes without them. */
  unavailable?: string;
}

/** An inert source, for "own words requested but not obtainable". */
function emptySource(unavailable?: string): OwnWordsSource {
  const src: OwnWordsSource = {
    wordsFor: () => [],
    itemKeys: new Set(),
    notes: 0,
    annotations: 0,
    items: 0,
  };
  if (unavailable) src.unavailable = unavailable;
  return src;
}

/**
 * The searchable text of one annotation.
 *
 * The comment leads because it is the sentence the reader typed; the highlight follows
 * because it is the passage he chose to keep. Both are indexed and neither is labelled in
 * the text: a marker like "Comment:" would be a token BM25 scores, and it would score in
 * every annotation in the library at once.
 */
function annotationText(d: any): string {
  return [d.annotationComment, d.annotationText]
    .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Build the map from an item to the notes and annotations its reader wrote on it.
 *
 * Two library-wide reads rather than per-item probing, the same shape as the attachment
 * crawl in `fulltext-source.ts`: one paged `itemType=note || annotation` walk names every
 * child note and every annotation in the library, and one `itemKey=` lookup per fifty
 * annotated attachments resolves the hop an annotation cannot make on its own. A library
 * with neither costs a single request that answers with nothing.
 *
 * A note with no `parentItem` is skipped, not lost: a standalone note IS a top-level item,
 * so the metadata pass has already indexed its text as that item's own. Only a child note
 * needs attaching to something else.
 *
 * `opts.since` narrows the same crawl to what Zotero has changed since a library version,
 * which is what an update asks for. Child items carry their own version in the library's
 * own sequence — unlike extracted full text, which has a sequence of its own (#26) — so no
 * second cursor is needed here: the stamp the index already holds is the right question to
 * ask.
 *
 * Never throws: a library whose child items cannot be listed degrades to an index without
 * own words, and a reason the caller can surface, rather than failing the whole build.
 */
export async function createOwnWordsSource(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  opts: { maxChars?: number; backend?: VersionBackend; since?: number } = {},
): Promise<OwnWordsSource> {
  const maxChars = opts.maxChars ?? DEFAULT_OWN_WORDS_MAX_CHARS;
  // The build that asked for this source has already routed itself; its own words have to
  // come from the same API as the metadata they hang off, and must not switch under it.
  const backend = opts.backend;

  const byItem = new Map<string, OwnWords[]>();
  /** Annotations held by the attachment they sit on, until that attachment names its item. */
  const byAttachment = new Map<string, OwnWords[]>();
  /** Every parent seen, text or not; the attachment half is resolved with the rest below. */
  const touchedItems = new Set<string>();
  const touchedAttachments = new Set<string>();
  let notes = 0;
  let annotations = 0;

  const add = (map: Map<string, OwnWords[]>, key: string, words: OwnWords): void => {
    const list = map.get(key);
    if (list) list.push(words);
    else map.set(key, [words]);
  };

  try {
    let start = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await ctx.router.searchItems({
        library,
        backend,
        // One crawl for both kinds, not two: the boolean `itemType` filter is what both
        // APIs offer for exactly this, and the pages come back interleaved either way.
        itemType: 'note || annotation',
        limit: PAGE_SIZE,
        start,
        ...(opts.since === undefined ? {} : { since: opts.since }),
      });
      const items = res.data ?? [];
      if (items.length === 0) break;
      for (const it of items) {
        const d = it.data ?? it;
        const parent = d.parentItem;
        if (!parent) continue; // a standalone note; the metadata pass already has it
        if (d.itemType === 'annotation') {
          touchedAttachments.add(parent);
          const text = annotationText(d);
          if (!text) continue; // a bare highlight with no comment carries no words of its own
          add(byAttachment, parent, { kind: 'annotation', text });
          annotations++;
        } else {
          touchedItems.add(parent);
          const text = htmlToText(typeof d.note === 'string' ? d.note : '');
          if (!text) continue;
          add(byItem, parent, { kind: 'note', text });
          notes++;
        }
      }
      start += items.length;
      if (res.totalResults && start >= res.totalResults) break;
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (touchedItems.size === 0 && touchedAttachments.size === 0) {
      return emptySource(
        `Notes and annotations could not be listed (${why}). The index was built without them, so text that ` +
          'exists only in your own notes or PDF annotations is not searchable.',
      );
    }
    ctx.logger.warn(`Own-words crawl stopped early after ${notes} note(s) and ${annotations} annotation(s): ${why}`);
  }

  // The second hop. Only the attachments that actually carry an annotation are asked for,
  // so a library nobody annotates pays nothing here at all.
  if (touchedAttachments.size > 0) {
    const keys = [...touchedAttachments];
    try {
      for (let i = 0; i < keys.length; i += OWN_WORDS_KEY_BATCH) {
        const batch = keys.slice(i, i + OWN_WORDS_KEY_BATCH);
        const res = await ctx.router.searchItems({
          library,
          backend,
          itemKey: batch.join(','),
          limit: OWN_WORDS_KEY_BATCH,
        });
        for (const it of res.data ?? []) {
          const d = it.data ?? it;
          const key = it.key ?? d.key;
          if (!key || !touchedAttachments.has(key)) continue;
          // A top-level attachment (no parent) is itself the indexed item, exactly as the
          // full-text crawl treats it.
          const item = d.parentItem ?? key;
          touchedItems.add(item);
          for (const words of byAttachment.get(key) ?? []) add(byItem, item, words);
          byAttachment.delete(key);
        }
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      ctx.logger.warn(`Some annotations could not be attributed to their item (${why}); they are not indexed.`);
    }
    // Whatever is still held here names an attachment the lookup never answered for: those
    // annotations belong to an item outside this library view, or to one the crawl could
    // not reach. Either way there is nothing to hang them off, so they are not counted as
    // indexed — a count that included them would say more was covered than was.
    for (const list of byAttachment.values()) annotations -= list.length;
  }

  return {
    wordsFor: (itemKey: string): OwnWords[] => {
      const all = byItem.get(itemKey);
      if (!all) return [];
      if (maxChars <= 0) return all;
      const out: OwnWords[] = [];
      let used = 0;
      for (const words of all) {
        if (used >= maxChars) break;
        const text = words.text.slice(0, maxChars - used);
        out.push({ kind: words.kind, text });
        used += text.length;
      }
      return out;
    },
    itemKeys: touchedItems,
    notes,
    annotations,
    items: byItem.size,
  };
}
