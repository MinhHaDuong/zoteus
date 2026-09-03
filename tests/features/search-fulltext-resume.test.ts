import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { statusSummary } from '../../src/features/search/build.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';

/**
 * Six consecutive full-text builds of a 10k-item library died on a single OpenAI 429, and
 * every one of them re-embedded the whole full-text pass from scratch (#48). Two separate
 * faults produced that: the build swallowed the provider failure, carried on writing
 * passages BM25-only, reported `done` and DELETED its own checkpoint; and even with a
 * checkpoint, nothing ever came back for passages that were committed without a vector,
 * because the crawl steps over their items by key and the full-text pass steps over them
 * with `hasFulltext`: they are indexed, just not embedded.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

const BODY =
  'The ablation removes the recurrent gate entirely. '.repeat(20) +
  'Throughput on the benchmark rises by eleven percent under mixed precision. '.repeat(20);

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));
}

function pager(library: any[], pageSize = 100) {
  return async (start: number) => ({
    items: library.slice(start, start + pageSize),
    totalResults: library.length,
    lastModifiedVersion: 77,
  });
}

/**
 * An embedder that answers `limit` texts and then behaves like OpenAI under a rate limit
 * that outlasted the retries: every later call throws, exactly as the provider does once
 * its backoff budget is spent.
 */
function rateLimitedEmbedder(limit: number, model = 'text-embedding-3-small') {
  const state = { embedded: 0, calls: 0, texts: [] as string[] };
  const provider: EmbeddingProvider = {
    name: 'openai',
    model,
    embed: async (batch: string[]) => {
      state.calls++;
      if (state.embedded >= limit) throw new Error('OpenAI embeddings failed (429).');
      state.embedded += batch.length;
      state.texts.push(...batch);
      return batch.map((t) => [t.length % 7, 1, 0]);
    },
  };
  return { provider, state };
}

/** A healthy embedder that records every text it was asked for. */
function countingEmbedder(model = 'text-embedding-3-small') {
  const texts: string[] = [];
  const provider: EmbeddingProvider = {
    name: 'openai',
    model,
    embed: async (batch: string[]) => {
      texts.push(...batch);
      return batch.map((t) => [t.length % 7, 1, 0]);
    },
  };
  return { provider, texts };
}

async function openIndex(
  backend: 'memory' | 'sqlite',
  dir: string,
  opts: Partial<SearchIndexOptions> = {},
): Promise<SearchIndex> {
  return createSearchIndex({
    embedder: null,
    logger: silentLogger,
    ...opts,
    backend,
    jsonPath: join(dir, 'search-index.json'),
  });
}

const fulltextOpts = {
  fulltextFor: async () => BODY,
  fulltextKeys: async () => new Set(makeLibrary(40).map((i) => i.key)),
  fulltextVersion: () => 4242,
  persistEveryItemsFulltext: 5,
  persistEveryMsFulltext: 60_000,
};

