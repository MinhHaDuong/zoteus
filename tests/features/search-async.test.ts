import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import {
  FakeEmbeddingProvider,
  LocalEmbeddingProvider,
} from '../../src/features/search/embeddings.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import { saveIndex, loadIndex } from '../../src/features/search/persistence.js';
import { INCUMBENT_LOCAL_ENTRY } from '../../src/features/search/embedder-registry.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: {
      itemType: 'journalArticle',
      title: `Item ${i}`,
      abstractNote: `abstract body number ${i}`,
    },
  }));
}

function pager(library: any[], pageSize = 100) {
  return async (start: number) => ({
    items: library.slice(start, start + pageSize),
    totalResults: library.length,
  });
}

function tmpIndexFile(): string {
  return join(
    tmpdir(),
    `zoteus-search-async-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
  );
}

describe('SearchIndex.buildIncremental', () => {
  it('completes and reports live progress state transitions', async () => {
    const search = new MemorySearchIndex({
      embedder: new FakeEmbeddingProvider(),
      logger: silentLogger,
    });
    expect(search.buildStatus().state).toBe('idle');
    const job = search.buildIncremental(pager(makeLibrary(30)), { maxItems: 30 });
    expect(search.isBuilding).toBe(true);
    const final = await job;
    expect(final.state).toBe('done');
    expect(final.items).toBe(30);
    expect(final.itemsFetched).toBe(30);
    expect(final.itemsTotal).toBe(30);
    expect(final.vectors).toBeGreaterThan(0);
    expect(search.isBuilding).toBe(false);
    // still queryable
    const hits = await search.query('abstract body', { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('rejects a concurrent build', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const lib = makeLibrary(50);
    const j1 = search.buildIncremental(pager(lib));
    await expect(search.buildIncremental(pager(lib))).rejects.toThrow(/already in progress/i);
    await j1;
  });

  it('records state=error with lastError when fetching fails, keeping partial data', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const fetchPage = vi.fn(async (start: number) => {
      if (start === 0) return { items: makeLibrary(10), totalResults: 30 };
      throw new Error('Web API exploded');
    });
    const final = await search.buildIncremental(fetchPage);
    expect(final.state).toBe('error');
    expect(final.lastError).toMatch(/exploded/i);
    expect(final.items).toBe(10); // partial data kept and queryable
    const hits = await search.query('abstract', { limit: 1 });
    expect(hits.length).toBe(1);
  });

  it('requestStop halts between pages and keeps the partial index', async () => {
    // Embedder that stalls until released so we can stop deterministically mid-build.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stalling: EmbeddingProvider = {
      name: 'stalling',
      embed: vi.fn(async (texts: string[]) => {
        await gate;
        return texts.map(() => [1, 0, 0]);
      }),
    };
    const search = new MemorySearchIndex({ embedder: stalling, logger: silentLogger });
    const job = search.buildIncremental(pager(makeLibrary(400), 50));
    // Wait until we're mid-build (first page fetched, stalled in embedding).
    for (let i = 0; i < 500 && search.buildStatus().itemsFetched === 0; i++)
      await new Promise((r) => setTimeout(r, 2));
    expect(search.isBuilding).toBe(true);
    expect(search.requestStop()).toBe(true);
    release();
    const final = await job;
    expect(final.state).toBe('done');
    expect(final.items).toBeGreaterThan(0);
    expect(final.items).toBeLessThan(400);
    // stop after the fact is a no-op
    expect(search.requestStop()).toBe(false);
  });
});

describe('incremental atomic persistence', () => {
  it('never leaves a corrupt index file mid-build and stays loadable', async () => {
    const library = makeLibrary(120);
    // Slow embedder so the build spans many event-loop turns while persisting every item.
    const slow: EmbeddingProvider = {
      name: 'slow',
      embed: async (texts: string[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return texts.map((_, i) => [i % 2, 1, 0]);
      },
    };
    const search = new MemorySearchIndex({ embedder: slow, logger: silentLogger });
    const file = tmpIndexFile();
    const job = search.buildIncremental(pager(library, 10), {
      persistEveryItems: 1,
      persistEveryMs: 0,
      persist: () => saveIndex(search, file),
    });
    let sawValidPartial = false;
    while (search.isBuilding) {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8')); // must NEVER throw mid-build
        expect(Array.isArray(parsed.chunks)).toBe(true);
        expect(Array.isArray(parsed.vectors)).toBe(true);
        if (parsed.chunks.length > 0 && parsed.chunks.length < library.length)
          sawValidPartial = true;
        // a concurrent reader could even query this snapshot
        const partial = new MemorySearchIndex({ embedder: null });
        partial.loadFromJSON(parsed);
        expect(partial.status().items).toBeGreaterThan(0);
      } catch (e: any) {
        if (e?.code !== 'ENOENT')
          throw new Error(`index file was corrupt mid-build: ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    await job;
    expect(sawValidPartial).toBe(true); // we observed at least one valid partial snapshot
    const final = JSON.parse(await readFile(file, 'utf8'));
    expect(final.chunks.length).toBeGreaterThanOrEqual(library.length);
  });

  it('a partial (stopped) index loads on next startup and is queryable', async () => {
    const library = makeLibrary(300);
    const gate = { release: () => {} };
    let paused!: () => void;
    const stall = new Promise<void>((r) => (paused = r));
    gate.release = () => paused();
    const stalling: EmbeddingProvider = {
      name: 'stalling',
      embed: vi.fn(async (texts: string[]) => {
        await stall;
        return texts.map(() => [0.5, 0.5]);
      }),
    };
    const search = new MemorySearchIndex({ embedder: stalling, logger: silentLogger });
    const file = tmpIndexFile();
    const job = search.buildIncremental(pager(library, 50), {
      persistEveryItems: 10,
      persistEveryMs: 0,
      persist: () => saveIndex(search, file),
    });
    for (let i = 0; i < 500 && search.buildStatus().itemsFetched < 50; i++)
      await new Promise((r) => setTimeout(r, 2));
    search.requestStop();
    gate.release();
    const stopped = await job;
    expect(stopped.items).toBeLessThan(300);
    // "Next startup": a brand-new index loads the persisted partial snapshot.
    const reborn = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    expect(await loadIndex(reborn, file)).toBe(true);
    expect(reborn.status().items).toBeGreaterThan(0);
    expect(reborn.status().items).toBeLessThan(300);
    const hits = await reborn.query('abstract body', { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('LocalEmbeddingProvider batching (fake extractor)', () => {
  it('passes batches to the pipeline and returns one vector per text', async () => {
    const calls: string[][] = [];
    const dim = 8;
    const fakeExtractor = async (input: string | string[]) => {
      const batch = Array.isArray(input) ? input : [input];
      calls.push(batch);
      const data = new Float32Array(batch.length * dim);
      for (let b = 0; b < batch.length; b++)
        for (let d = 0; d < dim; d++) data[b * dim + d] = b + 1 + d * 0.01;
      return { data, dims: [batch.length, dim] };
    };
    (fakeExtractor as any).tokenizer = { model_max_length: 512 };
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, model: 'test-model', dimension: dim },
      async () => fakeExtractor,
    );
    const texts = Array.from({ length: 70 }, (_, i) => `passage ${i}`);
    const vecs = await provider.embed(texts);
    expect(vecs).toHaveLength(70); // same count in, same count out
    expect(vecs[0]).toHaveLength(dim);
    expect(calls).toHaveLength(Math.ceil(70 / LocalEmbeddingProvider.BATCH_SIZE)); // 32+32+6
    expect(calls[0]).toHaveLength(LocalEmbeddingProvider.BATCH_SIZE);
    // vectors keep batch order: value encodes the position within its batch (b + 1)
    expect(vecs[0][0]).toBeCloseTo(1); // first batch, slot 0
    expect(vecs[31][0]).toBeCloseTo(32); // first batch, slot 31
    expect(vecs[32][0]).toBeCloseTo(1); // second batch restarts at slot 0
    expect(vecs[69][0]).toBeCloseTo(6); // third batch (6 texts), last slot
  });

  it('handles an empty input without loading the model', async () => {
    const load = vi.fn(async () => {
      throw new Error('should not be called');
    });
    const provider = new LocalEmbeddingProvider(
      { ...INCUMBENT_LOCAL_ENTRY, model: 'test-model', dimension: 8 },
      load,
    );
    expect(await provider.embed([])).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe('embedding failure falls back to keyword-only', () => {
  it('completes the build with vectors=0 when the embedder throws', async () => {
    const broken: EmbeddingProvider = {
      name: 'broken',
      embed: async () => {
        throw new Error('model download failed');
      },
    };
    const search = new MemorySearchIndex({ embedder: broken, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(20), 10));
    expect(final.state).toBe('done');
    expect(final.vectors).toBe(0);
    expect(final.items).toBe(20);
    const hits = await search.query('abstract', { limit: 1 });
    expect(hits.length).toBe(1);
  });
});
