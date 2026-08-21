import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { IndexBackend, IndexDelta } from './index-manager.js';
import { PAGE_SIZE, startIndexBuild } from './build.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from './fulltext-source.js';

/**
 * Bringing the search index up to date at query time, instead of only when someone
 * remembers to rebuild it.
 *
 * Until this module existed `buildIncremental` called `reset()` on every run, so — despite
 * the name — every build was a full rebuild, and nothing ever revisited the library
 * afterwards. An added paper was invisible until a manual rebuild, and a deleted one went
 * on answering queries forever, which is the failure this file exists to end.
 *
 * The protocol is three questions, asked only as far as the answers require:
 *
 *   1. Is the watermark comparable at all? (a label check — zero requests)
 *   2. What version is the library at now? (ONE request; equal → serve, and stop here)
 *   3. What changed? (`?since=`), and what is gone? (`?format=versions`)
 *
 * Step 2 is the budget. A library that has not changed since the last build costs exactly
 * one request per query, and that is the exit criterion this design is written against.
 */

/**
 * Ceiling on a delta before a background rebuild is the better answer.
 *
 * A delta is item-at-a-time: it pages the changes, then re-chunks and re-embeds each one.
 * Past a few hundred items that is slower than the crawl it is trying to avoid, and it is
 * happening inline, in front of a user waiting for search results. The usual cause of a
 * delta this size is not editing — it is a library that was resynced, or a watermark from
 * far enough back that "the delta" is most of the library.
 */
export const MAX_DELTA_ITEMS = 500;

/**
 * The same ceiling when full text is on, and an order of magnitude lower.
 *
 * A metadata delta re-indexes an item from a page it already has. A full-text one costs a
 * children listing plus a read per attachment, per item — so five hundred items is a
 * thousand requests in front of a waiting user, and it would blow the deadline below every
 * single time, which would mean the delta never landing at all rather than landing late.
 */
export const MAX_FULLTEXT_DELTA_ITEMS = 50;

/**
 * Wall-clock ceiling on the whole refresh. A query must not become an unbounded wait
 * because Zotero is slow, so the deadline is checked before each request and the first
 * request is raced against it.
 *
 * Racing bounds the WAIT, not the request: nothing here can cancel a fetch already in
 * flight, and pretending otherwise would be the more comfortable lie. What it guarantees
 * is that the caller gets its results.
 */
export const DEFAULT_REFRESH_TIMEOUT_MS = 8_000;

/**
 * How long to stop asking after Zotero proves unreachable. Without it, a closed desktop
 * app means every single query pays a connection failure before returning results it
 * already had.
 */
export const UNREACHABLE_BACKOFF_MS = 60_000;


export type RefreshState =
  /** The JSON backend, which does not do deltas at all. Zero requests, by design. */
  | 'unsupported'
  /** Turned off with ZOTEUS_INDEX_AUTO_REFRESH=false. */
  | 'disabled'
  /** A build or another refresh is running; this one stands down rather than racing it. */
  | 'busy'
  /** Nothing indexed yet — that is the auto-build's job, not a delta's. */
  | 'empty'
  /** The library is at the version the index was built from. The one-request path. */
  | 'fresh'
  /** A delta was computed and applied. */
  | 'applied'
  /** The watermark could not be used; a full background rebuild was started instead. */
  | 'rebuilding'
  /** Zotero could not be reached. The index is served as it stands. */
  | 'unreachable'
  /** The delta was abandoned (too large, too slow, or it threw). The index still serves. */
  | 'skipped';

export interface RefreshOutcome {
  state: RefreshState;
  /** Requests spent. `fresh` must be 1 — that is the budget this module is held to. */
  requests: number;
  version?: number;
  reindexed?: number;
  removed?: number;
  detail?: string;
}

export interface RefreshOptions {
  timeoutMs?: number;
  maxDeltaItems?: number;
}

/**
 * Per-context refresh state: the in-flight promise and the unreachable backoff.
 *
 * A WeakMap rather than fields on ToolContext because it is this module's private
 * bookkeeping and nothing else has any business reading it; contexts are long-lived
 * objects, and one that goes away takes its entry with it.
 */
