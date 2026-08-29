import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate } from '../../src/features/search/build.js';
import indexTool from '../../src/tools/index-tool.js';
import { loadConfig } from '../../src/config.js';
import type { IndexSnapshot, SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * An interrupted build used to be unresumable: the version stamp was the only progress a
 * build recorded, it is deliberately withheld from a build that did not finish, and the
 * desktop local API commonly answers with no version at all. So the next build cleared the
 * store and crawled from 0 over items it had already fetched, chunked and paid to embed
 * (#24). A build now commits a checkpoint beside its rows and carries on from it.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** node:sqlite arrived in Node 22.13; where it is missing those cases skip, as elsewhere. */
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

/**
 * A Zotero library that pages like both APIs do. `versioned: false` is the desktop app as
 * #24 met it: an answer carrying no Last-Modified-Version, which the local client reports
 * as 0 and which no stamp can be made of.
 */
class FakeLibrary {
  version = 0;
  private readonly items = new Map<string, { key: string; version: number; data: any }>();

  put(key: string, title: string, abstractNote = ''): void {
    this.version++;
    this.items.set(key, { key, version: this.version, data: { key, itemType: 'journalArticle', title, abstractNote } });
  }

  remove(key: string): void {
    this.version++;
    this.items.delete(key);
  }

  get size(): number {
    return this.items.size;
  }

  router(opts: { local?: boolean; versioned?: boolean } = {}) {
    const versioned = opts.versioned ?? true;
    const all = () => [...this.items.values()];
    return {
      servesLocally: vi.fn(() => Boolean(opts.local)),
      defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
      searchItems: vi.fn(async (q: any) => {
        const since = q.since ?? 0;
        const matching = all().filter((it) => it.version > since);
        const start = q.start ?? 0;
        return {
          data: matching.slice(start, start + (q.limit ?? PAGE_SIZE)).map((it) => ({ key: it.key, data: it.data })),
          totalResults: matching.length,
          lastModifiedVersion: versioned ? this.version : 0,
        };
      }),
      itemVersions: vi.fn(async (q: any) => {
        const start = q.start ?? 0;
        const page = all().slice(start, start + (q.limit ?? PAGE_SIZE));
        return {
          versions: Object.fromEntries(page.map((it) => [it.key, it.version])),
          totalResults: this.items.size,
          lastModifiedVersion: versioned ? this.version : 0,
        };
      }),
    };
  }
}

/** An embedder that records every text it is asked to embed. */
function countingEmbedder(model = 'fake-model') {
  const texts: string[] = [];
  const provider: EmbeddingProvider = {
    name: 'counting',
    model,
    embed: async (batch: string[]) => {
      texts.push(...batch);
      return batch.map((t) => [t.length % 7, 1, 0]);
    },
  };
  return { provider, texts, calls: () => texts.length };
}

async function openIndex(
  backend: 'memory' | 'sqlite',
  opts: Partial<SearchIndexOptions> = {},
  dir?: string,
): Promise<SearchIndex> {
  return createSearchIndex({
    embedder: null,
    logger: silentLogger,
    ...opts,
    backend,
    jsonPath: dir ? join(dir, 'search-index.json') : '',
  });
}

function makeCtx(search: SearchIndex, router: any, env: Record<string, string> = {}): any {
  return { config: loadConfig(env as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

/** Both starters return immediately by contract; wait for the background job. */
async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

/** A router whose Nth page of items stops the build, the way a user's action:"stop" does. */
function stoppingRouter(lib: FakeLibrary, search: SearchIndex, afterPages: number, local = true) {
  const router = lib.router({ local, versioned: !local });
  const page = router.searchItems;
  let pages = 0;
  router.searchItems = vi.fn(async (q: any) => {
    const res = await page(q);
    if (q.top && ++pages >= afterPages) search.requestStop();
    return res;
  }) as any;
  return router;
}

function library(n: number): FakeLibrary {
  const lib = new FakeLibrary();
  for (let i = 0; i < n; i++) lib.put(`K${i}`, `Item ${i}`, `abstract about topic${i}`);
  return lib;
}

describe.each(backends)('an interrupted build resumes rather than restarting (%s backend)', (backend) => {
  it('carries on from the desktop-API build that stopped, although it stamped no version', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-resume-${backend}-`));
    const lib = library(250);
    const first = await openIndex(backend, {}, dir);
    startIndexBuild(makeCtx(first, stoppingRouter(lib, first, 2)));
    await settle(first);
    const stopped = first.buildStatus();
    // The exact state #24 reports: real work committed, and no stamp to resume from.
    expect(stopped.items).toBeGreaterThan(0);
    expect(stopped.items).toBeLessThan(250);
    expect(stopped.libraryVersion).toBe(0);
    await first.save();
    await first.close();

    // Zoteus restarts: the checkpoint has to come back off disk with the rows.
    const resumed = await openIndex(backend, {}, dir);
    const router = lib.router({ local: true, versioned: false });
    startIndexBuild(makeCtx(resumed, router));
    await settle(resumed);
    const s = resumed.buildStatus();

    expect(s.resumedFrom).toBe(stopped.items);
    expect(s.state).toBe('done');
    expect(s.items).toBe(250);
    // The resume point is a stored offset, not a search for one: the first page asked for
    // starts at the item after the last one committed.
    expect(router.searchItems.mock.calls[0]![0]).toMatchObject({ start: stopped.items, top: true });
    expect(s.updateNotice).toMatch(/RESUMED an interrupted one: \d+ items were already indexed/);
    await resumed.close();
  });

  it('keeps every committed passage searchable, duplicating none of them', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-resume-keep-${backend}-`));
    const lib = library(250);
    const first = await openIndex(backend, {}, dir);
    startIndexBuild(makeCtx(first, stoppingRouter(lib, first, 2)));
    await settle(first);
    const committed = first.buildStatus().items;
    // Searchable before the resume, which is what makes a partial index worth keeping.
    expect((await first.query('topic7', { limit: 1 }))[0]!.itemKey).toBe('K7');
    await first.save();
    await first.close();

    const resumed = await openIndex(backend, {}, dir);
    startIndexBuild(makeCtx(resumed, lib.router({ local: true, versioned: false })));
    await settle(resumed);

    const s = resumed.buildStatus();
    expect(s.items).toBe(250);
    // One passage per item on both sides of the interruption: nothing was written twice.
    expect(s.documents).toBe(250);
    expect((await resumed.query('topic7', { limit: 1 }))[0]!.itemKey).toBe('K7');
    expect((await resumed.query(`topic${committed + 5}`, { limit: 1 }))[0]!.itemKey).toBe(`K${committed + 5}`);
    await resumed.close();
  });

  it('never re-embeds an item the interrupted build had already embedded', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-resume-embed-${backend}-`));
    const lib = library(250);
    const before = countingEmbedder();
    const first = await openIndex(backend, { embedder: before.provider }, dir);
    startIndexBuild(makeCtx(first, stoppingRouter(lib, first, 2)));
    await settle(first);
    const committed = first.buildStatus().items;
    await first.save();
    await first.close();

    const after = countingEmbedder();
    const resumed = await openIndex(backend, { embedder: after.provider }, dir);
    startIndexBuild(makeCtx(resumed, lib.router({ local: true, versioned: false })));
    await settle(resumed);

    // Every passage embedded exactly once across the two runs, and never the same text
    // twice: what the resume redoes is the queue the interruption caught mid-flight, which
    // was committed without vectors, not work anyone has paid for.
    expect(before.calls() + after.calls()).toBe(250);
    expect(after.texts.filter((t) => before.texts.includes(t))).toEqual([]);
    expect(after.calls()).toBeGreaterThanOrEqual(250 - committed);
    expect(resumed.buildStatus().vectors).toBe(250);
    await resumed.close();
  });

  it('converges on the index an uninterrupted build would have produced', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-resume-same-${backend}-`));
    const lib = library(250);
    const first = await openIndex(backend, {}, dir);
    startIndexBuild(makeCtx(first, stoppingRouter(lib, first, 2)));
    await settle(first);
    await first.save();
    await first.close();
    const resumed = await openIndex(backend, {}, dir);
    startIndexBuild(makeCtx(resumed, lib.router({ local: true, versioned: false })));
    await settle(resumed);

    const straight = await openIndex(backend);
    startIndexBuild(makeCtx(straight, lib.router({ local: true, versioned: false })));
    await settle(straight);

    const a = resumed.buildStatus();
    const b = straight.buildStatus();
    for (const field of ['items', 'documents', 'vectors', 'itemsTotal', 'itemsAvailable', 'builtFromVersion'] as const) {
      expect([field, a[field]]).toEqual([field, b[field]]);
    }
    expect((await resumed.query('topic249', { limit: 1 }))[0]).toEqual((await straight.query('topic249', { limit: 1 }))[0]);
    await resumed.close();
    await straight.close();
  });
});