describe.each(backends)('a full-text build whose embedder gives up (%s backend)', (backend) => {
  it('keeps its checkpoint instead of reporting a finished build with no way back', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-ft-fail-${backend}-`));
    const { provider, state } = rateLimitedEmbedder(20);
    const search = await openIndex(backend, dir, { embedder: provider, configured: 'openai' });

    const final = await search.buildIncremental(pager(makeLibrary(40)), fulltextOpts);

    // The state #48 reports: every item indexed, most passages carrying no vector.
    expect(final.embedderActive).toBe(false);
    expect(final.items).toBe(40);
    expect(final.vectors).toBeGreaterThan(0);
    expect(final.vectors).toBeLessThan(final.documents);
    expect(state.embedded).toBeGreaterThan(0);
    // The three things a resume needs, none of which survived before.
    expect(final.passagesWithoutVectors).toBe(final.documents - final.vectors);
    expect(final.libraryVersion).toBe(0); // no stamp: an update must not call this current
    await search.save();
    const snapshot = await openIndex(backend, dir, { embedder: provider, configured: 'openai' });
    expect(snapshot.buildStatus().passagesWithoutVectors).toBeGreaterThan(0);
    await search.close();
    await snapshot.close();
  });

  it('embeds exactly the orphaned passages on the next build, re-fetching nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-ft-backfill-${backend}-`));
    const first = rateLimitedEmbedder(20);
    const search = await openIndex(backend, dir, { embedder: first.provider, configured: 'openai' });
    const failed = await search.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    const orphans = failed.documents - failed.vectors;
    expect(orphans).toBeGreaterThan(50);
    await search.save();
    await search.close();

    // A new process, a working key, and `action:"build"`, not refresh.
    const second = countingEmbedder();
    const resumed = await openIndex(backend, dir, { embedder: second.provider, configured: 'openai' });
    const bodies: string[] = [];
    const final = await resumed.buildIncremental(pager(makeLibrary(40)), {
      ...fulltextOpts,
      fulltextFor: async (key: string) => {
        bodies.push(key);
        return BODY;
      },
    });

    expect(final.state).toBe('done');
    expect(final.resumedFrom).toBe(40);
    // Every passage embedded, and the second run bought exactly the ones that were missing.
    expect(final.vectors).toBe(final.documents);
    expect(final.documents).toBe(failed.documents);
    expect(second.texts).toHaveLength(orphans);
    // No PDF body was read a second time, and no passage was written twice.
    expect(bodies).toEqual([]);
    expect(final.passagesWithoutVectors).toBeUndefined();
    expect(final.updateNotice).toMatch(new RegExp(`${orphans} passage\\(s\\) the interrupted build committed`));
    // Only now, with the index whole, is the version stamp written.
    expect(final.libraryVersion).toBe(77);
    expect(final.fulltextVersion).toBe(4242);
    await resumed.close();
  });

  it('converges on the index an uninterrupted build would have produced', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-ft-converge-${backend}-`));
    const broken = await openIndex(backend, dir, {
      embedder: rateLimitedEmbedder(20).provider,
      configured: 'openai',
    });
    await broken.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    await broken.save();
    await broken.close();
    const resumed = await openIndex(backend, dir, { embedder: countingEmbedder().provider, configured: 'openai' });
    const a = await resumed.buildIncremental(pager(makeLibrary(40)), fulltextOpts);

    const straightDir = mkdtempSync(join(tmpdir(), `zoteus-ft-straight-${backend}-`));
    const straight = await openIndex(backend, straightDir, {
      embedder: countingEmbedder().provider,
      configured: 'openai',
    });
    const b = await straight.buildIncremental(pager(makeLibrary(40)), fulltextOpts);

    for (const field of ['items', 'documents', 'vectors', 'fulltextItems', 'fulltextPassages'] as const) {
      expect([field, a[field]]).toEqual([field, b[field]]);
    }
    await resumed.close();
    await straight.close();
  });

  it('starts over when the caller asked for a refresh rather than a build', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-ft-refresh-${backend}-`));
    const broken = await openIndex(backend, dir, {
      embedder: rateLimitedEmbedder(20).provider,
      configured: 'openai',
    });
    await broken.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    await broken.save();
    await broken.close();

    const fresh = countingEmbedder();
    const again = await openIndex(backend, dir, { embedder: fresh.provider, configured: 'openai' });
    const final = await again.buildIncremental(pager(makeLibrary(40)), { ...fulltextOpts, fresh: true });

    // `refresh` semantics are untouched: it clears the store and pays for everything again.
    expect(final.resumedFrom).toBeUndefined();
    expect(fresh.texts).toHaveLength(final.documents);
    await again.close();
  });
});

describe('the checkpoint the full-text pass writes', () => {
  it('names the pass it was taken in, so a resume is not mistaken for a metadata one', async () => {
    const search = new MemorySearchIndex({
      embedder: rateLimitedEmbedder(20).provider,
      configured: 'openai',
      logger: silentLogger,
    });
    await search.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    expect(search.toJSON().checkpoint?.phase).toBe('fulltext');
    expect(search.toJSON().checkpoint?.fulltext).toBe(true);
  });

  it('keeps every body passage a persisted round committed, whatever killed the process', async () => {
    // The cadence is what bounds this: an interrupted full-text pass keeps the items whose
    // bodies reached a save, and the resume asks Zotero only for the rest.
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const big = makeLibrary(250);
    const opts = {
      ...fulltextOpts,
      fulltextKeys: async () => new Set(big.map((i) => i.key as string)),
    };
    const read: string[] = [];
    await search.buildIncremental(pager(big), {
      ...opts,
      fulltextFor: async (key: string) => {
        read.push(key);
        if (read.length > 110) search.requestStop();
        return BODY;
      },
    });
    const stopped = search.buildStatus();
    expect(stopped.fulltextItems).toBeGreaterThan(0);
    expect(stopped.fulltextItems).toBeLessThan(250);

    const again: string[] = [];
    const final = await search.buildIncremental(pager(big), {
      ...opts,
      fulltextFor: async (key: string) => {
        again.push(key);
        return BODY;
      },
    });

    expect(final.fulltextItems).toBe(250);
    // Only the items whose body text was never committed were fetched again.
    expect(again).toHaveLength(250 - stopped.fulltextItems);
    expect(again.some((k) => read.slice(0, stopped.fulltextItems).includes(k))).toBe(false);
  });
});

