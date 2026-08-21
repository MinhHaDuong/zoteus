import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { MemoryPassageStore } from '../../src/features/search/passage-store.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';
import { SqliteSearchIndex, defaultSearchDbPath } from '../../src/features/search/sqlite-index.js';
import { startIndexBuild } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract body number ${i}` },
  }));
}

function pager(library: any[], pageSize = 100) {
  return async (start: number) => ({ items: library.slice(start, start + pageSize), totalResults: library.length });
}

function tmpDbPath(): string {
  return defaultSearchDbPath(mkdtempSync(join(tmpdir(), 'zoteus-batch-')));
}

/**
 * The behaviour this ticket exists for, and the one the JSON backend cannot express: a
 * build that is cancelled part-way leaves what it had already written *durably* written,
 * visible to a connection that was not party to the build.
 *
 * Under the JSON snapshot the equivalent question has no clean answer — `persist` rewrites
 * the whole file, so what survives a stop depends on when the last full write happened to
 * land. Here the unit is the transaction, and the assertion is about a second connection
 * to the same file, which is why the store must be file-backed and not `':memory:'`.
 */
describe('a cancelled build commits what it already indexed', () => {
  it('leaves its rows queryable from a fresh connection to the same file', async () => {
    const dbPath = tmpDbPath();
    // An embedder that stalls until released, so the stop lands mid-build rather than
    // racing the (very fast) keyword indexing to the end of the library.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stalling: EmbeddingProvider = {
      name: 'stalling',
      embed: vi.fn(async (texts: string[]) => {
        await gate;
        return texts.map(() => [1, 0, 0]);
      }),
    };
    const store = new Fts5PassageStore(dbPath);
    const search = new SearchIndex({ embedder: stalling, logger: silentLogger, store });

    const job = search.buildIncremental(pager(makeLibrary(400), 50));
    for (let i = 0; i < 500 && search.buildStatus().itemsFetched === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(search.requestStop()).toBe(true);
    release();
    const final = await job;
    expect(final.items).toBeGreaterThan(0);
    expect(final.items).toBeLessThan(400);

    // The build's own connection still answers — but that proves only that the rows are in
    // its uncommitted transaction. The second connection is the whole test.
    const reopened = new Fts5PassageStore(dbPath);
    expect(reopened.size).toBe(final.passages);
    expect(reopened.search('abstract body', 5).length).toBeGreaterThan(0);
    reopened.close();
    store.close();
  });

  it('leaves its rows queryable after the error path too', async () => {
    const dbPath = tmpDbPath();
    const store = new Fts5PassageStore(dbPath);
    const search = new SearchIndex({ embedder: null, logger: silentLogger, store });
    const fetchPage = vi.fn(async (start: number) => {
      if (start === 0) return { items: makeLibrary(10), totalResults: 30 };
      throw new Error('Web API exploded');
    });

    const final = await search.buildIncremental(fetchPage);
    expect(final.state).toBe('error');
    expect(final.items).toBe(10);

    const reopened = new Fts5PassageStore(dbPath);
    expect(reopened.size).toBe(final.passages);
    reopened.close();
    store.close();
  });

  it('makes partial progress visible to a second connection while the build is still running', async () => {
    // The row-store analogue of the JSON backend's "valid partial snapshot mid-build"
    // test, and what pins the *periodic* commit rather than the one on the way out: with
    // a single transaction spanning the whole build, a concurrent reader would see nothing
    // until the last item landed.
    const dbPath = tmpDbPath();
    const slow: EmbeddingProvider = {
      name: 'slow',
      embed: async (texts: string[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return texts.map(() => [1, 0, 0]);
      },
    };
    const store = new Fts5PassageStore(dbPath);
    const search = new SearchIndex({ embedder: slow, logger: silentLogger, store });
    const job = search.buildIncremental(pager(makeLibrary(120), 10), { persistEveryItems: 10, persistEveryMs: 0 });

    let sawPartial = false;
    while (search.isBuilding) {
      const reader = new Fts5PassageStore(dbPath);
      const n = reader.size;
      reader.close();
      if (n > 0 && n < 120) sawPartial = true;
      await new Promise((r) => setTimeout(r, 2));
    }
    const final = await job;
    expect(sawPartial).toBe(true);
    expect(final.passages).toBe(120);
    store.close();
  });

  it('closes the trailing transaction, so a write after the build is not swallowed', async () => {
    // persistNow always opens the NEXT batch, including the last time it runs. Left open,
    // that transaction quietly absorbs everything written after the build returns — a
    // direct store.add, a later delta pass — and a second connection sees none of it. The
    // commit on the way out is what closes it.
    const dbPath = tmpDbPath();
    const store = new Fts5PassageStore(dbPath);
    const search = new SearchIndex({ embedder: null, logger: silentLogger, store });
    await search.buildIncremental(pager(makeLibrary(5)));

    store.add({ id: 'Z#0', itemKey: 'Z', title: 'Late', text: 'a passage written after the build finished' });
    const reopened = new Fts5PassageStore(dbPath);
    expect(reopened.get('Z#0')).toBeDefined();
    reopened.close();
    store.close();
  });

  it('leaves its rows queryable after a normal completion', async () => {
    const dbPath = tmpDbPath();
    const store = new Fts5PassageStore(dbPath);
    const search = new SearchIndex({ embedder: null, logger: silentLogger, store });
    const final = await search.buildIncremental(pager(makeLibrary(30)));
    expect(final.state).toBe('done');

    const reopened = new Fts5PassageStore(dbPath);
    expect(reopened.size).toBe(final.passages);
    expect(reopened.size).toBeGreaterThan(0);
    reopened.close();
    store.close();
  });
});

describe('PassageStore batch boundaries', () => {
  it('are no-ops on the memory store, which is what leaves the default path untouched', () => {
    const store = new MemoryPassageStore();
    store.beginBatch();
    store.add({ id: 'A#0', itemKey: 'A', title: 'Gardening', text: 'growing tomatoes and herbs' });
    store.commitBatch();
    // Committed or not is not a question a Map can answer: the passage is simply there,
    // before and after, exactly as it was before batches existed.
    expect(store.size).toBe(1);
    expect(store.search('tomatoes', 3)[0]!.id).toBe('A#0');
    // And repeating either call changes nothing.
    store.commitBatch();
    store.beginBatch();
    store.beginBatch();
    expect(store.size).toBe(1);
  });

  it('tolerate a commit with no transaction open on the FTS5 store', () => {
    const store = new Fts5PassageStore(':memory:');
    // SQLite raises "cannot commit - no transaction is active" on a bare COMMIT, so this
    // is the store's own bookkeeping being asserted, not SQLite's tolerance.
    expect(() => store.commitBatch()).not.toThrow();
    store.beginBatch();
    store.commitBatch();
    expect(() => store.commitBatch()).not.toThrow();
    // A second BEGIN inside an open transaction is likewise an error; beginBatch absorbs it.
    store.beginBatch();
    expect(() => store.beginBatch()).not.toThrow();
    store.commitBatch();
    store.close();
  });
});

describe('SqliteSearchIndex and the JSON snapshot interface', () => {
  it('refuses toJSON rather than returning a snapshot that would overwrite a good file', () => {
    const idx = new SqliteSearchIndex({ embedder: null, dbPath: ':memory:' });
    expect(() => idx.toJSON()).toThrow(/sqlite/i);
    expect(() => idx.toJSON()).toThrow(/ZOTEUS_SEARCH_BACKEND/);
  });

  it('refuses loadFromJSON, naming the backend', () => {
    const idx = new SqliteSearchIndex({ embedder: null, dbPath: ':memory:' });
    expect(() => idx.loadFromJSON({ chunks: [], vectors: [], builtFromVersion: 0 })).toThrow(/sqlite/i);
  });
});

describe('the SQLite backend writes no JSON snapshot', () => {
  it('builds through startIndexBuild with no persist callback and leaves the data dir json-free', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-nojson-'));
    const search = new SqliteSearchIndex({
      embedder: null,
      logger: silentLogger,
      dbPath: defaultSearchDbPath(dataDir),
    });
    // Shaped like the real context, minus everything startIndexBuild does not touch. The
    // load-bearing field is `searchIndexPath: undefined` — server.ts's switch. Were a
    // persist callback built anyway, saveIndex would call the refusing toJSON() above and
    // the build would log its way to a JSON-shaped absence instead of failing here.
    const ctx: any = {
      config: loadConfig({ ZOTEUS_SEARCH_BACKEND: 'sqlite' } as unknown as NodeJS.ProcessEnv),
      router: {
        searchItems: async (q: { start?: number }) => ({ data: makeLibrary(20).slice(q.start ?? 0), totalResults: 20 }),
        // The build records which client served it, beside the library version.
        backendFor: () => 'local' as const,
      },
      search,
      searchIndexPath: undefined,
      logger: silentLogger,
    };

    startIndexBuild(ctx);
    for (let i = 0; i < 500 && search.buildStatus().state === 'building'; i++) await new Promise((r) => setTimeout(r, 2));
    expect(search.buildStatus().state).toBe('done');
    expect(search.status().items).toBe(20);

    expect(readdirSync(dataDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    // And the rows really are on disk, not merely in the build's own connection.
    const reopened = new Fts5PassageStore(defaultSearchDbPath(dataDir));
    expect(reopened.size).toBe(search.status().documents);
    reopened.close();
  });
});