describe('the resume point is committed with the rows it describes', () => {
  it('redoes no more than the last persistence interval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-resume-interval-'));
    const file = join(dir, 'search-index.json');
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger, path: file });
    const items = Array.from({ length: 60 }, (_, i) => ({
      key: `K${i}`,
      data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
    }));
    await search.buildIncremental(
      async (start) => {
        if (start >= 45) search.requestStop();
        return { items: items.slice(start, start + 10), totalResults: items.length };
      },
      { persistEveryItems: 10, persistEveryMs: 60_000 },
    );

    const saved = JSON.parse(readFileSync(file, 'utf8')) as IndexSnapshot;
    const indexed = new Set(saved.chunks.map((c) => c.itemKey)).size;
    // The checkpoint is written into the same file as the rows, so it can never name an
    // offset past them: what a resume redoes is bounded by one persistence interval.
    expect(saved.checkpoint).toBeDefined();
    expect(saved.checkpoint!.crawlOffset).toBeLessThanOrEqual(indexed);
    expect(indexed - saved.checkpoint!.crawlOffset).toBeLessThan(10);
    expect(saved.checkpoint!.phase).toBe('metadata');
  });

  it('is gone once the build finishes, so the next build is a real rebuild', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-resume-clear-'));
    const file = join(dir, 'search-index.json');
    const lib = library(5);
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger, path: file });
    startIndexBuild(makeCtx(search, lib.router({ local: true, versioned: false })));
    await settle(search);
    await search.save();

    expect((JSON.parse(readFileSync(file, 'utf8')) as IndexSnapshot).checkpoint).toBeUndefined();
    const again = await openIndex('memory', {}, dir);
    startIndexBuild(makeCtx(again, lib.router({ local: true, versioned: false })));
    await settle(again);
    expect(again.buildStatus().resumedFrom).toBeUndefined();
  });

  it('duplicates nothing when the checkpoint lags the rows it was saved with', async () => {
    // What a kill mid-build leaves behind, or a shutdown flush that saved rows written
    // since the last checkpoint: an offset pointing BEFORE items that are already indexed.
    // The crawl then meets them again, and steps over them by key rather than writing them
    // a second time.
    const shelf = Array.from({ length: 200 }, (_, i) => ({
      key: `K${i}`,
      data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
    }));
    const first = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await first.buildIncremental(
      async (start) => {
        if (start >= 100) first.requestStop();
        return { items: shelf.slice(start, start + 50), totalResults: shelf.length };
      },
      { persistEveryItems: 50 },
    );
    const saved = JSON.parse(JSON.stringify(first.toJSON())) as IndexSnapshot;
    expect(saved.checkpoint).toBeDefined();
    saved.checkpoint!.crawlOffset = 0;

    const reopened = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    reopened.loadFromJSON(saved);
    const committed = reopened.buildStatus().items;
    const final = await reopened.buildIncremental(async (start) => ({
      items: shelf.slice(start, start + 50),
      totalResults: shelf.length,
    }));

    expect(committed).toBeGreaterThan(0);
    expect(final.items).toBe(200);
    expect(final.documents).toBe(200); // one passage per item, none written twice
    expect((await reopened.query('topic7', { limit: 2 }))).toHaveLength(1);
  });

  it('survives a build that failed rather than one that was stopped', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const items = Array.from({ length: 300 }, (_, i) => ({ key: `K${i}`, data: { title: `Item ${i}` } }));
    const failed = await search.buildIncremental(
      async (start) => {
        if (start >= 200) throw new Error('Zotero 500');
        return { items: items.slice(start, start + 100), totalResults: items.length };
      },
      { persistEveryItems: 1 },
    );
    expect(failed.state).toBe('error');

    // The retry continues the crawl instead of paying for the first 200 items again.
    const asked: number[] = [];
    const final = await search.buildIncremental(async (start) => {
      asked.push(start);
      return { items: items.slice(start, start + 100), totalResults: items.length };
    });
    expect(asked[0]).toBe(200);
    expect(final.items).toBe(300);
    expect(final.resumedFrom).toBe(200);
  });
});