describe('what a half-embedded index says about itself', () => {
  it('reports the shortfall and sends the caller to build, not refresh', async () => {
    const search = new MemorySearchIndex({
      embedder: rateLimitedEmbedder(20).provider,
      configured: 'openai',
      logger: silentLogger,
    });
    const final = await search.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    const summary = statusSummary(final);

    expect(summary).toMatch(/indexed passage\(s\) carry no vector yet/);
    expect(summary).toContain('action:"build"');
    expect(summary).toContain('Do NOT use action:"refresh"');
    expect(summary).toContain('ZOTEUS_EMBED_BATCH_DELAY_MS');
  });

  it('says nothing of the sort when no embedder was ever configured', async () => {
    const search = new MemorySearchIndex({ embedder: null, configured: 'off', logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(5)));
    expect(final.passagesWithoutVectors).toBeUndefined();
    expect(statusSummary(final)).not.toMatch(/carry no vector/);
  });

  it('stays quiet while a healthy build is still draining its queue', async () => {
    const seen: string[] = [];
    const search = new MemorySearchIndex({
      embedder: countingEmbedder().provider,
      configured: 'openai',
      logger: silentLogger,
    });
    await search.buildIncremental(pager(makeLibrary(40)), {
      ...fulltextOpts,
      onProgress: (s) => seen.push(statusSummary(s)),
    });
    expect(seen.some((line) => /carry no vector/.test(line))).toBe(false);
  });

  it('leaves an update to fall back to the resuming build rather than a hollow delta', async () => {
    const search = new MemorySearchIndex({
      embedder: rateLimitedEmbedder(20).provider,
      configured: 'openai',
      logger: silentLogger,
    });
    await search.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    // No stamp was written, so `?since=` is not addressable and the update rebuilds; the
    // rebuild is the resume. A stamp here would have frozen the index half-embedded, since
    // the items missing vectors are unchanged in Zotero and appear in no delta, ever.
    expect(search.updateBlocker('cloud')).toMatch(/RESUMES that one rather than starting over/);
  });
});

describe('a metadata build whose embedder gives up', () => {
  it('is resumable too, and finishes the embedding on the next build', async () => {
    const first = rateLimitedEmbedder(10);
    const search = new MemorySearchIndex({
      embedder: first.provider,
      configured: 'openai',
      logger: silentLogger,
    });
    const failed = await search.buildIncremental(pager(makeLibrary(40), 10), { persistEveryItems: 5 });
    expect(failed.items).toBe(40);
    expect(failed.passagesWithoutVectors).toBe(40 - failed.vectors);

    const second = countingEmbedder();
    const resumed = new MemorySearchIndex({
      embedder: second.provider,
      configured: 'openai',
      logger: silentLogger,
    });
    resumed.loadFromJSON(JSON.parse(JSON.stringify(search.toJSON())));
    const asked: number[] = [];
    const final = await resumed.buildIncremental(async (start) => {
      asked.push(start);
      return { items: makeLibrary(40).slice(start, start + 10), totalResults: 40, lastModifiedVersion: 77 };
    });

    expect(final.vectors).toBe(40);
    expect(second.texts).toHaveLength(40 - failed.vectors);
    // The crawl asked for the one page that confirms the offset, and no more.
    expect(asked).toEqual([40]);
    expect(final.libraryVersion).toBe(77);
  });
});

describe.runIf(hasSqlite)('the SQLite store answers for its own un-embedded rows', () => {
  it('hands them back in insertion order, a page at a time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-ft-page-'));
    const { provider } = rateLimitedEmbedder(0);
    const search = await openIndex('sqlite', dir, { embedder: provider, configured: 'openai' });
    const failed = await search.buildIncremental(pager(makeLibrary(40)), fulltextOpts);
    expect(failed.vectors).toBe(0);

    // Backfilled in pages, so a build that owes 30k vectors never holds 30k texts at once.
    const rounds = vi.fn();
    const done = countingEmbedder();
    const resumed = await openIndex('sqlite', dir, { embedder: done.provider, configured: 'openai' });
    const final = await resumed.buildIncremental(pager(makeLibrary(40)), {
      ...fulltextOpts,
      onProgress: rounds,
    });
    expect(final.vectors).toBe(final.documents);
    expect(done.texts).toHaveLength(failed.documents);
    await search.close();
    await resumed.close();
  });
});
