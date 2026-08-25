import { describe, it, expect } from 'vitest';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { progressLine, statusSummary, truncationNotice } from '../../src/features/search/build.js';
import { DEFAULT_INDEX_MAX_ITEMS } from '../../src/features/search/limits.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

function keywordIndex(): SearchIndex {
  return new SearchIndex({ embedder: null, configured: 'off', logger: silentLogger });
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

    expect(progressLine(s)).toContain('200 of 320');
    expect(truncationNotice(s)).toContain('120 are NOT searchable');
    expect(statusSummary(s)).toContain('ZOTEUS_INDEX_MAX_ITEMS');
  });

  it('stays silent when the whole library fits', async () => {
    const index = keywordIndex();
    await index.buildIncremental(pager(150), { maxItems: 200 });
    const s = index.buildStatus();

    expect(s.itemsAvailable).toBe(150);
    expect(truncationNotice(s)).toBe('');
    expect(progressLine(s)).not.toContain(' of ');
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

  it('rejects a non-positive value rather than building an empty index', () => {
    expect(() => loadConfig({ ZOTEUS_INDEX_MAX_ITEMS: '0' })).toThrow();
  });
});
