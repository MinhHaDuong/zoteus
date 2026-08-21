import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSearchIndex, defaultSearchDbPath } from '../../src/features/search/sqlite-index.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';

const items = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Deep learning', abstractNote: 'convolutional neural networks' } },
  { key: 'B', data: { itemType: 'book', title: 'Organic gardening', abstractNote: 'growing tomatoes and herbs' } },
];

describe('SqliteSearchIndex', () => {
  it('builds into a real database file and answers from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-sqlite-index-'));
    const dbPath = defaultSearchDbPath(dir);
    const idx = new SqliteSearchIndex({ embedder: null, dbPath });

    const status = await idx.build(items, { version: 7 });
    expect(status.items).toBe(2);
    expect(status.documents).toBe(2);
    expect(status.builtFromVersion).toBe(7);
    expect(existsSync(dbPath)).toBe(true);

    const hits = await idx.query('tomatoes', { limit: 2 });
    expect(hits[0]!.itemKey).toBe('B');
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });

  it('sits beside search-index.json rather than replacing it', () => {
    expect(defaultSearchDbPath('/data')).toBe('/data/search-index.sqlite');
    expect(defaultSearchDbPath('/data', 42)).toBe('/data/search-index-42.sqlite');
  });

  it('rebuilds in place instead of dropping the injected store', async () => {
    // reset() clears the store rather than reassigning one. Were that wrong, the second
    // build would silently write into a fresh in-memory store and the file would keep the
    // first build's rows.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-sqlite-index-'));
    const dbPath = defaultSearchDbPath(dir);
    const idx = new SqliteSearchIndex({ embedder: null, dbPath });
    await idx.build(items);
    await idx.build([items[0]!]);
    expect(idx.status().documents).toBe(1);
    expect(await idx.query('tomatoes', { limit: 2 })).toEqual([]);

    const reopened = new SqliteSearchIndex({ embedder: null, dbPath });
    expect(reopened.status().documents).toBe(1);
    expect((await reopened.query('neural networks', { limit: 2 }))[0]!.itemKey).toBe('A');
  });

  it('keeps its vectors in the file, so a reopened index can still rank semantically', async () => {
    // The production shape of the vector round trip: a real file, a second process's worth
    // of connection, and no rebuild. The JSON backend cannot do this at all on a library
    // of any size — reloading its snapshot is the out-of-memory condition (#10).
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-sqlite-index-'));
    const dbPath = defaultSearchDbPath(dir);
    const idx = new SqliteSearchIndex({ embedder: new FakeEmbeddingProvider(), dbPath });
    const status = await idx.build(items);
    expect(status.vectors).toBe(2);
    expect(status.vectorReason).toBeUndefined();

    const reopened = new SqliteSearchIndex({ embedder: new FakeEmbeddingProvider(), dbPath });
    expect(reopened.status().vectors).toBe(2);
    expect(reopened.hasVectors).toBe(true);
    // mode:"semantic" ranks by vectors alone, so this answers only if they survived.
    const hits = await reopened.query('growing tomatoes and herbs', { limit: 1, mode: 'semantic' });
    expect(hits[0]!.itemKey).toBe('B');
  });

  it('refuses the JSON snapshot, vectors included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-sqlite-index-'));
    const idx = new SqliteSearchIndex({ embedder: null, dbPath: defaultSearchDbPath(dir) });
    await idx.build(items);
    expect(() => idx.toJSON()).toThrow(/the database is the index/);
  });
});
