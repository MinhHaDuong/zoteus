import { describe, it, expect } from 'vitest';
import { BM25Index } from '../../src/features/search/bm25.js';
import { VectorStore } from '../../src/features/search/vector-store.js';
import { chunkText } from '../../src/features/search/chunker.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { SearchIndex } from '../../src/features/search/index-manager.js';

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

describe('SearchIndex (hybrid with fake embedder)', () => {
  it('builds and returns item-cited hits', async () => {
    const idx = new SearchIndex({ embedder: new FakeEmbeddingProvider() });
    const status = await idx.build(items, { version: 3 });
    expect(status.items).toBe(3);
    expect(status.vectors).toBeGreaterThan(0);
    const hits = await idx.query('neural networks', { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(['A', 'C']).toContain(hits[0].itemKey);
    expect(hits[0].snippet.length).toBeGreaterThan(0);
  });

  it('works keyword-only when there is no embedder', async () => {
    const idx = new SearchIndex({ embedder: null });
    await idx.build(items);
    expect(idx.status().vectors).toBe(0);
    const hits = await idx.query('tomatoes', { limit: 3 });
    expect(hits[0]?.itemKey).toBe('B');
  });

  it('persists and reloads', async () => {
    const a = new SearchIndex({ embedder: new FakeEmbeddingProvider() });
    await a.build(items);
    const b = new SearchIndex({ embedder: new FakeEmbeddingProvider() });
    b.loadFromJSON(a.toJSON());
    expect(b.status().items).toBe(3);
    const hits = await b.query('gardening', { limit: 1 });
    expect(hits[0].itemKey).toBe('B');
  });
});
