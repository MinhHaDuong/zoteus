import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { IndexBuildStatus, VersionBackend } from './backend.js';
import { createFulltextSource, type FulltextSource } from './fulltext-source.js';
import { DEFAULT_INDEX_MAX_ITEMS } from './limits.js';

/**
 * Default cap on items per build — keeps very large libraries bounded. Re-exported from
 * `limits.ts`; raise it at runtime with `ZOTEUS_INDEX_MAX_ITEMS`.
 *
 * @deprecated Read `ctx.config.indexMaxItems` instead: this is the default, not the cap
 * in force. Kept so existing importers still resolve.
 */
export const MAX_ITEMS = DEFAULT_INDEX_MAX_ITEMS;
/** Both Zotero APIs (cloud Web API and desktop local API) page items 100-at-a-time. */
export const PAGE_SIZE = 100;

/**
 * Page size for the `?format=versions` census an update diffs deletions against. Far larger
 * than PAGE_SIZE because the rows are a key and an integer, not item bodies, and the
 * endpoint commonly answers with the whole library at once. The loop advances by what came
 * back rather than by this number, so a server that caps the page still pages correctly.
 */
export const VERSIONS_PAGE_SIZE = 5000;

/** Ceiling on those pages, so a pathological library cannot page forever. */
const MAX_VERSION_PAGES = 200;

/**
 * One-line progress summary shared by tool messages, status output and the server build
 * log, which must not diverge: a log reading `5000/5000` beside tool output reading
 * `5000 of 12000` invites the conclusion that one of them is wrong. The library total is
 * spelled out rather than appended after a second slash, which made one line carry two
 * different senses of "/".
 */
export function progressLine(s: IndexBuildStatus): string {
  const fulltext = s.fulltextEnabled ? `, full text of ${s.fulltextItems} items (${s.fulltextPassages} passages)` : '';
  // An update's itemsFetched is the size of the delta, not progress through the library, so
  // rendering it as "7 of 5000" would read as a build that stalled on its first page.
  if (s.operation === 'update') {
    return `${s.itemsFetched} changed items re-indexed, ${s.itemsRemoved} removed, ${s.items} items total, ${s.passages} passages, ${s.vectors} vectors${fulltext} (embedder=${s.embedder})`;
  }
  const total = s.itemsTotal > 0 ? String(s.itemsTotal) : '?';
  const library = s.itemsAvailable > s.itemsTotal ? ` (${s.itemsAvailable} in library)` : '';
  return `${s.itemsFetched} of ${total} items indexed${library}, ${s.passages} passages, ${s.vectors} vectors${fulltext} (embedder=${s.embedder})`;
}

/**
 * Sentence appended whenever the configured embedder is not the effective one. Without it
 * a keyword-only index is indistinguishable from a healthy one, which is exactly how a
 * missing optional dependency stayed invisible through two clean builds (#7).
 */
export function embedderNotice(s: IndexBuildStatus): string {
  if (s.embedderActive || s.embedderConfigured === 'off') return '';
  return ` Semantic ranking is OFF (embeddings=${s.embedderConfigured} requested but not active): ${s.embedderReason ?? 'unavailable'}`;
}

/**
 * Sentence appended when full-text indexing was asked for but produced nothing. Same
 * reasoning as `embedderNotice`: an index that silently fell back to metadata is
 * indistinguishable from a healthy one, and the user would go on believing PDF bodies
 * are searchable.
 */
export function fulltextNotice(s: IndexBuildStatus): string {
  if (!s.fulltextEnabled || !s.fulltextReason) return '';
  return ` Full-text indexing produced nothing: ${s.fulltextReason}`;
}

/**
 * Sentence appended when the vectors an earlier build persisted were produced by a different
 * embedder than the one now configured, and were therefore dropped on load. Same reasoning as
 * `embedderNotice`: without it, switching ZOTEUS_EMBEDDING_MODEL turns a healthy index into a
 * keyword-only one with no explanation, and the fix (one rebuild) is not obvious.
 */