interface RefreshMemo {
  inFlight?: Promise<RefreshOutcome>;
  retryAfter?: number;
}
const MEMO = new WeakMap<ToolContext, RefreshMemo>();

function memo(ctx: ToolContext): RefreshMemo {
  let m = MEMO.get(ctx);
  if (!m) MEMO.set(ctx, (m = {}));
  return m;
}

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Bound a wait without pretending to cancel the work behind it.
 *
 * The timer is cleared on both paths: an 8-second handle left armed keeps the event loop
 * alive that much longer after a process asks to shut down.
 */
async function withDeadline<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  const left = deadline - Date.now();
  if (left <= 0) throw new Error(`${what} timed out`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${left} ms`)), left);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Bring the index up to date if the library has moved, then return. Never throws, and
 * never leaves the caller without an index: every failure path degrades to serving what
 * is already indexed.
 */
export async function refreshIndexIfStale(
  ctx: ToolContext,
  lib?: LibraryRef,
  opts: RefreshOptions = {},
): Promise<RefreshOutcome> {
  // The JSON backend keeps exactly the behaviour it had: no freshness check, no requests,
  // full rebuild only. See SearchIndex.supportsDelta for why that is a property of the
  // store and not a policy choice.
  if (!ctx.search.supportsDelta) return { state: 'unsupported', requests: 0 };
  if (!ctx.config.indexAutoRefresh) return { state: 'disabled', requests: 0 };
  // Never beside a running build: it is rewriting the very rows a delta would edit, and
  // its own watermark lands when it finishes.
  if (ctx.search.isBuilding) return { state: 'busy', requests: 0 };
  // An empty index has nothing to bring up to date. The auto-build in
  // zotero_semantic_search owns that case, and it starts a full crawl rather than a delta.
  if (ctx.search.isEmpty) return { state: 'empty', requests: 0 };

  const m = memo(ctx);
  // Two queries arriving together must not both probe. The second joins the first.
  if (m.inFlight) return m.inFlight;
  if (m.retryAfter !== undefined && Date.now() < m.retryAfter) {
    return { state: 'unreachable', requests: 0, detail: 'Zotero was unreachable recently; not re-probing yet.' };
  }

  const run = runRefresh(ctx, lib, opts).finally(() => {
    m.inFlight = undefined;
  });
  m.inFlight = run;
  return run;
}

async function runRefresh(ctx: ToolContext, lib: LibraryRef | undefined, opts: RefreshOptions): Promise<RefreshOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
  const backend = ctx.router.backendFor(lib);
  const { version: watermark, backend: label } = ctx.search.watermark;
  // A SECOND watermark, on a sequence with no relation to the first (ticket 0012). Read
  // here rather than inside addNewlyExtracted so the two travel together through DeltaRun
  // and cannot be confused at the call site, which is exactly how they came to be.
  const fulltextWatermark = ctx.search.fulltextWatermark;

  // Geometry first, for the same reason the label check comes before any request: its
  // verdict does not depend on the library's version either, and a delta that ran would
  // write new-geometry passages beside old-geometry ones (ticket 0007). Nothing would
  // error; the index would just become a mixture whose BM25 lengths average two
  // populations.
  const geometry = ctx.search.geometryMismatch;
  if (geometry) {
    ctx.logger.info(
      `Search index: rebuilding rather than computing a delta — its passages were chunked at ` +
        `${geometry.stored} and this process is configured for ${geometry.configured}. Passages cut ` +
        'at two geometries cannot be ranked against each other, so the index is rebuilt once.',
    );
    return rebuild(ctx, lib, 0, `index chunked at ${geometry.stored}, configured for ${geometry.configured}`);
  }

  // The label check comes next, before any request, because its verdict does not depend
  // on the library's version: an unusable watermark means a rebuild whatever the number.
  if (label !== backend) {
    const from = label ?? 'an unlabelled build';
    ctx.logger.info(
      `Search index: rebuilding rather than computing a delta — it was built from ${from} ` +
        `and this library is now served by the ${backend} Zotero API. The two keep unrelated ` +
        'version sequences, so the recorded watermark cannot be compared.',
    );
    return rebuild(ctx, lib, 0, `watermark came from ${from}, reads are served by ${backend}`);
  }

  let version: number;
  try {
    version = await withDeadline(ctx.router.libraryVersion({ library: lib }), deadline, 'library version');
  } catch (e) {
    // Offline is not an error the caller should see. Serve the index we have, and stop
    // asking for a while.
    memo(ctx).retryAfter = Date.now() + UNREACHABLE_BACKOFF_MS;
    ctx.logger.debug(`Search index freshness check skipped, Zotero unreachable: ${why(e)}`);
    return { state: 'unreachable', requests: 1, detail: why(e) };
  }
  memo(ctx).retryAfter = undefined;

  // A library that reports no version cannot be compared to anything. Serving the index
  // unchanged is the only answer that cannot be wrong.
  if (!Number.isFinite(version) || version <= 0) {
    return { state: 'skipped', requests: 1, detail: 'library reported no version' };
  }
  // THE BUDGET. Nothing changed, one request spent, results served from the index.
  if (version === watermark) return { state: 'fresh', requests: 1, version };
  if (version < watermark) {
    // The library went backwards: restored from a backup, or this is a different library
    // behind the same address. Either way the watermark describes a history that is no
    // longer this one, and a `?since=` against it would return nothing at all — a delta
    // that silently indexes no change and declares the index current.
    return rebuild(ctx, lib, 1, `library version ${version} is below the watermark ${watermark}`);
  }

  try {
    return await applyDelta(ctx, lib, { watermark, fulltextWatermark, version, backend, deadline, opts });
  } catch (e) {
    // The watermark has NOT moved, so the next query retries the same delta. That is the
    // point of moving it only once everything has landed.
    ctx.logger.warn(`Search index delta abandoned (the index still serves its previous contents): ${why(e)}`);
    return { state: 'skipped', requests: 1, detail: why(e) };
  }
}

/** Start a full background rebuild and let the caller serve whatever is indexed now. */
function rebuild(ctx: ToolContext, lib: LibraryRef | undefined, requests: number, detail: string): RefreshOutcome {
  try {
    startIndexBuild(ctx, lib);
  } catch (e) {
    // startIndexBuild throws only when a build is already running, which is the outcome
    // wanted anyway.
    ctx.logger.debug(`Rebuild request ignored: ${why(e)}`);
  }
  return { state: 'rebuilding', requests, detail };
}

interface DeltaRun {
  /** Where the index sits on the **item** sequence (`Last-Modified-Version`). */
  watermark: number;
  /**
   * Where it sits on the **full-text** sequence. A different number from a different
   * counter: on the library that motivated 0012, 410 against a full-text range running to
   * 25 036. Passing `watermark` here is the defect that ticket names.
   */
  fulltextWatermark: number;
  version: number;
  backend: IndexBackend;
  deadline: number;
  opts: RefreshOptions;
}

async function applyDelta(ctx: ToolContext, lib: LibraryRef | undefined, run: DeltaRun): Promise<RefreshOutcome> {
  // Read up front: whether body text is in play sets the ceiling on how much of this the
  // delta is allowed to do inline.
  const status = ctx.search.buildStatus();
  const wantFulltext = status.fulltextEnabled;
  const maxItems = run.opts.maxDeltaItems ?? (wantFulltext ? MAX_FULLTEXT_DELTA_ITEMS : MAX_DELTA_ITEMS);
  let requests = 1; // the version probe

  const check = (what: string): void => {
    if (Date.now() > run.deadline) throw new Error(`${what} exceeded the refresh deadline`);
  };

  // ---- additions and modifications -------------------------------------------------
  const changedItems: any[] = [];
  let start = 0;
  for (;;) {
    check('delta paging');
    const page = await ctx.router.searchItems({
      library: lib,
      limit: PAGE_SIZE,
      start,
      top: true,
      since: run.watermark,
    });
    requests++;
    if (start === 0 && page.totalResults > maxItems) {
      return rebuild(ctx, lib, requests, `${page.totalResults} items changed, past the ${maxItems}-item delta ceiling`);
    }
    const items = page.data ?? [];
    if (items.length === 0) break;
    // No clamp against `indexMaxItems` here, and that is a decision rather than an
    // oversight. On a library truncated by the build cap, a delta will index changed items
    // from beyond it, so the index drifts ABOVE the cap over time. The cap bounds the cost
    // of a crawl; a delta's cost is bounded by MAX_DELTA_ITEMS instead, and refusing a
    // changed item because of where it fell in an old crawl's page order would mean
    // silently declining to index something the user just edited.
    changedItems.push(...items);
    start += items.length;
    if (changedItems.length >= maxItems) break;
    if (page.totalResults && start >= page.totalResults) break;
  }

  // ---- deletions -------------------------------------------------------------------
  //
  // `/deleted?since=` would be the obvious endpoint and it cannot be used: it is a cloud
  // sync endpoint, and the desktop local API answers it with 404. So deletions are found
  // by subtraction instead — one `?format=versions` request returns a key -> version map
  // for the whole library, and anything the index holds that the map does not, Zotero no
  // longer has. One request and one indexed query (`SELECT DISTINCT item FROM
  // passage_meta`), with no scan on either side.
  //
  // The map covers child items too, where the index holds only top-level ones, so the
  // subtraction runs in the safe direction: indexed keys are a subset of library keys,
  // and an extra key in the map can never cause a deletion.
  check('deletion scan');
  const liveKeys = await ctx.router.itemVersions({ library: lib });
  requests++;
  const removed: string[] = [];
  if (liveKeys && typeof liveKeys === 'object') {
    for (const key of ctx.search.indexedItemKeys()) {
      if (!(key in liveKeys)) removed.push(key);
    }
  }

  // ---- attachments Zotero has extracted since the watermark -------------------------
  const changed = new Map<string, any>();
  for (const item of changedItems) {
    const key = item?.key ?? item?.data?.key;
    if (key) changed.set(key, item);
  }
  let fulltextVersion: number | undefined;
  if (wantFulltext) {
    const sweep = await addNewlyExtracted(ctx, lib, run, changed, maxItems, check);
    requests += sweep.requests;
    fulltextVersion = sweep.fulltextVersion;
  }

  // ---- full text for everything being re-indexed ------------------------------------
  const maxChars = ctx.config.indexFulltextMaxChars ?? DEFAULT_FULLTEXT_MAX_CHARS;
  const payload: NonNullable<IndexDelta['changed']> = [];
  for (const [key, item] of changed) {
    if (!wantFulltext) {
      payload.push({ item });
      continue;
    }
    // Deliberately allowed to abort the whole delta rather than degrade. A re-indexed item
    // is dropped and rebuilt from this payload, so indexing it without its body text does
    // not leave coverage where it was — it DELETES body text the index already had. Losing
    // the delta costs a retry on the next query; finishing it half-enriched costs passages.
    check('full-text fetch');
    const ft = await fulltextForItem(ctx, lib, key, maxChars);
    requests += ft.requests;
    payload.push(ft.text ? { item, fulltext: ft.text, fulltextPending: ft.pending } : { item, fulltextPending: ft.pending });
  }

  // The pending set is maintained inside applyDelta, from the per-item flags above, and
  // persisted by the same recordWatermark that writes the watermark. Adjusting it out here
  // afterwards would be both redundant and unwritten to disk.
  const result = await ctx.search.applyDelta({
    changed: payload,
    removed,
    version: run.version,
    backend: run.backend,
    // Left undefined when the full-text sweep did not cover everything it saw; applyDelta
    // then leaves the previous value standing, and the next delta resumes from there.
    ...(fulltextVersion !== undefined ? { fulltextVersion } : {}),
  });

  ctx.logger.info(
    `Search index delta: ${result.reindexed} item(s) re-indexed, ${result.removed} removed, ` +
      `now current at ${run.backend} library version ${run.version} (was ${run.watermark}); ${requests} request(s).`,
  );
  return { state: 'applied', requests, version: run.version, reindexed: result.reindexed, removed: result.removed };
}

