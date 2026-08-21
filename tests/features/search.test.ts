import { describe, it, expect } from 'vitest';
import { BM25Index } from '../../src/features/search/bm25.js';
import { VectorStore } from '../../src/features/search/vector-store.js';
import { chunkText, chunkWithOffsets } from '../../src/features/search/chunker.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { STORES } from './stores.js';

describe('BM25Index', () => {
  it('ranks the most relevant document first', () => {
    const idx = new BM25Index();
    idx.addDoc('A', 'deep learning neural networks for computer vision');
    idx.addDoc('B', 'gardening tips for tomato plants in summer');
    idx.addDoc('C', 'reinforcement learning and neural network policies');
    const hits = idx.search('neural networks', 3);
    expect(hits[0].id === 'A' || hits[0].id === 'C').toBe(true);
    expect(hits.some((h) => h.id === 'B')).toBe(false);
  });
});

describe('VectorStore', () => {
  it('finds the nearest vector and round-trips JSON', () => {
    const vs = new VectorStore();
    vs.add('x', [1, 0, 0]);
    vs.add('y', [0, 1, 0]);
    const hits = vs.search([0.9, 0.1, 0], 1);
    expect(hits[0].id).toBe('x');
    const restored = VectorStore.fromJSON(vs.toJSON());
    expect(restored.size).toBe(2);
  });
});

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toHaveLength(1);
  });
  it('splits long text into overlapping chunks', () => {
    const chunks = chunkText('word '.repeat(400), 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

const items = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Deep learning for computer vision', abstractNote: 'convolutional neural networks classify images', tags: [{ tag: 'cv' }] } },
  { key: 'B', data: { itemType: 'book', title: 'Organic gardening', abstractNote: 'growing tomatoes and herbs', tags: [{ tag: 'garden' }] } },
  { key: 'C', data: { itemType: 'journalArticle', title: 'Reinforcement learning', abstractNote: 'reward shaping for neural network policies', tags: [{ tag: 'rl' }] } },
];

// Upstream's own assertions, run against every passage backend: the FTS5 store has to
// satisfy the definition of search this project already committed to, not a friendlier one.
describe.each(STORES)('SearchIndex (hybrid with fake embedder) [%s]', (_name, makeStore) => {
  it('builds and returns item-cited hits', async () => {
    const idx = new SearchIndex({ embedder: new FakeEmbeddingProvider(), store: makeStore() });
    const status = await idx.build(items, { version: 3 });
    expect(status.items).toBe(3);
    expect(status.vectors).toBeGreaterThan(0);
    const hits = await idx.query('neural networks', { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(['A', 'C']).toContain(hits[0].itemKey);
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  it('works keyword-only when there is no embedder', async () => {
    const idx = new SearchIndex({ embedder: null, store: makeStore() });
    await idx.build(items);
    expect(idx.status().vectors).toBe(0);
    const hits = await idx.query('tomatoes', { limit: 3 });
    expect(hits[0]?.itemKey).toBe('B');
  });

  it('persists and reloads', async () => {
    const a = new SearchIndex({ embedder: new FakeEmbeddingProvider(), store: makeStore() });
    await a.build(items);
    const b = new SearchIndex({ embedder: new FakeEmbeddingProvider(), store: makeStore() });
    b.loadFromJSON(a.toJSON());
    expect(b.status().items).toBe(3);
    const hits = await b.query('gardening', { limit: 1 });
    expect(hits[0].itemKey).toBe('B');
  });
});

describe('chunkWithOffsets', () => {
  const doc = 'Alpha beta gamma. '.repeat(120); // ~2160 chars

  it('returns offsets that slice back to the chunk text', () => {
    const chunks = chunkWithOffsets(doc, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(doc.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it('never begins a chunk mid-word', () => {
    const chunks = chunkWithOffsets(doc, 200, 40);
    for (const c of chunks) {
      if (c.start > 0) expect(/\s/.test(doc[c.start - 1] ?? ' ')).toBe(true);
    }
  });

  it('returns one chunk for short text with correct offsets', () => {
    const chunks = chunkWithOffsets('hello world');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, text: 'hello world', start: 0, end: 11 });
  });

  it('covers the whole source with no gaps even for a token longer than a chunk', () => {
    const doc = 'x'.repeat(2000); // one 2000-char unbreakable token, size 800
    const chunks = chunkWithOffsets(doc, 800, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // sorted by start, each next chunk starts at or before the previous chunk's end → no gap
    const sorted = [...chunks].sort((a, b) => a.start - b.start);
    expect(sorted[0].start).toBe(0);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeLessThanOrEqual(sorted[i - 1].end);
    }
    expect(sorted[sorted.length - 1].end).toBe(2000);
    for (const c of chunks) expect(doc.slice(c.start, c.end)).toBe(c.text);
  });
});

describe('SearchIndex embedder passthrough', () => {
  it('exposes hasEmbedder and embed for ad-hoc ranking', async () => {
    const withEmb = new SearchIndex({ embedder: new FakeEmbeddingProvider() });
    expect(withEmb.hasEmbedder).toBe(true);
    const vecs = await withEmb.embed(['a', 'b']);
    expect(vecs).toHaveLength(2);
    const none = new SearchIndex({ embedder: null });
    expect(none.hasEmbedder).toBe(false);
    expect(await none.embed(['a'])).toEqual([]);
  });
});

describe.each(STORES)('snippet quality (W5) [%s]', (_name, makeStore) => {
  it('centres the snippet on the query and does not start mid-word', async () => {
    const longAbstract = 'padding '.repeat(80) + 'the Gauss Newton Hessian decomposition matters here ' + 'tail '.repeat(80);
    const idx = new SearchIndex({ embedder: null, store: makeStore() });
    await idx.build([{ key: 'Z', data: { itemType: 'journalArticle', title: 'Opt', abstractNote: longAbstract } }]);
    const hits = await idx.query('Hessian decomposition', { limit: 1 });
    expect(hits[0].snippet.toLowerCase()).toContain('hessian');
    // first visible word (after any leading ellipsis) is a whole word
    const firstWord = hits[0].snippet.replace(/^…\s*/, '').split(' ')[0];
    expect(firstWord.length).toBeGreaterThan(1);
  });
});