export function staleVectorsNotice(s: IndexBuildStatus): string {
  return s.vectorsStaleReason ? ` ${s.vectorsStaleReason}` : '';
}

/**
 * Sentence appended when the build limit stopped the crawl short of the library. Same
 * reasoning as `embedderNotice` and `fulltextNotice`: without it a capped build reports
 * complete coverage, so a search that finds nothing in the unindexed remainder is
 * indistinguishable from a search over a library that holds nothing on the subject.
 *
 * The advice names both dials because the limit in force is min(the caller's `limit`,
 * ZOTEUS_INDEX_MAX_ITEMS) and a status snapshot cannot tell which one bit: telling a
 * caller whose own `limit` truncated the build to raise the environment variable sends
 * them to a setting that is already high enough.
 */
export function truncationNotice(s: IndexBuildStatus): string {
  if (s.itemsAvailable <= s.itemsTotal) return '';
  const missing = s.itemsAvailable - s.itemsTotal;
  return (
    ` Only the first ${s.itemsTotal} of ${s.itemsAvailable} items were indexed, so ${missing} are NOT searchable.` +
    ' A build stops at the lower of the `limit` argument and ZOTEUS_INDEX_MAX_ITEMS: raise whichever one bound this build, then rebuild to cover them.'
  );
}

/**
 * Sentence appended when the index could not be written to its store. Same reasoning as
 * `embedderNotice`: a build whose artifact never reached disk still reports state:"done",
 * and until #10 the only trace was a stderr warning, so the loss surfaced on the next
 * startup as an empty index nobody had touched.
 */
export function persistNotice(s: IndexBuildStatus): string {
  if (!s.persistError) return '';
  return (
    ` The index could NOT be saved (${s.persistError}), so everything indexed here is held in memory only and is` +
    ' lost when the server restarts. On the JSON backend this is usually the size ceiling of a single' +
    ' JSON.stringify (~512 MB): set ZOTEUS_INDEX_BACKEND=sqlite (Node 22.13+) to store the index in SQLite' +
    ' instead. Otherwise check free disk space and write permission on ZOTEUS_DATA_DIR.'
  );
}

/**
 * Sentence appended when opening the store needed saying: a JSON index imported into
 * SQLite, or one too large to import at all. Migration must never be something a user
 * discovers by noticing their searches went quiet.
 */
export function storageNotice(s: IndexBuildStatus): string {
  return s.storageNotice ? ` ${s.storageNotice}` : '';
}

/**
 * Sentence appended when an incremental update ran, or when one could not and a full
 * rebuild took its place. Same reasoning as `embedderNotice`: an `action:"update"` that
 * silently became a ten-minute rebuild with real embedding spend, or one that skipped its
 * deletion pass, must not be indistinguishable from the cheap update that was asked for.
 */
export function updateNotice(s: IndexBuildStatus): string {
  return s.updateNotice ? ` ${s.updateNotice}` : '';
}

/** Human summary of a build/status snapshot. */
export function statusSummary(s: IndexBuildStatus): string {
  const job = s.operation === 'update' ? 'update' : 'build';
  const notice =
    embedderNotice(s) +
    staleVectorsNotice(s) +
    fulltextNotice(s) +
    truncationNotice(s) +
    persistNotice(s) +
    storageNotice(s) +
    updateNotice(s);
  switch (s.state) {
    case 'building':
      return `Index ${job} in progress: ${progressLine(s)}. Poll zotero_index action:"status" again shortly.${notice}`;
    case 'error': {
      // A failed build keeps what it got; a failed update keeps nothing of its own, because
      // a half-applied delta is a wrong index rather than a partial one.
      const kept = job === 'update' ? 'Index unchanged' : 'Partial data kept';
      return `Index ${job} failed: ${s.lastError ?? 'unknown error'}. ${kept}: ${progressLine(s)}.${notice}`;
    }
    case 'done': {
      const ft = s.fulltextEnabled
        ? `, including attachment full text for ${s.fulltextItems} of them (${s.fulltextPassages} passages)`
        : '';
      return `Index ready — ${s.documents} passages over ${s.items} items${ft} (embedder=${s.embedder}). Run zotero_semantic_search to search by meaning.${notice}`;
    }
    default:
      return `Index: ${s.documents} passages over ${s.items} items; embedder=${s.embedder}.${notice}`;
  }
}