/**
 * Fold in the items whose attachments Zotero extracted since the **full-text** watermark.
 *
 * This is the case a `?since=` pass alone will not reliably produce: extraction touches
 * the attachment, and the parent item — the one the index holds passages for — need not
 * appear in a top-level `?since=` page at all. `fullTextSince` names exactly the
 * attachments whose text changed, which is why it is asked separately.
 *
 * **Which number is handed to it is the whole of ticket 0012.** It used to be the item
 * watermark. Zotero numbers full-text extraction on its own sequence, and on the library
 * measured there the item sequence sat at 410 while the full-text one ran from 0 to
 * 25 036 — so `fullTextSince(410)` returned 7 453 of 8 037 attachments, on every delta,
 * forever. It failed quietly: `maxItems` capped the set, the handful of genuinely
 * re-extracted items were lost in map order among ~7 400 candidates, each candidate cost
 * a `getItem`, and the next delta was no closer because the number being advanced belonged
 * to the other counter. 0006 guards carefully against exactly this class *across* backends
 * — that is what `indexBackend` is for — and then compared two unrelated sequences inside
 * one backend. Guarding one instance of a defect class does not guard the class.
 *
 * **Candidates are taken in ascending version order, not map order**, and the watermark is
 * advanced only past versions swept *completely*. That is what makes a truncated sweep
 * converge: the ceiling stops it partway, the watermark records how far it got, and the
 * next delta resumes there instead of re-reading the same prefix. Map order plus an
 * unmoved watermark is a loop that makes no progress, which is the shape the defect had.
 *
 * Items already recorded as present-without-text are then topped up into whatever room is
 * left. That set exists so an unextracted attachment does not become permanently
 * invisible, and re-probing it is the only thing that makes the record do work — but it
 * comes second, because `fullTextSince` names the items that are actually known to have
 * changed, and the room is small.
 *
 * `maxItems` is a hard ceiling on the whole re-index set, not just on this sweep: every
 * item added here costs a children listing plus a read per attachment later.
 *
 * Returns the requests spent and, when the sweep completed a version, the new full-text
 * watermark. `undefined` means "do not move it" — see IndexDelta.fulltextVersion.
 */
