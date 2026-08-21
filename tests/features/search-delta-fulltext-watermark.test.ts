import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIndexBuild, PAGE_SIZE } from '../../src/features/search/build.js';
import { SqliteSearchIndex, defaultSearchDbPath } from '../../src/features/search/sqlite-index.js';
import type { SearchIndex } from '../../src/features/search/index-manager.js';
import { refreshIndexIfStale } from '../../src/features/search/delta.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A library whose **full-text versions live on their own sequence**, an order of magnitude
 * above its item versions.
 *
 * That separation is the whole point of the fixture, and the reason ticket 0012's defect
 * survived a suite that already exercised deltas: the existing fake in
 * `search-delta.test.ts` bumps one counter for both, so handing the item watermark to
 * `fullTextSince` looked correct there and could not look otherwise. Measured on the real
 * library, the two ran 410 against 0..25 036 — the shape reproduced here.
 */
function splitSequenceLibrary() {
  const objects = new Map<string, any>();
  const text = new Map<string, { content: string; version: number }>();
  let itemVersion = 100;
  let fulltextVersion = 10_000;

  return {
    get version() {
      return itemVersion;
    },
    get fulltextVersion() {
      return fulltextVersion;
    },
    put(key: string, title: string, abstract: string) {
      itemVersion += 1;
      objects.set(key, { key, version: itemVersion, data: { key, itemType: 'journalArticle', title, abstractNote: abstract } });
    },
    attach(key: string, parent: string) {
      itemVersion += 1;
      objects.set(key, { key, version: itemVersion, data: { key, itemType: 'attachment', title: 'PDF', parentItem: parent } });
    },
    /**
     * Extraction advances ONLY the full-text sequence. That is what Zotero does — the
     * extractor improving does not touch the item's metadata — and it is the case the
     * item `?since=` pass cannot see.
     */
    extract(key: string, content: string) {
      fulltextVersion += 1;
      text.set(key, { content, version: fulltextVersion });
    },
    /** An unrelated metadata edit, to make the library look stale without any extraction. */
    touch(key: string) {
      itemVersion += 1;
      const o = objects.get(key);
      if (o) o.version = itemVersion;
    },
    all(): any[] {
      return [...objects.values()];
    },
    fullTextOf(key: string) {
      return text.get(key);
    },
    fullTextAfter(since: number): Record<string, number> {
      const out: Record<string, number> = {};
      for (const [k, v] of text) if (v.version > since) out[k] = v.version;
      return out;
    },
  };
}

type Lib = ReturnType<typeof splitSequenceLibrary>;

function fakeLocalClient(lib: Lib) {
  return {
    listItems: vi.fn(async (q: { limit?: number; start?: number; since?: number; top?: boolean; itemType?: string }) => {
      let matching = lib.all();
      if (q.top) matching = matching.filter((i) => !i.data.parentItem);
      if (q.itemType) matching = matching.filter((i) => i.data.itemType === q.itemType);
      if (q.since !== undefined) matching = matching.filter((i) => i.version > q.since!);
      const start = q.start ?? 0;
      return {
        data: matching.slice(start, start + (q.limit ?? PAGE_SIZE)),
        totalResults: matching.length,
        lastModifiedVersion: lib.version,
      };
    }),
    versions: vi.fn(async () => Object.fromEntries(lib.all().map((i) => [i.key, i.version]))),
    fullTextSince: vi.fn(async (since: number) => lib.fullTextAfter(since)),
    getFullText: vi.fn(async (key: string) => {
      const t = lib.fullTextOf(key);
      return t ? { content: t.content } : null;
    }),
    getItem: vi.fn(async (key: string) => lib.all().find((i) => i.key === key)),
    getItemChildren: vi.fn(async (key: string) => {
      const data = lib.all().filter((i) => i.data.parentItem === key);
      return { data, totalResults: data.length, lastModifiedVersion: lib.version };
    }),
    listCollections: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: lib.version })),
  };
}

function harness(env: Record<string, string> = {}) {
  const lib = splitSequenceLibrary();
  const local = fakeLocalClient(lib);
  const web = { listItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })) };
  const config = loadConfig({ ZOTEUS_LOCAL: 'auto', ZOTEUS_SEARCH_BACKEND: 'sqlite', ...env } as any);
  const capabilities = { cloud: null as any, localApi: true, localGroupIds: [] as number[] };
  const router = new LibraryRouter({ config, capabilities, web: web as any, local: local as any });
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-ftwm-'));
  const search = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath: defaultSearchDbPath(dir) });
  const ctx: any = { config, capabilities, router, web, local, search, logger: silentLogger };
  return { lib, local, ctx, search, dir };
}

