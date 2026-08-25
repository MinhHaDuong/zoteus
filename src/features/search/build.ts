import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { IndexBuildStatus } from './index-manager.js';
import { createFulltextSource, type FulltextSource } from './fulltext-source.js';
import { saveIndex } from './persistence.js';
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
 * One-line progress summary shared by tool messages, status output and the server build
 * log, which must not diverge: a log reading `5000/5000` beside tool output reading
 * `5000 of 12000` invites the conclusion that one of them is wrong. The library total is
 * spelled out rather than appended after a second slash, which made one line carry two
 * different senses of "/".
 */
export function progressLine(s: IndexBuildStatus): string {
  const total = s.itemsTotal > 0 ? String(s.itemsTotal) : '?';
  const library = s.itemsAvailable > s.itemsTotal ? ` (${s.itemsAvailable} in library)` : '';
  const fulltext = s.fulltextEnabled ? `, full text of ${s.fulltextItems} items (${s.fulltextPassages} passages)` : '';
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

/** Human summary of a build/status snapshot. */
export function statusSummary(s: IndexBuildStatus): string {
  const notice = embedderNotice(s) + fulltextNotice(s) + truncationNotice(s);
  switch (s.state) {
    case 'building':
      return `Index build in progress — ${progressLine(s)}. Poll zotero_index action:"status" again shortly.${notice}`;
    case 'error':
      return `Index build failed: ${s.lastError ?? 'unknown error'}. Partial data kept — ${progressLine(s)}.${notice}`;
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
}

/**
 * Kick off the incremental background index build used by zotero_index and by
 * zotero_semantic_search's auto-build. Fire-and-forget: the build runs on the
 * server event loop; callers poll `ctx.search.buildStatus()` for progress.
 * Throws if a build is already running.
 *
 * Whether a page came from the desktop app or the cloud never changes the identity of
 * what is indexed: item keys are the same in both APIs, and the index file is keyed by
 * the context (dataDir, plus the authenticated user in multi-tenant mode — see
 * `searchIndexPath`), never by the routed library id. So the local `users/0` addressing
 * cannot split the index from the one built against the real userID, and a build that
 * switched backends between runs stays coherent. Nothing here compares Zotero library
 * versions across backends either: `buildIncremental` always rebuilds from scratch and
 * reports `builtFromVersion` as the item count it fetched, so the local/cloud version
 * sequences (which differ — the desktop app has its own) are never mixed.
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
    // personal library key-free (users/0), so indexing needs no cloud key. The router still
    // sends group libraries — and everything else when the app is closed — to the cloud.
    // `lib` stays undefined for the default library so the router resolves it itself.
    const page = await ctx.router.searchItems({ library: lib, limit: PAGE_SIZE, start, top: true });
    return { items: page.data, totalResults: page.totalResults };
  };
  const persist = ctx.searchIndexPath
    ? () =>
        saveIndex(ctx.search, ctx.searchIndexPath).catch((e) =>
          ctx.logger.warn(`Could not persist index: ${e instanceof Error ? e.message : String(e)}`),
        )
    : undefined;

  const wantFulltext = opts.fulltext ?? ctx.config.indexFulltext;
  const maxChars = opts.fulltextMaxChars ?? ctx.config.indexFulltextMaxChars;
  // The attachment map is resolved lazily, on the first item, because startIndexBuild is
  // synchronous by contract: it must return a status immediately and let the caller poll.
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

  const job = ctx.search.buildIncremental(fetchPage, {
    maxItems: cap,
    persist,
    fulltextFor,
    // A full-text index is far bigger, and persisting means re-serializing all of it. Save
    // less often so the write does not dominate the build.
    ...(wantFulltext ? { persistEveryItems: 500, persistEveryMs: 60_000 } : {}),
  });
  job.catch((e) => ctx.logger.error(`Index build crashed: ${e instanceof Error ? e.message : String(e)}`));
  return ctx.search.buildStatus();
}