export interface BuildFulltextOptions {
  /** Index attachment full text as extra passages (defaults to ZOTEUS_INDEX_FULLTEXT). */
  fulltext?: boolean;
  /** Cap on indexed full-text characters per item, 0 = no cap (defaults to config). */
  fulltextMaxChars?: number;
  /**
   * Sentence to carry on the resulting status, e.g. why an update fell back to this
   * rebuild. Passed into the build rather than set beforehand because the build's own
   * prologue resets the status it would otherwise be written on.
   */
  note?: string;
}

/**
 * Kick off the incremental background index build used by zotero_index and by
 * zotero_semantic_search's auto-build. Fire-and-forget: the build runs on the
 * server event loop; callers poll `ctx.search.buildStatus()` for progress.
 * Throws if a build is already running.
 *
 * Whether a page came from the desktop app or the cloud never changes the identity of
 * what is indexed: item keys are the same in both APIs, and the index store is keyed by
 * the context (dataDir, plus the authenticated user in multi-tenant mode — see
 * `searchIndexPath`), never by the routed library id. So neither the local `users/0`
 * addressing of the personal library nor a group served locally under its own id can
 * split the index from the one built against the cloud, and a build that switched
 * backends between runs stays coherent.
 *
 * A completed build also stamps the library's real Last-Modified-Version and the API that
 * issued it, which is what `startIndexUpdate` later diffs against. The two sequences are
 * never mixed: the stamp is only usable while the routing that produced it still holds, and
 * a mismatch sends the update back through this function. `builtFromVersion` keeps its
 * older, unrelated meaning (the item count the crawl fetched); the version stamp lives in
 * `libraryVersion` / `libraryBackend`.
 */
export function startIndexBuild(
  ctx: ToolContext,
  lib?: LibraryRef,
  maxItems?: number,
  opts: BuildFulltextOptions = {},
): IndexBuildStatus {
  // The configured limit is the ceiling; an explicit `maxItems` may only lower it.
  const configured = ctx.config.indexMaxItems;
  const cap = maxItems === undefined ? configured : Math.min(maxItems, configured);
  const fetchPage = async (start: number) => {
    // Page through the router, not the Web API directly: a running desktop app serves the
    // personal library key-free (users/0), and from Zotero 10 any group it holds too, so
    // indexing needs no cloud key for either. The router sends the rest to the cloud: a
    // group this desktop does not hold, and everything once the app is closed.
    // `lib` stays undefined for the default library so the router resolves it itself.
    const page = await ctx.router.searchItems({ library: lib, limit: PAGE_SIZE, start, top: true });
    return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: page.lastModifiedVersion };
  };

  // The index persists itself (JSON file or SQLite commit), and a failure to do so is
  // recorded on the build status rather than swallowed here: see persistNotice.
  const job = ctx.search.buildIncremental(fetchPage, {
    maxItems: cap,
    versionBackend: ctx.router.servesLocally(lib) ? 'local' : 'cloud',
    ...crawlOptions(ctx, lib, opts),
  });
  job.catch((e) => ctx.logger.error(`Index build crashed: ${e instanceof Error ? e.message : String(e)}`));
  return ctx.search.buildStatus();
}

/**
 * Kick off an incremental UPDATE: re-index only what the library changed since the stored
 * version stamp, and drop what it no longer holds. Same contract as `startIndexBuild`
 * (fire-and-forget, poll `buildStatus()`), and the same fallback in every case where a
 * delta would be wrong rather than merely stale: no stamp, a different serving backend, a
 * different embedder, or a store that cannot delete. The fallback is a full rebuild with
 * the reason attached to the status, never a silent one.
 */