describe('a resume verifies the stored offset instead of trusting it', () => {
  const items = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({
      key: `K${i + offset}`,
      data: { itemType: 'journalArticle', title: `Item ${i + offset}`, abstractNote: `abstract about topic${i + offset}` },
    }));

  it('walks the library again when it moved under the interrupted build, keeping every row', async () => {
    const embedder = countingEmbedder();
    const search = new MemorySearchIndex({ embedder: embedder.provider, logger: silentLogger });
    const before = items(200);
    await search.buildIncremental(
      async (start) => {
        if (start >= 100) search.requestStop();
        return { items: before.slice(start, start + 100), totalResults: before.length };
      },
      { persistEveryItems: 10 },
    );
    const committed = search.buildStatus().items;
    expect(committed).toBe(100);
    const embeddedByFirst = embedder.calls();

    // Three items were added while Zoteus was down, so Zotero's newest-first paging has
    // shifted everything: the stored offset now points three items too far.
    const after = [...items(3, 200), ...before];
    const asked: number[] = [];
    const final = await search.buildIncremental(async (start) => {
      asked.push(start);
      return { items: after.slice(start, start + 100), totalResults: after.length };
    });

    // It noticed at the first page, went back to the top, and skipped what it holds.
    expect(asked[0]).toBe(100);
    expect(asked[1]).toBe(0);
    expect(final.items).toBe(203);
    expect(final.documents).toBe(203);
    // 203 passages, 203 embeddings across both runs: walking the library again costs pages,
    // never a second vector for an item that already had one.
    expect(embeddedByFirst).toBeGreaterThan(0);
    expect(embedder.calls()).toBe(203);
    expect(final.updateNotice).toMatch(/walked the whole library again/);
    expect((await search.query('topic201', { limit: 1 }))[0]!.itemKey).toBe('K201');
  });

  it('refuses to resume under a different embedding model', async () => {
    const small = countingEmbedder('text-embedding-3-small');
    const search = new MemorySearchIndex({ embedder: small.provider, logger: silentLogger });
    const library200 = items(200);
    await search.buildIncremental(async (start) => {
      if (start >= 100) search.requestStop();
      return { items: library200.slice(start, start + 100), totalResults: library200.length };
    });
    expect(search.buildStatus().items).toBe(100);

    // Two vector spaces in one index is exactly what updateBlocker refuses a delta over,
    // and a resume must not create it by the back door.
    (search as any).opts.embedder = countingEmbedder('text-embedding-3-large').provider;
    const final = await search.buildIncremental(async (start) => ({
      items: library200.slice(start, start + 100),
      totalResults: library200.length,
    }));
    expect(final.resumedFrom).toBeUndefined();
    expect(final.items).toBe(200);
    expect(final.vectors).toBe(200);
  });

  it('starts over for action:"refresh", which is what that action is for', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-resume-refresh-'));
    const lib = library(250);
    const search = await openIndex('memory', {}, dir);
    const ctx = makeCtx(search, stoppingRouter(lib, search, 2));
    await indexTool.handler({ action: 'build' }, ctx);
    await settle(search);
    expect(search.buildStatus().items).toBeLessThan(250);

    const fresh = makeCtx(search, lib.router({ local: true, versioned: false }));
    const started = await indexTool.handler({ action: 'refresh' }, fresh);
    expect(started.structuredContent?.resumedFrom).toBeUndefined();
    await settle(search);
    expect(fresh.router.searchItems.mock.calls[0]![0]).toMatchObject({ start: 0 });
    expect(search.buildStatus().items).toBe(250);
    await search.close();
  });

  it('says a resume is what started, in the tool output that reported a rebuild', async () => {
    const lib = library(250);
    const search = await openIndex('memory');
    const ctx = makeCtx(search, stoppingRouter(lib, search, 2));
    await indexTool.handler({ action: 'build' }, ctx);
    await settle(search);

    // The path #24 was filed from: action:"update" cannot diff an index with no stamp, so
    // it falls back to a build — which now continues the interrupted one.
    const resumed = makeCtx(search, lib.router({ local: true, versioned: false }));
    const started = await indexTool.handler({ action: 'update' }, resumed);
    expect(started.content[0]!.text).toMatch(/Interrupted index build resumed/);
    expect(started.content[0]!.text).toMatch(/RESUMES that one rather than starting over/);
    await settle(search);
    expect(search.buildStatus().items).toBe(250);
  });
});

