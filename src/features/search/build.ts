import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { IndexBuildStatus } from './index-manager.js';
import { saveIndex } from './persistence.js';

/** Hard cap on items per build — keeps very large libraries bounded. */
export const MAX_ITEMS = 5000;
/** Both Zotero APIs (cloud Web API and desktop local API) page items 100-at-a-time. */
export const PAGE_SIZE = 100;

/** One-line progress summary used in tool messages and status output. */
export function progressLine(s: IndexBuildStatus): string {
  const total = s.itemsTotal > 0 ? String(s.itemsTotal) : '?';
  return `${s.itemsFetched}/${total} items, ${s.passages} passages, ${s.vectors} vectors (embedder=${s.embedder})`;
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

/** Human summary of a build/status snapshot. */
export function statusSummary(s: IndexBuildStatus): string {
  const notice = embedderNotice(s);
  switch (s.state) {
    case 'building':
      return `Index build in progress — ${progressLine(s)}. Poll zotero_index action:"status" again shortly.${notice}`;
    case 'error':
      return `Index build failed: ${s.lastError ?? 'unknown error'}. Partial data kept — ${progressLine(s)}.${notice}`;
    case 'done':
      return `Index ready — ${s.documents} passages over ${s.items} items (embedder=${s.embedder}). Run zotero_semantic_search to search by meaning.${notice}`;
    default:
      return `Index: ${s.documents} passages over ${s.items} items; embedder=${s.embedder}.${notice}`;
  }
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
export function startIndexBuild(ctx: ToolContext, lib?: LibraryRef, maxItems = MAX_ITEMS): IndexBuildStatus {
  const cap = Math.min(maxItems, MAX_ITEMS);
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
  const job = ctx.search.buildIncremental(fetchPage, { maxItems: cap, persist });
  job.catch((e) => ctx.logger.error(`Index build crashed: ${e instanceof Error ? e.message : String(e)}`));
  return ctx.search.buildStatus();
}
