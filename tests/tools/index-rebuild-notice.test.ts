import { describe, it, expect, vi } from 'vitest';
import indexTool from '../../src/tools/index-tool.js';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { PAGE_SIZE } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * `action:"build"` over an index that already holds rows is a rebuild from scratch, and it
 * replaces those rows at its first commit. That is by design (the partial index is
 * searchable from its first commit, and the checkpoint makes it resumable), but the
 * reporter of #59 learned it from a build that aborted and left 1,300 items where a
 * complete 97,000-passage index had been. The tool now says so when the build starts, and
 * points at `action:"update"` as the path that leaves a complete index in place.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

function router(n: number) {
  const items = Array.from({ length: n }, (_, i) => ({
    key: `K${String(i).padStart(3, '0')}`,
    data: { key: `K${String(i).padStart(3, '0')}`, itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `topic${i}` },
  }));
  return {
    servesLocally: vi.fn(() => false),
    defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
    searchItems: vi.fn(async (q: any) => {
      const start = q.start ?? 0;
      return { data: items.slice(start, start + (q.limit ?? PAGE_SIZE)), totalResults: items.length, lastModifiedVersion: 3 };
    }),
    itemVersions: vi.fn(async () => ({
      versions: Object.fromEntries(items.map((it) => [it.key, 1])),
      totalResults: items.length,
      lastModifiedVersion: 3,
    })),
    fullTextSince: vi.fn(async () => ({})),
    getFullText: vi.fn(async () => null),
  };
}

function makeCtx(search: SearchIndex, n: number): any {
  return {
    config: loadConfig({ ZOTEUS_LOCAL: 'off', ZOTEUS_INDEX_OWN_WORDS: 'false' } as any),
    search,
    router: router(n),
    logger: silentLogger,
    searchIndexPath: '',
  };
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

const text = (res: any): string => res.content.map((c: any) => c.text).join('\n');

describe.each(backends)('action:"build" over an index that already holds rows (%s backend)', (backend) => {
  it('says that it replaces the existing index, with its size, and names update as the alternative', async () => {
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
    const ctx = makeCtx(search, 12);
    // The first build says nothing of the kind: there is nothing to replace.
    const first = text(await indexTool.handler({ action: 'build' }, ctx));
    expect(first).not.toContain('REPLACES');
    await settle(search);
    expect(search.buildStatus().state).toBe('done');
    expect(search.buildStatus().documents).toBe(12);

    const again = text(await indexTool.handler({ action: 'build' }, ctx));
    expect(again).toContain('Index build started in the background');
    expect(again).toContain('This REPLACES the existing index (12 passages over 12 items) from its first commit');
    expect(again).toContain('action:"update" is the incremental path and leaves it in place');
    await settle(search);
    expect(search.buildStatus().state).toBe('done');
    await search.close();
  });

  it('does not say so for a build that resumes an interrupted one', async () => {
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
    const ctx = makeCtx(search, 250);
    // Stop after the first page so a checkpoint is left behind.
    const page = ctx.router.searchItems;
    ctx.router.searchItems = vi.fn(async (q: any) => {
      const res = await page(q);
      if (q.start >= PAGE_SIZE) search.requestStop();
      return res;
    });
    await indexTool.handler({ action: 'build' }, ctx);
    await settle(search);
    const stopped = search.buildStatus();
    expect(stopped.items).toBeGreaterThan(0);
    expect(stopped.items).toBeLessThan(250);

    ctx.router.searchItems = page;
    const resumed = text(await indexTool.handler({ action: 'build' }, ctx));
    expect(resumed).toContain('RESUMED');
    // What a resume keeps is the point of resuming; it replaces nothing.
    expect(resumed).not.toContain('REPLACES');
    await settle(search);
    expect(search.buildStatus().items).toBe(250);
    await search.close();
  });
});
