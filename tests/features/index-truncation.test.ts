import { describe, it, expect } from 'vitest';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { progressLine, startIndexBuild, statusSummary, truncationNotice } from '../../src/features/search/build.js';
import { DEFAULT_INDEX_MAX_ITEMS } from '../../src/features/search/limits.js';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

function keywordIndex(): SearchIndex {
  return new MemorySearchIndex({ embedder: null, configured: 'off', logger: silentLogger });
}

/** A library of `total` items, served 100 at a time, like both Zotero APIs. */
function pager(total: number) {
  return async (start: number) => ({
    items: Array.from({ length: Math.min(100, Math.max(0, total - start)) }, (_, i) => ({
      key: `K${start + i}`,
      data: { itemType: 'journalArticle', title: `Item ${start + i}` },
    })),
    totalResults: total,
  });
}

/** Minimal context for the fire-and-forget build path (router + config + index). */
function ctxFor(index: SearchIndex, total: number, env: Record<string, string> = {}): any {
  const page = pager(total);
  return {
    config: loadConfig(env as any),
    search: index,
    logger: silentLogger,
    router: {
      servesLocally: () => false,
      searchItems: async ({ start }: { start: number }) => {
        const p = await page(start);
        return { data: p.items, totalResults: p.totalResults };
      },
    },
  };
}

/** startIndexBuild returns immediately by contract; wait for the background job. */
async function settle(index: SearchIndex): Promise<void> {
  for (let i = 0; i < 500 && index.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

describe('a build stopped by the item cap says so', () => {
  it('keeps the library total apart from the capped total', async () => {
    const index = keywordIndex();
    await index.buildIncremental(pager(320), { maxItems: 200 });
    const s = index.buildStatus();

    expect(s.itemsFetched).toBe(200);
    expect(s.itemsTotal).toBe(200);
    // Without this the two are equal and the truncation leaves no trace anywhere.
    expect(s.itemsAvailable).toBe(320);
  });

  it('reports the shortfall in the progress line and the summary', async () => {
    const index = keywordIndex();
    await index.buildIncremental(pager(320), { maxItems: 200 });
    const s = index.buildStatus();

    expect(progressLine(s)).toContain('200 of 200 items indexed (320 in library)');
    expect(truncationNotice(s)).toContain('120 are NOT searchable');
    expect(statusSummary(s)).toContain('120 are NOT searchable');
  });

  it("names both limits, because the caller's own `limit` may be what bound the build", async () => {
    const index = keywordIndex();
    // 200 came from the caller here, not from ZOTEUS_INDEX_MAX_ITEMS: advice to raise the
    // variable alone would send the user to a setting that is already high enough.
    await index.buildIncremental(pager(320), { maxItems: 200 });
    const notice = truncationNotice(index.buildStatus());

    expect(notice).toContain('`limit`');
    expect(notice).toContain('ZOTEUS_INDEX_MAX_ITEMS');
  });

  it('stays silent when the whole library fits', async () => {
    const index = keywordIndex();
    await index.buildIncremental(pager(150), { maxItems: 200 });
    const s = index.buildStatus();

    expect(s.itemsAvailable).toBe(150);
    expect(truncationNotice(s)).toBe('');
    expect(progressLine(s)).not.toContain('in library');
  });
});

describe('the truncation warning reaches the search itself', () => {
  it('zotero_semantic_search says the index covers only part of the library', async () => {
    const index = keywordIndex();
    await index.buildIncremental(pager(320), { maxItems: 200 });

    const res = await semanticSearch.handler({ q: 'Item 5' }, { search: index } as any);

    expect(res.isError).toBeUndefined();
    // The failure this prevents: "No matches" reading as "the library holds nothing".
    expect(res.content[0].text).toContain('120 are NOT searchable');
  });
});

describe('truncation survives a restart', () => {
  it('is restored from the persisted index, so a reloaded index still warns', async () => {
    const built = keywordIndex();
    await built.buildIncremental(pager(320), { maxItems: 200 });

    const reloaded = keywordIndex();
    reloaded.loadFromJSON(JSON.parse(JSON.stringify(built.toJSON())));
    const s = reloaded.buildStatus();

    expect(s.itemsTotal).toBe(200);
    expect(s.itemsAvailable).toBe(320);
    expect(truncationNotice(s)).toContain('120 are NOT searchable');
    expect(statusSummary(s)).toContain('120 are NOT searchable');
  });

  it('stays silent for an index file written before the counts were persisted', () => {
    const index = keywordIndex();
    index.loadFromJSON({
      chunks: [{ id: 'K1#0', itemKey: 'K1', title: 'Item 1', text: 'body' }],
      vectors: [],
      builtFromVersion: 1,
    } as any);

    expect(truncationNotice(index.buildStatus())).toBe('');
  });
});

describe('the item cap is a runtime parameter', () => {
  it('defaults to the historical value, so an existing install is unchanged', () => {
    expect(loadConfig({}).indexMaxItems).toBe(DEFAULT_INDEX_MAX_ITEMS);
    expect(DEFAULT_INDEX_MAX_ITEMS).toBe(5000);
  });

  it('is raised by ZOTEUS_INDEX_MAX_ITEMS', () => {
    expect(loadConfig({ ZOTEUS_INDEX_MAX_ITEMS: '20000' }).indexMaxItems).toBe(20000);
  });

  it('refuses a non-positive value rather than building an empty index', () => {
    // The cap it would have had, not 0, and not a server that will not start (#18).
    const cfg = loadConfig({ ZOTEUS_INDEX_MAX_ITEMS: '0' });
    expect(cfg.indexMaxItems).toBe(DEFAULT_INDEX_MAX_ITEMS);
    expect(cfg.warnings).toEqual([
      `ZOTEUS_INDEX_MAX_ITEMS="0" is not usable, using ${DEFAULT_INDEX_MAX_ITEMS}`,
    ]);
  });
});

describe('`limit` can lower the configured cap but never raise it', () => {
  it('clamps a larger limit in startIndexBuild', async () => {
    const index = keywordIndex();
    startIndexBuild(ctxFor(index, 320, { ZOTEUS_INDEX_MAX_ITEMS: '150' }), undefined, 10_000);
    await settle(index);
    const s = index.buildStatus();

    expect(s.itemsFetched).toBe(150);
    expect(s.itemsTotal).toBe(150);
    expect(s.itemsAvailable).toBe(320);
  });

  it('still honours a smaller limit', async () => {
    const index = keywordIndex();
    startIndexBuild(ctxFor(index, 320, { ZOTEUS_INDEX_MAX_ITEMS: '150' }), undefined, 50);
    await settle(index);

    expect(index.buildStatus().itemsTotal).toBe(50);
  });

  it('clamps in the zotero_index handler too, and says the figure it will use', async () => {
    const index = keywordIndex();
    const ctx = ctxFor(index, 320, { ZOTEUS_INDEX_MAX_ITEMS: '150' });
    const res = await indexTool.handler({ action: 'build', limit: 10_000 }, ctx);
    await settle(index);

    expect(res.content[0].text).toContain('up to 150 items');
    expect(index.buildStatus().itemsTotal).toBe(150);
  });
});
