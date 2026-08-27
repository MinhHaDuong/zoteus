import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import {
  progressLine,
  startIndexBuild,
  startIndexUpdate,
  statusSummary,
  updateNotice,
} from '../features/search/build.js';
import { repairSearchIndex, type RepairReport } from '../features/search/repair.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from '../features/search/fulltext-source.js';
import { DEFAULT_INDEX_MAX_ITEMS } from '../features/search/limits.js';
import type { LibraryRef } from '../api/web-client.js';

const indexTool: ToolDefinition = {
  name: 'zotero_index',
  title: 'Build the semantic search index',
  description:
    `Manage the local hybrid-search index used by zotero_semantic_search. Every job runs in the background on the server, so this tool returns immediately and never blocks on large libraries. THREE write actions, and picking the right one matters: \`action: "update"\` is the cheap one and should be the default for a library that is already indexed; \`action: "build"\` and its alias \`action: "refresh"\` both rebuild the WHOLE index from scratch, which on a large library means many minutes and, with an API embedding provider, real spend. \`action: "build"\`/"refresh" pages the library's top-level items (100-at-a-time, stopping at the server's item cap, ZOTEUS_INDEX_MAX_ITEMS, default ${DEFAULT_INDEX_MAX_ITEMS}, or at a smaller \`limit\` if one is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and, if an embedding provider is configured, for vector search, persisting partial progress atomically as it goes; use it for the first build, after changing the embedding model, or to widen a previously capped build. It is ALSO the repair: if the index cannot be read at all, only \`action:"build"\` clears it, by deleting the unreadable file and opening a fresh one before rebuilding (nothing repairs it at startup or inside a query). \`action: "update"\` instead fetches only the items changed since the version the index recorded (Zotero's \`?since=\`), re-chunks and re-embeds just those, and removes items the library no longer holds (diffed from a cheap keys-only \`?format=versions\` census, since the deletion log is cloud-only); untouched items are never re-embedded, so adding a handful of items costs seconds instead of a full rebuild. Update falls back to a full rebuild by itself, and says so in \`updateNotice\`, when a delta would be wrong: no version stamp recorded yet, the library is now served by a different Zotero API (the desktop app and the cloud number their versions independently), or the embedding model changed. Set \`fulltext:true\` to ALSO index the body text Zotero extracted from each item's attachments, which is what makes semantic search match a claim buried in a PDF rather than only its title and abstract; it is off by default because it multiplies build time and index size (default cap: ${DEFAULT_FULLTEXT_MAX_CHARS} characters per item, tunable with \`fulltext_max_chars\`), and only attachments Zotero has already extracted are available. A build runs in TWO passes and reports which one it is on as \`phase\`: every item's metadata is indexed first, across the whole library, and only then are attachment bodies crawled (\`fulltextItemsScanned\` of \`fulltextItemsTotal\`). So the library is fully searchable on titles, abstracts, creators and tags long before a full-text crawl that can run for hours finishes — tell the user they can search already rather than asking them to wait for state:"done". Start a job, then POLL \`action: "status"\` every few seconds until \`state\` is "done" (or "error"); calling build or update again while one is running just returns current progress. \`action: "status"\` reports \`state\` (idle|building|done|error), \`operation\` (build|update), \`phase\` (metadata|fulltext), fetch/embed progress, \`itemsRemoved\`, index size, the active embedder, \`libraryVersion\`/\`libraryBackend\` (the version stamp an update diffs from), \`itemsTotal\`/\`itemsAvailable\` (which differ, with a warning, when the cap stopped the crawl short of the library), and (when full text was requested) \`fulltextItems\`/\`fulltextPassages\` plus \`fulltextReason\` if it produced nothing. It also reports where the index is stored (\`storage\`: sqlite or memory, set by ZOTEUS_INDEX_BACKEND), \`storageNotice\` when opening that store imported or refused an older JSON index, and \`persistError\` when the index could not be written to disk at all. \`action: "stop"\` cancels a running job (partial data is kept and stays searchable; a stopped update leaves the version stamp untouched so the next one repeats the delta). A partially built index is always usable for keyword search. Local embeddings are CPU-bound (see ZOTEUS_EMBEDDINGS), so large builds take a while: poll status rather than retrying build.`,
  inputSchema: {
    action: z.enum(['build', 'refresh', 'update', 'status', 'stop']),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Max items to index. Lowers the configured cap for this build only; it cannot raise it. ' +
          `The cap defaults to ${DEFAULT_INDEX_MAX_ITEMS} and is set by ZOTEUS_INDEX_MAX_ITEMS.`,
      ),
    fulltext: z
      .boolean()
      .optional()
      .describe(
        'Also index the full text Zotero extracted from each item\'s attachments, so searches match the body of a PDF. ' +
          'Resource-intensive (slower build, much larger index); defaults to ZOTEUS_INDEX_FULLTEXT (off unless set).',
      ),
    fulltext_max_chars: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe(
        `Cap on indexed full-text characters per item; 0 means no cap (default ${DEFAULT_FULLTEXT_MAX_CHARS}). Only used with fulltext.`,
      ),
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'status') {
      const s = ctx.search.buildStatus();
      return ok({ ...s }, statusSummary(s));
    }
    if (args.action === 'stop') {
      const stopped = ctx.search.requestStop();
      if (stopped) {
        return ok(
          { ...ctx.search.buildStatus() },
          'Stop requested — the build halts after the current page/batch and keeps the partial index. Poll action:"status".',
        );
      }
      return ok({ ...ctx.search.buildStatus() }, 'No build is currently running.');
    }

    // build / refresh / update: kick off a background job and return immediately.
    //
    // An unreadable index is repaired here and nowhere else. `action:"build"` is consent:
    // the caller has asked for the whole library to be re-read, so deleting the derived
    // cache first is part of what they asked for. `action:"update"` is not — it is the
    // cheap call, and it cannot run against a store it cannot read anyway (#21).
    const fault = ctx.search.storeFault;
    if (fault && args.action === 'update') {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${fault.message}\n\nAn incremental update cannot repair this: it needs the existing index to diff ` +
              'against. Call zotero_index with action:"build" instead, which replaces the index and rebuilds it.',
          },
        ],
        isError: true,
      };
    }
    let repaired: RepairReport | undefined;
    if (fault) {
      try {
        repaired = await repairSearchIndex(ctx);
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    }

    if (ctx.search.isBuilding) {
      const s = ctx.search.buildStatus();
      return ok(
        { ...s },
        `A build is already in progress — ${progressLine(s)}. Poll action:"status" instead of starting another build.`,
      );
    }
    const lib: LibraryRef | undefined = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    const maxItems = Math.min(args.limit ?? ctx.config.indexMaxItems, ctx.config.indexMaxItems);
    const fulltext = args.fulltext ?? ctx.config.indexFulltext;
    const opts = { fulltext, fulltextMaxChars: args.fulltext_max_chars };
    if (args.action === 'update') {
      const s = startIndexUpdate(ctx, lib, maxItems, opts);
      // The status already says whether this became a rebuild, and why, so the summary
      // must not promise a delta the update path may have refused: report what started.
      const kind = s.operation === 'update' ? 'Index update' : 'Full index rebuild';
      return ok(
        { ...s },
        `${kind} started in the background.${updateNotice(s)} ` +
          'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.',
      );
    }
    const s = startIndexBuild(ctx, lib, maxItems, opts);
    const ftNote = fulltext
      ? ' Attachment full text is included, so expect a noticeably longer build and a larger index; every item\'s' +
        ' metadata is indexed first, so the library becomes searchable well before the full-text pass finishes.'
      : '';
    // Said outright rather than left for the user to infer from a build that suddenly works:
    // files were deleted on their behalf, and they should know which.
    // `removed` can legitimately be empty: every file the fault named was already gone, so
    // there was nothing to delete and the reopen alone was the repair. Saying "removed ()"
    // there would be both ugly and untrue.
    const repairNote = repaired
      ? repaired.removed.length
        ? `The unreadable index was removed first (${repaired.removed.join(', ')}) and a fresh ${repaired.storage} index opened in its place. `
        : `The unreadable index was replaced with a fresh ${repaired.storage} one (its files were already gone). `
      : '';
    return ok(
      { ...s, ...(repaired ? { repaired: repaired.removed } : {}) },
      `${repairNote}Index build started in the background (up to ${maxItems} items).${ftNote} ` +
        'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.',
    );
  },
};

export default indexTool;
