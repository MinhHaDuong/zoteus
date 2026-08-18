import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { IndexBuildStatus } from './index-manager.js';
import { saveIndex } from './persistence.js';

/** Hard cap on items per build — keeps very large libraries bounded. */
export const MAX_ITEMS = 5000;
/** The Zotero Web API pages items 100-at-a-time. */
export const PAGE_SIZE = 100;

/** One-line progress summary used in tool messages and status output. */
export function progressLine(s: IndexBuildStatus): string {
  const total = s.itemsTotal > 0 ? String(s.itemsTotal) : '?';
  return `${s.itemsFetched}/${total} items, ${s.passages} passages, ${s.vectors} vectors (embedder=${s.embedder})`;
}

/** Human summary of a build/status snapshot. */
export function statusSummary(s: IndexBuildStatus): string {
  switch (s.state) {
    case 'building':
      return `Index build in progress — ${progressLine(s)}. Poll zotero_index action:"status" again shortly.`;
    case 'error':
      return `Index build failed: ${s.lastError ?? 'unknown error'}. Partial data kept — ${progressLine(s)}.`;
    case 'done':
      return `Index ready — ${s.documents} passages over ${s.items} items (embedder=${s.embedder}). Run zotero_semantic_search to search by meaning.`;
    default:
      return `Index: ${s.documents} passages over ${s.items} items; embedder=${s.embedder}.`;
  }
}

/**
 * Kick off the incremental background index build used by zotero_index and by
 * zotero_semantic_search's auto-build. Fire-and-forget: the build runs on the
 * server event loop; callers poll `ctx.search.buildStatus()` for progress.
 * Throws if a build is already running.
 */
export function startIndexBuild(ctx: ToolContext, lib?: LibraryRef, maxItems = MAX_ITEMS): IndexBuildStatus {
  const library = lib ?? ctx.router.defaultLibrary();
  const cap = Math.min(maxItems, MAX_ITEMS);
  const fetchPage = async (start: number) => {
    const page = await ctx.web.listItems(library, { limit: PAGE_SIZE, start, top: true });
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
