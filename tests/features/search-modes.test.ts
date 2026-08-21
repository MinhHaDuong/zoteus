import { describe, it, expect } from 'vitest';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { embedderNotice, statusSummary, vectorStorageNotice } from '../../src/features/search/build.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import { STORES } from './stores.js';

/**
 * Two items with no vocabulary in common, and an embedder rigged to DISAGREE with the
 * keyword index about which of them a query means.
 *
 * The disagreement is the whole design. With an honest embedder the two halves of the
 * hybrid agree on this corpus, and every mode returns the same item — so a suite built on
 * one would pass with the modes wired to each other's code paths. Here each mode has an
 * answer only it can give: keyword says A, semantic says B, auto says both.
 */
const ITEMS = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Zebra crossing', abstractNote: 'zebra' } },
  { key: 'B', data: { itemType: 'book', title: 'Quokka island', abstractNote: 'quokka' } },
];

class ContraryEmbedder implements EmbeddingProvider {
  readonly name = 'contrary';
  async embed(texts: string[]): Promise<number[][]> {
    // Passages are recognised by a word the query does not carry; anything else IS the
    // query, and is deliberately placed next to B.
    return texts.map((t) => (t.includes('crossing') ? [1, 0] : [0, 1]));
  }
}

describe.each(STORES)('query modes [%s]', (_name, makeStore) => {
  async function built() {
    const idx = new SearchIndex({ embedder: new ContraryEmbedder(), store: makeStore() });
    await idx.build(ITEMS);
    expect(idx.status().vectors).toBe(2);
    return idx;
  }

  it('keyword mode answers from BM25 alone', async () => {
    const hits = await (await built()).query('zebra', { limit: 5, mode: 'keyword' });
    expect(hits.map((h) => h.itemKey)).toEqual(['A']);
  });

  it('semantic mode answers from the vectors alone', async () => {
    // 'zebra' matches A lexically and nothing else, so B can only be reached through the
    // vector side. If mode:"semantic" ever quietly consulted the keyword index, or the
    // vector list came back reversed, this returns A.
    const hits = await (await built()).query('zebra', { limit: 5, mode: 'semantic' });
    expect(hits.map((h) => h.itemKey)).toEqual(['B']);
  });

  it('auto mode fuses both lists', async () => {
    const hits = await (await built()).query('zebra', { limit: 5, mode: 'auto' });
    expect(hits.map((h) => h.itemKey).sort()).toEqual(['A', 'B']);
  });

  it('auto is the default', async () => {
    const idx = await built();
    expect((await idx.query('zebra', { limit: 5 })).map((h) => h.itemKey).sort()).toEqual(['A', 'B']);
  });

  it('keyword mode still answers when the index holds no vectors at all', async () => {
    const idx = new SearchIndex({ embedder: null, store: makeStore() });
    await idx.build(ITEMS);
    expect(idx.hasVectors).toBe(false);
    expect((await idx.query('quokka', { limit: 5, mode: 'keyword' })).map((h) => h.itemKey)).toEqual(['B']);
    // Semantic mode has nothing to rank with; the tool layer refuses this case up front
    // (see semantic-search.ts), and the index itself simply returns nothing.
    expect(await idx.query('quokka', { limit: 5, mode: 'semantic' })).toEqual([]);
  });
});

/**
 * The other end of the pipe from `embedder-degradation.test.ts`: there the embedder cannot
 * produce vectors, here it produces them happily and the STORE cannot hold them. The two
 * are reported through different channels on purpose — a user told to reinstall their
 * embedder because sqlite-vec is missing goes and fixes the wrong thing.
 */
describe('SQLite backend with sqlite-vec unavailable', () => {
  function denied() {
    return new Fts5PassageStore(':memory:', {
      loadVec: () => {
        throw new Error("Cannot find module 'sqlite-vec'");
      },
    });
  }

  it('finishes the build, keeps keyword search, and names the cause', async () => {
    const warned: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: unknown) => warned.push(String(m)), error() {} } as any;
    const idx = new SearchIndex({ embedder: new FakeEmbeddingProvider(), store: denied(), logger });
    const status = await idx.build(ITEMS);

    expect(status.documents).toBe(2);
    expect(status.vectors).toBe(0);
    expect(idx.hasVectors).toBe(false);
    // The embedder is fine. Saying otherwise here is the misdiagnosis this split prevents.
    expect(status.embedderActive).toBe(true);
    expect(status.embedderReason).toBeUndefined();
    expect(status.vectorReason).toMatch(/sqlite-vec could not be loaded/);
    expect(idx.vectorStorageReason).toBe(status.vectorReason);
    // Announced once at construction rather than discovered hours into a build.
    expect(warned.some((m) => m.includes('sqlite-vec could not be loaded'))).toBe(true);

    expect((await idx.query('quokka', { limit: 5 })).map((h) => h.itemKey)).toEqual(['B']);
  });

  it('surfaces the reason in the status line, on its own channel', async () => {
    const idx = new SearchIndex({ embedder: new FakeEmbeddingProvider(), store: denied() });
    await idx.build(ITEMS);
    const s = idx.buildStatus();
    expect(embedderNotice(s)).toBe('');
    expect(vectorStorageNotice(s)).toContain('Vectors are not being stored');
    expect(statusSummary(s)).toContain('sqlite-vec');
  });

  it('says nothing at all when the extension loads', async () => {
    const idx = new SearchIndex({ embedder: new FakeEmbeddingProvider(), store: new Fts5PassageStore(':memory:') });
    await idx.build(ITEMS);
    const s = idx.buildStatus();
    expect(s.vectorReason).toBeUndefined();
    expect(vectorStorageNotice(s)).toBe('');
    expect(s.vectors).toBe(2);
  });
});