async function addNewlyExtracted(
  ctx: ToolContext,
  lib: LibraryRef | undefined,
  run: DeltaRun,
  changed: Map<string, any>,
  maxItems: number,
  check: (what: string) => void,
): Promise<{ requests: number; fulltextVersion?: number }> {
  let requests = 0;
  const candidates = new Set<string>();
  const room = (): number => maxItems - changed.size - candidates.size;
  let fulltextVersion: number | undefined;

  try {
    check('full-text delta');
    const extracted = await ctx.router.fullTextSince(run.fulltextWatermark, { library: lib });
    requests++;
    // Ascending by version, so a sweep cut short by `room()` still leaves a version below
    // which everything HAS been folded in. Ties are kept adjacent, which is what lets the
    // "completed version" test below be exact rather than approximate.
    const entries = Object.entries(extracted ?? {})
      .filter((e): e is [string, number] => Number.isFinite(e[1]))
      .sort((a, b) => a[1] - b[1]);

    // The highest version every one of whose attachments was folded in. Advancing to a
    // version whose group was only half-swept would retire the other half unseen — the
    // failure 0012 warns about, the one where nothing ever looks newly extracted again.
    let completed: number | undefined;
    // Reset at each version boundary. A group in which one attachment could not be
    // resolved is not a completed group: advancing past it would retire that attachment
    // unseen, and nothing would ever look at it again.
    let groupFailed = false;
    for (let i = 0; i < entries.length; i++) {
      const [attachmentKey, version] = entries[i]!;
      if (room() <= 0) break;
      if (!changed.has(attachmentKey)) {
        check('full-text parent lookup');
        try {
          const att = await ctx.router.getItem(attachmentKey, { library: lib });
          requests++;
          // A top-level attachment with no parent is itself the indexed item.
          const parent = att?.data?.parentItem ?? att?.parentItem ?? attachmentKey;
          if (!changed.has(parent)) candidates.add(parent);
        } catch (e) {
          groupFailed = true;
          ctx.logger.debug(`Could not resolve attachment ${attachmentKey} to its item: ${why(e)}`);
        }
      }
      // Only once the NEXT entry belongs to a higher version is this one's group finished.
      if (i + 1 === entries.length || entries[i + 1]![1] > version) {
        if (!groupFailed) completed = version;
        groupFailed = false;
      }
    }
    // Undefined when nothing came back, when the ceiling stopped the sweep before a single
    // version group closed, or when a resolution failed in the lowest group: all three mean
    // "the sweep did not get past where we already were", and the watermark must not move.
    if (completed !== undefined) fulltextVersion = completed;
  } catch (e) {
    // Best effort: a library whose full-text endpoints are unreachable still gets its
    // metadata delta. Same reasoning as createFulltextSource's degradation. The watermark
    // stays put, so the sweep is retried rather than skipped.
    ctx.logger.debug(`Full-text delta skipped: ${why(e)}`);
    fulltextVersion = undefined;
  }

  for (const key of ctx.search.fulltextPendingItems) {
    if (room() <= 0) break;
    if (!changed.has(key)) candidates.add(key);
  }

  for (const key of candidates) {
    check('full-text item fetch');
    try {
      const item = await ctx.router.getItem(key, { library: lib });
      requests++;
      if (item) changed.set(key, item);
    } catch (e) {
      ctx.logger.debug(`Could not fetch item ${key} for a full-text delta: ${why(e)}`);
    }
  }
  return fulltextVersion !== undefined ? { requests, fulltextVersion } : { requests };
}