async function settled(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** One item with one extracted attachment, repeated `n` times. */
function seed(h: ReturnType<typeof harness>, n: number): void {
  for (let i = 0; i < n; i++) {
    const key = `IT${String(i).padStart(3, '0')}`;
    h.lib.put(key, `Paper ${i}`, `abstract number ${i}`);
    h.lib.attach(`AT${String(i).padStart(3, '0')}`, key);
    h.lib.extract(`AT${String(i).padStart(3, '0')}`, `body text of paper ${i} mentioning thermohaline circulation`);
  }
}

describe('full-text watermark — a second sequence, tracked separately (ticket 0012)', () => {
  it('seeds the full-text watermark from the build, not from the library version', async () => {
    const h = harness();
    seed(h, 5);
    startIndexBuild(h.ctx, undefined, undefined, { fulltext: true });
    await settled(h.search);

    // The two numbers are different, and the index holds both. Before this ticket only
    // the item one existed, and `fullTextSince` was handed it.
    expect(h.search.watermark.version).toBe(h.lib.version);
    expect(h.search.fulltextWatermark).toBe(h.lib.fulltextVersion);
    expect(h.search.fulltextWatermark).toBeGreaterThan(h.search.watermark.version * 10);
  });

  it('asks fullTextSince for the full-text watermark, and a quiet delta finds nothing', async () => {
    const h = harness();
    seed(h, 5);
    startIndexBuild(h.ctx, undefined, undefined, { fulltext: true });
    await settled(h.search);

    h.local.fullTextSince.mockClear();
    h.local.getItem.mockClear();
    // A metadata edit on one item: the library is stale, so a delta runs, but nothing was
    // re-extracted. This is the ordinary case, and the one the defect made expensive.
    h.lib.touch('IT000');

    const out = await refreshIndexIfStale(h.ctx);
    expect(out.state).toBe('applied');

    // THE RED ASSERTION. Against the old code this is `100`-ish — the library version —
    // and the sweep comes back with every extracted attachment in the library.
    expect(h.local.fullTextSince).toHaveBeenCalledWith(h.search.fulltextWatermark, expect.anything());
    expect(h.local.fullTextSince.mock.results).toHaveLength(1);
    await expect(h.local.fullTextSince.mock.results[0]!.value).resolves.toEqual({});

    // And the cost the over-report bought: one `getItem` per spurious candidate. Only the
    // genuinely edited item is fetched now.
    const fetched = h.local.getItem.mock.calls.map((c) => c[0]);
    expect(fetched.filter((k) => String(k).startsWith('AT'))).toEqual([]);
  });

  it('still catches a re-extraction that touches no item version', async () => {
    const h = harness();
    seed(h, 3);
    startIndexBuild(h.ctx, undefined, undefined, { fulltext: true });
    await settled(h.search);

    const before = h.search.fulltextWatermark;
    // The case this whole mechanism exists for: Zotero re-extracts an attachment, the
    // parent item's own version does not move, and only the full-text sequence advances.
    h.lib.extract('AT001', 'body text of paper 1 mentioning anisotropic quantization');
    // A delta needs the library to look stale to run at all; that gate is the item
    // sequence's job and is not what this test is about.
    h.lib.touch('IT000');

    const out = await refreshIndexIfStale(h.ctx);
    expect(out.state).toBe('applied');
    expect(h.search.fulltextWatermark).toBe(h.lib.fulltextVersion);
    expect(h.search.fulltextWatermark).toBeGreaterThan(before);

    const hits = await h.search.query('anisotropic quantization', { limit: 5 });
    expect(hits.map((x: any) => x.itemKey)).toContain('IT001');
  });

  it('converges when the ceiling truncates the sweep, instead of re-reading the same prefix', async () => {
    const h = harness();
    seed(h, 2);
    startIndexBuild(h.ctx, undefined, undefined, { fulltext: true });
    await settled(h.search);

    // Six attachments re-extracted, each on its own full-text version, against a delta
    // ceiling of two. Ascending-version order plus a watermark that records how far the
    // sweep got is what makes three deltas finish the job; map order plus an unmoved
    // watermark is a loop that never gets past the first two.
    for (let i = 0; i < 6; i++) {
      h.lib.attach(`AX${i}`, 'IT000');
      h.lib.extract(`AX${i}`, `extra body ${i}`);
    }

    const seen: number[] = [];
    for (let round = 0; round < 10; round++) {
      h.lib.touch('IT001');
      await refreshIndexIfStale(h.ctx, undefined, { maxDeltaItems: 2 });
      seen.push(h.search.fulltextWatermark);
      if (h.search.fulltextWatermark === h.lib.fulltextVersion) break;
    }

    // Never goes backwards, makes progress on the first round, and finishes. Against map
    // order with an unmoved watermark every entry of `seen` is the same number.
    expect(seen[0]!).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(new Set(seen).size).toBeGreaterThan(1);
    expect(seen[seen.length - 1]!).toBe(h.lib.fulltextVersion);
  });

  it('carries the watermark across a restart, and clears it with the item watermark', async () => {
    const h = harness();
    seed(h, 3);
    startIndexBuild(h.ctx, undefined, undefined, { fulltext: true });
    await settled(h.search);
    const recorded = h.search.fulltextWatermark;
    expect(recorded).toBeGreaterThan(0);

    // Reopening the same file is what a server restart is. A watermark that lived only in
    // the process would restart at 0 and re-report the whole library as newly extracted —
    // the same defect, arriving by a different door.
    const reopened = new SqliteSearchIndex({
      embedder: null,
      logger: silentLogger,
      dbPath: defaultSearchDbPath(h.dir),
    });
    expect(reopened.fulltextWatermark).toBe(recorded);
    expect(reopened.watermark.version).toBe(h.lib.version);

    // And the invariant that lets the full-text watermark go unlabelled: it is cleared
    // with the item watermark, never apart from it, so no path exists on which one is
    // attributable to a backend and the other is not. A build that fails on its first
    // page is the cheapest way to reach that clearing: `buildIncremental` empties the
    // index and forgets the watermark before it fetches anything.
    const failed = await reopened.buildIncremental(async () => {
      throw new Error('library unreachable');
    });
    expect(failed.state).toBe('error');
    expect(reopened.watermark.version).toBe(0);
    expect(reopened.watermark.backend).toBeUndefined();
    expect(reopened.fulltextWatermark).toBe(0);
  });
});