describe('the full-text pass resumes too', () => {
  const BODY = 'The ablation removes the recurrent gate entirely. '.repeat(30);
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: `K${i}`,
      data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
    }));

  it('fetches no body it has already indexed, and finishes the ones it had not', async () => {
    const shelf = items(250);
    const pager = (start: number, version?: number) => ({
      items: shelf.slice(start, start + 100),
      totalResults: shelf.length,
      ...(version ? { lastModifiedVersion: version } : {}),
    });
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const firstPass: string[] = [];
    await search.buildIncremental(async (start) => pager(start), {
      fulltextFor: async (key) => {
        // Into the second group of bodies, so the first group is committed behind us.
        if (firstPass.length >= 100) search.requestStop();
        firstPass.push(key);
        return BODY;
      },
    });
    const partway = search.buildStatus();
    expect(partway.items).toBe(250);
    expect(partway.fulltextItems).toBe(100);
    // No stamp: a build stopped in its body crawl covers an unknown part of the library.
    expect(partway.libraryVersion).toBe(0);

    const secondPass: string[] = [];
    const final = await search.buildIncremental(async (start) => pager(start, 77), {
      fulltextFor: async (key) => {
        secondPass.push(key);
        return BODY;
      },
      versionBackend: 'local',
    });

    // Not one body re-read, and the pass finished: the counters and the stamp say so.
    for (const key of secondPass) expect(firstPass.slice(0, 100)).not.toContain(key);
    expect(secondPass).toHaveLength(150);
    expect(final.fulltextItems).toBe(250);
    expect(final.fulltextItemsScanned).toBe(250);
    expect(final.fulltextItemsTotal).toBe(250);
    expect(final.items).toBe(250);
    expect(final.libraryVersion).toBe(77);
    expect((await search.query('recurrent gate ablation', { limit: 1 }))[0]!.source).toBe('fulltext');
  });

  it('reaches the items whose metadata was committed before the interruption', async () => {
    // The interruption falls in the metadata pass, so the full-text worklist the second run
    // needs covers items its own crawl never sees. It rebuilds that list from the store.
    const library30 = items(30);
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await search.buildIncremental(
      async (start) => {
        if (start >= 10) search.requestStop();
        return { items: library30.slice(start, start + 10), totalResults: 30 };
      },
      { fulltextFor: async () => BODY },
    );
    expect(search.buildStatus().items).toBe(10);
    expect(search.buildStatus().fulltextItems).toBe(0);

    const asked: string[] = [];
    const final = await search.buildIncremental(
      async (start) => ({ items: library30.slice(start, start + 10), totalResults: 30 }),
      {
        fulltextFor: async (key) => {
          asked.push(key);
          return BODY;
        },
      },
    );
    expect(asked.sort()).toEqual(library30.map((i) => i.key).sort());
    expect(final.fulltextItems).toBe(30);
  });
});

describe('an index written before checkpoints existed', () => {
  it('loads, reports nothing to resume, and rebuilds from the top', async () => {
    const lib = library(3);
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    // The v1.9.0 artifact shape: rows and a stamp, no checkpoint and no full-text cursor.
    search.loadFromJSON({
      chunks: [{ id: 'A#0', itemKey: 'A', title: 'Old', text: 'an older index' }],
      vectors: [],
      builtFromVersion: 1,
      libraryVersion: 5,
      libraryBackend: 'cloud',
    } as IndexSnapshot);
    expect(search.buildStatus().libraryVersion).toBe(5);
    expect(search.buildStatus().fulltextVersion).toBe(0);

    const router = lib.router();
    startIndexBuild(makeCtx(search, router));
    await settle(search);
    expect(search.buildStatus().resumedFrom).toBeUndefined();
    expect(router.searchItems.mock.calls[0]![0]).toMatchObject({ start: 0 });
    expect(search.buildStatus().items).toBe(3);
    // And an update off that old index is still the cheap delta it always was.
    expect(startIndexUpdate(makeCtx(search, lib.router())).operation).toBe('update');
    await settle(search);
  });
});