/**
 * Full text for ONE item, fetched directly through its children.
 *
 * Deliberately not `createFulltextSource`, which pages every attachment in the library to
 * build a map. That cost is right for a build, which amortises it over thousands of items;
 * for a delta of three items it would be several thousand requests to place three.
 *
 * `pending` is reported apart from `text` because the two absences are different: an item
 * with no attachment at all is finished, while one whose attachment Zotero has not
 * extracted yet must be revisited. Collapsing them is what let "no text yet" disappear.
 */
async function fulltextForItem(
  ctx: ToolContext,
  lib: LibraryRef | undefined,
  itemKey: string,
  maxChars: number,
): Promise<{ text?: string; pending: boolean; requests: number }> {
  let requests = 0;
  let children: any[];
  try {
    const res = await ctx.router.getItemChildren(itemKey, { library: lib, limit: PAGE_SIZE });
    requests++;
    children = res.data ?? [];
  } catch (e) {
    ctx.logger.debug(`Could not list children of ${itemKey}: ${why(e)}`);
    return { pending: false, requests };
  }

  const attachments = children.filter((c) => (c.data ?? c)?.itemType === 'attachment');
  if (attachments.length === 0) return { pending: false, requests };

  const parts: string[] = [];
  let used = 0;
  let unextracted = false;
  for (const att of attachments) {
    const key = att.key ?? att.data?.key;
    if (!key) continue;
    if (maxChars > 0 && used >= maxChars) break;
    let content = '';
    try {
      const ft = await ctx.router.getFullText(key, { library: lib });
      requests++;
      content = typeof ft?.content === 'string' ? ft.content : '';
    } catch (e) {
      ctx.logger.debug(`Could not read full text for attachment ${key}: ${why(e)}`);
      unextracted = true;
      continue;
    }
    if (!content) {
      // Present without text: Zotero holds the file and has not extracted it.
      unextracted = true;
      continue;
    }
    const slice = maxChars > 0 ? content.slice(0, maxChars - used) : content;
    parts.push(slice);
    used += slice.length;
  }

  const out: { text?: string; pending: boolean; requests: number } = {
    // Pending only when NOTHING was extracted: an item that already contributes body text
    // is indexed, and re-probing it on every delta would buy a second copy of what we have.
    pending: unextracted && parts.length === 0,
    requests,
  };
  if (parts.length) out.text = parts.join('\n\n');
  return out;
}