export function startIndexUpdate(
  ctx: ToolContext,
  lib?: LibraryRef,
  maxItems?: number,
  opts: BuildFulltextOptions = {},
): IndexBuildStatus {
  const backend: VersionBackend = ctx.router.servesLocally(lib) ? 'local' : 'cloud';
  const blocker = ctx.search.updateBlocker(backend);
  if (blocker) {
    return startIndexBuild(ctx, lib, maxItems, {
      ...opts,
      note:
        `An incremental update was not possible (${blocker}), so the whole library is being rebuilt instead. ` +
        'The rebuild records a version stamp, so the next action:"update" is a cheap delta.',
    });
  }

  const configured = ctx.config.indexMaxItems;
  const cap = maxItems === undefined ? configured : Math.min(maxItems, configured);
  const since = ctx.search.buildStatus().libraryVersion;
  const fetchChanged = async (start: number) => {
    // The same routed, top-level crawl a build does, narrowed by `?since=`: on a library
    // where nothing moved this is a single request that returns an empty page.
    const page = await ctx.router.searchItems({ library: lib, limit: PAGE_SIZE, start, top: true, since });
    return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: page.lastModifiedVersion };
  };
  const liveKeys = async (): Promise<Set<string>> => {
    // `?format=versions` with no `since`: the whole key set, keys and versions only, which
    // is the only way to find deletions on the desktop app (`/deleted` is cloud-only).
    const keys = new Set<string>();
    let start = 0;
    for (let page = 0; page < MAX_VERSION_PAGES; page++) {
      const res = await ctx.router.itemVersions({ library: lib, top: true, limit: VERSIONS_PAGE_SIZE, start });
      const batch = Object.keys(res.versions ?? {});
      for (const k of batch) keys.add(k);
      // Advance by what actually came back, not by the requested page size: the endpoint
      // may answer with the whole library at once, or cap the page at its own limit.
      if (!batch.length) break;
      start += batch.length;
      if (res.totalResults && start >= res.totalResults) break;
    }
    return keys;
  };

  const job = ctx.search.updateIncremental({
    backend,
    fetchChanged,
    liveKeys,
    maxItems: cap,
    ...crawlOptions(ctx, lib, opts),
  });
  job.catch((e) => ctx.logger.error(`Index update crashed: ${e instanceof Error ? e.message : String(e)}`));
  return ctx.search.buildStatus();
}

/**
 * The options a build and an update share: full text (resolved lazily, because both
 * starters are synchronous by contract and must return a status for the caller to poll)
 * and the embedding batch dials.
 */
function crawlOptions(ctx: ToolContext, lib: LibraryRef | undefined, opts: BuildFulltextOptions) {
  const wantFulltext = opts.fulltext ?? ctx.config.indexFulltext;
  const maxChars = opts.fulltextMaxChars ?? ctx.config.indexFulltextMaxChars;
  let source: Promise<FulltextSource> | undefined;
  const fulltextFor = wantFulltext
    ? async (itemKey: string) => {
        source ??= createFulltextSource(ctx, lib, { maxChars }).then((src) => {
          if (src.unavailable) ctx.search.noteFulltextUnavailable(src.unavailable);
          else ctx.logger.info(`Full-text indexing: ${src.attachments} attachment(s) over ${src.items} item(s).`);
          return src;
        });
        return (await source).textFor(itemKey);
      }
    : undefined;
  return {
    fulltextFor,
    ...(opts.note ? { note: opts.note } : {}),
    // Passages per embedding request, and the pause between requests: the dials an API
    // provider's per-request token cap and per-minute rate limit are tuned against.
    embedBatchSize: ctx.config.embedBatchSize,
    embedBatchDelayMs: ctx.config.embedBatchDelayMs,
    // A full-text index is far bigger, and on the JSON backend persisting means
    // re-serializing all of it. Save less often so the write does not dominate the build.
    // (On SQLite a persist is a commit, so this only costs a slightly longer transaction.)
    ...(wantFulltext ? { persistEveryItems: 500, persistEveryMs: 60_000 } : {}),
  };
}
