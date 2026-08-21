import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import {
  embedderNotice,
  fulltextNotice,
  progressLine,
  startIndexBuild,
  vectorStorageNotice,
} from '../features/search/build.js';
import { refreshIndexIfStale, type RefreshOutcome } from '../features/search/delta.js';

/**
 * A sentence about the index's currency, and only when it is not the boring answer.
 *
 * Same reasoning as embedderNotice: a search served from an index that could not be
 * brought up to date is indistinguishable from one served from a current index, and the
 * difference is precisely whether a missing result means "not in your library".
 */
function refreshNotice(r: RefreshOutcome): string {
  switch (r.state) {
    case 'applied':
      return ` The index was brought up to date first (${r.reindexed} item(s) re-indexed, ${r.removed} removed).`;
    case 'rebuilding':
      return ` The index is being rebuilt in the background (${r.detail ?? 'watermark unusable'}); results may be partial until zotero_index action:"status" reports "done".`;
    case 'unreachable':
      return ' Zotero could not be reached to check for changes, so these results come from the index as it was last built.';
    case 'skipped':
      return ` The index could not be brought up to date (${r.detail ?? 'delta abandoned'}); these results come from the index as it was last built.`;
    default:
      return '';
  }
}

const semanticSearch: ToolDefinition = {
  name: 'zotero_semantic_search',
  title: 'Semantic / hybrid library search',
  description:
    'Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. By default it searches item metadata and abstracts; if the index was built with `fulltext` on (zotero_index fulltext:true, or ZOTEUS_INDEX_FULLTEXT=true) it also searches the body text of attachments, and a hit whose snippet came from a PDF body is marked source:"fulltext". `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). "semantic" needs vectors in the index: when the configured embedder is not running (e.g. the on-device model runtime is not installed) it returns an error naming the cause instead of an empty result set, and "auto" keeps working as keyword search while saying so. The index must be built once before first use: when it is empty this tool starts a background build automatically (`auto_build`, on by default) and tells you to poll zotero_index action:"status" and retry — pass `auto_build:false` to opt out. For exact field/tag/itemType filtering use zotero_search_items instead; use this for conceptual/"papers about X" queries. To read the actual passages of a found item (with page locators) use zotero_get_fulltext.',
  inputSchema: {
    q: z.string().min(1).describe('Natural-language query.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
    mode: z.enum(['auto', 'keyword', 'semantic']).optional(),
    auto_build: z
      .boolean()
      .optional()
      .describe('Start building the index automatically in the background when it is empty (default true).'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    // Before anything else, and before the isEmpty check below, because a backend switch
    // or an unusable watermark starts a rebuild here — after which the index IS empty and
    // the auto-build branch is exactly the right thing to report.
    //
    // Bounded three ways, and none of them can turn a search into a failure: it stands
    // down while a build is running, it is raced against a wall-clock deadline, and an
    // unreachable Zotero degrades to serving the current index rather than erroring. When
    // nothing has changed it costs one request. See features/search/delta.ts.
    const refresh = await refreshIndexIfStale(ctx);

    if (ctx.search.isEmpty) {
      // A build is already on its way (started here or via zotero_index): report progress.
      if (ctx.search.isBuilding) {
        const s = ctx.search.buildStatus();
        return {
          content: [
            {
              type: 'text',
              text:
                `The semantic-search index is being built right now — ${progressLine(s)}. ` +
                'Poll zotero_index with action:"status" until state is "done", then retry this search.' +
                embedderNotice(s),
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      if (args.auto_build !== false) {
        // First use: populate the index on the fly instead of leaving the user stranded.
        const s = startIndexBuild(ctx);
        return {
          content: [
            {
              type: 'text',
              text:
                'The semantic-search index is empty, so a background build was started automatically ' +
                `(first-time setup; ${progressLine(s)}). Poll zotero_index with action:"status" every few seconds ` +
                'until state is "done", then retry this search. Pass auto_build:false to opt out.' +
                embedderNotice(s),
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      const s = ctx.search.buildStatus();
      return {
        content: [
          {
            type: 'text',
            text: 'The search index is empty. Run zotero_index with action:"build" first, then retry.' + embedderNotice(s),
          },
        ],
        structuredContent: { ...s },
        isError: true,
      };
    }
    const status = ctx.search.buildStatus();
    // Semantic mode ranks by vectors alone. With none in the index every query returns an
    // empty list, which reads exactly like "your library has nothing on this": the failure
    // mode reported in #7. Refuse instead, and name the cause.
    if (args.mode === 'semantic' && !ctx.search.hasVectors) {
      // Three distinct causes, and telling the user the wrong one sends them into a
      // pointless rebuild: the embedder may be down, the *store* may be unable to hold
      // vectors however well the embedder runs, or both may be fine and the index simply
      // predates them. The store reason comes first because a rebuild will not fix it.
      const why = ctx.search.vectorStorageReason
        ? `No vectors are being stored: ${ctx.search.vectorStorageReason}`
        : ctx.search.embedderActive
          ? 'The index holds no vectors yet. Rebuild it with zotero_index action:"build" (an index built while the embedder was unavailable stays keyword-only until rebuilt).'
          : `No vectors exist because the embedder is not active: ${ctx.search.embedderReason ?? 'unavailable'}`;
      return {
        content: [
          {
            type: 'text',
            text:
              `mode:"semantic" cannot run: it ranks by vector similarity only, and this index has 0 vectors. ${why} ` +
              'Re-run with mode:"keyword" (or the default "auto") to search this library right now.',
          },
        ],
        structuredContent: {
          hits: [],
          embedder: ctx.search.embedderName,
          embedderConfigured: status.embedderConfigured,
          embedderActive: status.embedderActive,
          ...(status.embedderReason ? { embedderReason: status.embedderReason } : {}),
          ...(status.vectorReason ? { vectorReason: status.vectorReason } : {}),
          vectors: status.vectors,
        },
        isError: true,
      };
    }
    const hits = await ctx.search.query(args.q, { limit: args.limit ?? 10, mode: args.mode });
    // Re-read: a query-time embedding failure flips the embedder to inactive mid-call.
    const after = ctx.search.buildStatus();
    const summary =
      (hits.length
        ? `Top ${hits.length} match(es) for "${args.q}" (${ctx.search.embedderName}).`
        : `No matches for "${args.q}".`) +
      refreshNotice(refresh) +
      (args.mode === 'keyword' ? '' : embedderNotice(after) + vectorStorageNotice(after)) +
      fulltextNotice(after);
    return ok(
      {
        hits,
        embedder: ctx.search.embedderName,
        embedderConfigured: after.embedderConfigured,
        embedderActive: after.embedderActive,
        ...(after.embedderReason ? { embedderReason: after.embedderReason } : {}),
        ...(after.vectorReason ? { vectorReason: after.vectorReason } : {}),
        fulltextEnabled: after.fulltextEnabled,
        ...(after.fulltextReason ? { fulltextReason: after.fulltextReason } : {}),
        indexRefresh: refresh.state,
        builtFromVersion: after.builtFromVersion,
        ...(after.indexBackend ? { indexBackend: after.indexBackend } : {}),
      },
      summary,
    );
  },
};

export default semanticSearch;
