import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate, statusSummary } from '../../src/features/search/build.js';
import indexTool from '../../src/tools/index-tool.js';
import { loadConfig } from '../../src/config.js';
import type { SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** node:sqlite arrived in Node 22.13; where it is missing those cases skip, as elsewhere. */
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];
const sqliteIt = hasSqlite ? it : it.skip;

/**
 * A Zotero library with a version sequence: every write bumps the library version and
 * stamps the item with it, which is exactly what `?since=` and `?format=versions` read.
 */
class FakeLibrary {
  version = 0;
  private readonly items = new Map<string, { key: string; version: number; data: any }>();

  put(key: string, title: string, abstractNote = ''): void {
    this.version++;
    this.items.set(key, {
      key,
      version: this.version,
      data: { key, itemType: 'journalArticle', title, abstractNote },
    });
  }

  remove(key: string): void {
    this.version++;
    this.items.delete(key);
  }

  get size(): number {
    return this.items.size;
  }

  /** Router double: only the reads the build and update paths make. */
  router(opts: { local?: boolean } = {}) {
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
          lastModifiedVersion: this.version,
        };
      }),
      itemVersions: vi.fn(async (q: any) => {
        const start = q.start ?? 0;
        const page = all().slice(start, start + (q.limit ?? PAGE_SIZE));
        return {
          versions: Object.fromEntries(page.map((it) => [it.key, it.version])),
          totalResults: this.items.size,
          lastModifiedVersion: this.version,
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
  return {
    config: loadConfig(env as any),
    search,
    router,
    logger: silentLogger,
    searchIndexPath: '',
  };
}

/** Both starters return immediately by contract; wait for the background job. */
async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 1000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

describe.each(backends)('the version stamp (%s backend)', (backend) => {
  it('records the library version AND the API that issued it when a build completes', async () => {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    lib.put('B', 'Organic gardening', 'tomatoes and herbs');
    const search = await openIndex(backend);
    const router = lib.router({ local: true });

    startIndexBuild(makeCtx(search, router));
    await settle(search);
    const s = search.buildStatus();

    expect(s.state).toBe('done');
    expect(s.libraryVersion).toBe(lib.version);
    expect(s.libraryBackend).toBe('local');
    // builtFromVersion keeps its old, unrelated meaning: the items the crawl fetched.
    expect(s.builtFromVersion).toBe(2);
    await search.close();
  });

  it('survives a restart, so the next update still has something to diff from', async () => {
    const dir = mkdtempSync(join(tmpdir(), `zoteus-stamp-${backend}-`));
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    const first = await openIndex(backend, {}, dir);
    startIndexBuild(makeCtx(first, lib.router()));
    await settle(first);
    await first.save();
    await first.close();

    const reopened = await openIndex(backend, {}, dir);
    expect(reopened.buildStatus().libraryVersion).toBe(lib.version);
    expect(reopened.buildStatus().libraryBackend).toBe('cloud');
    await reopened.close();
  });

  it('is not stamped by a cancelled build, whose coverage is unknown', async () => {
    const lib = new FakeLibrary();
    for (let i = 0; i < 250; i++) lib.put(`K${i}`, `Item ${i}`, `abstract ${i}`);
    const search = await openIndex(backend);
    // Stopped after the first page: a real prefix of the library is indexed, and it is
    // exactly that partial coverage a stamp would misrepresent as complete.
    await search.buildIncremental(async (start) => {
      const page = await lib.router().searchItems({ start, limit: 100 });
      if (start > 0) search.requestStop();
      return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: page.lastModifiedVersion };
    });

    expect(search.buildStatus().items).toBe(100);
    expect(search.buildStatus().libraryVersion).toBe(0);
    expect(search.updateBlocker('cloud')).toMatch(/no library version stamp/);
    await search.close();
  });
});

describe.each(backends)('incremental update (%s backend)', (backend) => {
  /** A library built once, ready for a delta. */
  async function indexed(embedder?: EmbeddingProvider) {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks classify images');
    lib.put('B', 'Organic gardening', 'growing tomatoes and herbs');
    lib.put('C', 'Reinforcement learning', 'reward shaping for policies');
    const search = await openIndex(backend, embedder ? { embedder } : {});
    const router = lib.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx);
    await settle(search);
    return { lib, search, router, ctx };
  }

  it('fetches only the changed items, and never re-embeds the untouched ones', async () => {
    const embedder = countingEmbedder();
    const { lib, search, router, ctx } = await indexed(embedder.provider);
    const embeddedByBuild = embedder.calls();
    expect(embeddedByBuild).toBeGreaterThan(0);
    router.searchItems.mockClear();

    lib.put('D', 'Photovoltaic perovskites', 'tandem cell stability under illumination');
    const startedAt = search.buildStatus().libraryVersion;
    startIndexUpdate(ctx);
    await settle(search);
    const s = search.buildStatus();

    expect(s.state).toBe('done');
    expect(s.operation).toBe('update');
    expect(s.itemsFetched).toBe(1);
    expect(s.itemsRemoved).toBe(0);
    expect(s.items).toBe(4);
    // The crawl asked for the delta, not the library.
    expect(router.searchItems.mock.calls[0]![0]).toMatchObject({ since: startedAt, top: true });
    // Exactly one passage was embedded: the new item's. A, B and C kept their vectors.
    expect(embedder.calls()).toBe(embeddedByBuild + 1);
    expect(embedder.texts.slice(embeddedByBuild).join(' ')).toMatch(/perovskites/);
    expect(s.vectors).toBe(4);
    expect((await search.query('perovskite tandem', { limit: 1 }))[0]!.itemKey).toBe('D');
    expect((await search.query('tomatoes', { limit: 1 }))[0]!.itemKey).toBe('B');
    await search.close();
  });

  it('re-chunks a changed item instead of leaving its old passages behind', async () => {
    const { lib, search, ctx } = await indexed();
    lib.put('B', 'Organic gardening', 'a treatise on composting worm bins');
    startIndexUpdate(ctx);
    await settle(search);

    expect(search.buildStatus().items).toBe(3);
    expect((await search.query('composting worm bins', { limit: 1 }))[0]!.itemKey).toBe('B');
    // The superseded text is gone, not merely outranked.
    expect(await search.query('tomatoes herbs', { mode: 'keyword' })).toEqual([]);
    await search.close();
  });

  it('removes items the library no longer holds, with their passages and vectors', async () => {
    const embedder = countingEmbedder();
    const { lib, search, ctx } = await indexed(embedder.provider);
    const before = search.buildStatus();
    lib.remove('B');

    startIndexUpdate(ctx);
    await settle(search);
    const s = search.buildStatus();

    expect(s.state).toBe('done');
    expect(s.itemsRemoved).toBe(1);
    expect(s.items).toBe(2);
    expect(s.documents).toBe(before.documents - 1);
    expect(s.vectors).toBe(before.vectors - 1);
    // The keyword index no longer finds it, on either backend.
    expect(await search.query('tomatoes herbs', { mode: 'keyword' })).toEqual([]);
    expect(await search.query('gardening', { mode: 'keyword' })).toEqual([]);
    // Untouched items are still there and still ranked.
    expect((await search.query('convolutional images', { limit: 1 }))[0]!.itemKey).toBe('A');
    expect(s.updateNotice).toMatch(/Updated 0 changed and removed 1 deleted items since cloud library version/);
    expect(statusSummary(s)).toMatch(/removed 1 deleted items/);
    await search.close();
  });

  it('advances the version stamp only when the update fully succeeded', async () => {
    const { lib, search, ctx, router } = await indexed();
    const stamped = search.buildStatus().libraryVersion;
    lib.put('E', 'Glacial isostasy', 'mantle viscosity inversions');
    const duringUpdate = lib.version;

    startIndexUpdate(ctx);
    await settle(search);
    expect(search.buildStatus().libraryVersion).toBe(duringUpdate);
    expect(search.buildStatus().libraryVersion).toBeGreaterThan(stamped);

    // A failed census leaves the stamp exactly where the successful update put it.
    router.itemVersions.mockRejectedValueOnce(new Error('Zotero 503'));
    lib.put('F', 'Tidal dissipation', 'ocean models');
    startIndexUpdate(ctx);
    await settle(search);
    const failed = search.buildStatus();

    expect(failed.state).toBe('error');
    expect(failed.lastError).toMatch(/503/);
    expect(failed.libraryVersion).toBe(duringUpdate);
    // The notice must not claim a rollback the store cannot do.
    expect(failed.updateNotice).toMatch(backend === 'sqlite' ? /rolled back/ : /cannot roll back/);
    expect(failed.updateNotice).toMatch(/version stamp did not move|index is unchanged/);
    await search.close();
  });

  it('refuses to treat an empty census as an emptied library', async () => {
    const { search, ctx, router } = await indexed();
    const stamped = search.buildStatus().libraryVersion;
    router.itemVersions.mockResolvedValueOnce({ versions: {}, totalResults: 0, lastModifiedVersion: 99 });

    startIndexUpdate(ctx);
    await settle(search);
    const s = search.buildStatus();

    expect(s.items).toBe(3); // nothing was erased
    expect(s.itemsRemoved).toBe(0);
    expect(s.libraryVersion).toBe(stamped); // and the delta will be retried
    expect(s.updateNotice).toMatch(/Deletions were NOT reconciled/);
    await search.close();
  });

  it('maintains only the indexed subset when the previous build was capped, and says so', async () => {
    const lib = new FakeLibrary();
    for (let i = 0; i < 6; i++) lib.put(`K${i}`, `Item ${i}`, `abstract body ${i}`);
    const search = await openIndex(backend);
    const ctx = makeCtx(search, lib.router(), { ZOTEUS_INDEX_MAX_ITEMS: '3' });
    startIndexBuild(ctx, undefined, 3);
    await settle(search);
    expect(search.buildStatus().items).toBe(3);

    lib.put('K0', 'Item 0', 'a revised abstract about vulcanism');
    lib.put('NEW', 'Item new', 'never indexed');
    startIndexUpdate(ctx, undefined, 3);
    await settle(search);
    const s = search.buildStatus();

    // K0 was already indexed, so it is refreshed; NEW does not fit under the cap.
    expect(s.items).toBe(3);
    expect(s.itemsFetched).toBe(1);
    expect(s.itemsAvailable).toBe(7);
    expect(s.itemsTotal).toBe(3);
    expect((await search.query('vulcanism', { limit: 1 }))[0]!.itemKey).toBe('K0');
    expect(await search.query('never indexed', { mode: 'keyword' })).toEqual([]);
    expect(s.updateNotice).toMatch(/left out because the index is at its item cap/);
    expect(s.updateNotice).toMatch(/maintains only the subset/);
    await search.close();
  });
});

describe('when an update would be wrong, it falls back to a full rebuild and says so', () => {
  async function built(opts: { local?: boolean; embedder?: EmbeddingProvider } = {}) {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    lib.put('B', 'Organic gardening', 'tomatoes and herbs');
    const search = await openIndex('memory', opts.embedder ? { embedder: opts.embedder } : {});
    const router = lib.router({ local: opts.local });
    startIndexBuild(makeCtx(search, router));
    await settle(search);
    return { lib, search, router };
  }

  it('rebuilds when the index carries no version stamp at all', async () => {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const ctx = makeCtx(search, lib.router());

    const started = startIndexUpdate(ctx);
    await settle(search);

    expect(started.operation).toBe('build');
    expect(search.buildStatus().updateNotice).toMatch(/not possible \(the index is empty\)/);
    expect(search.buildStatus().items).toBe(1);
    // And the rebuild leaves a stamp, so the NEXT update is a real delta.
    expect(search.updateBlocker('cloud')).toBeUndefined();
  });

  it('rebuilds when the library is now served by the other Zotero API', async () => {
    const { lib, search } = await built({ local: true });
    expect(search.buildStatus().libraryBackend).toBe('local');
    // The desktop app went away: the same library is now served by the cloud, whose
    // version numbers have nothing to do with the stamp this index carries.
    const cloudRouter = lib.router({ local: false });
    lib.put('C', 'Reinforcement learning', 'reward shaping');

    startIndexUpdate(makeCtx(search, cloudRouter));
    await settle(search);
    const s = search.buildStatus();

    expect(s.operation).toBe('build');
    expect(s.updateNotice).toMatch(/version sequences are unrelated/);
    expect(s.updateNotice).toMatch(/desktop app/);
    expect(s.items).toBe(3);
    expect(s.libraryBackend).toBe('cloud');
    expect(statusSummary(s)).toMatch(/not possible/);
  });

  it('rebuilds when the embedding model changed under the stored vectors', async () => {
    const small = countingEmbedder('text-embedding-3-small');
    const { lib, search } = await built({ embedder: small.provider });
    expect(search.buildStatus().vectors).toBeGreaterThan(0);

    // Same index object, a different model behind it: only the changed items would come
    // back with comparable vectors, which is not an index anyone can rank.
    const large = countingEmbedder('text-embedding-3-large');
    (search as any).opts.embedder = large.provider;
    expect(search.updateBlocker('cloud')).toMatch(/counting:text-embedding-3-small/);

    startIndexUpdate(makeCtx(search, lib.router()));
    await settle(search);

    expect(search.buildStatus().operation).toBe('build');
    expect(search.buildStatus().updateNotice).toMatch(/only the changed items would carry usable vectors/);
    expect(search.buildStatus().vectors).toBe(2); // all of them re-embedded
  });

  it('rebuilds when the store cannot delete rows', async () => {
    const { lib, search } = await built();
    Object.defineProperty(search, 'supportsDelete', { value: false });

    startIndexUpdate(makeCtx(search, lib.router()));
    await settle(search);

    expect(search.buildStatus().operation).toBe('build');
    expect(search.buildStatus().updateNotice).toMatch(/cannot remove rows/);
  });
});

describe('the SQLite backend keeps its FTS5 index honest through deletions', () => {
  sqliteIt('passes an integrity check after an update removes and replaces items', async () => {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks classify images');
    lib.put('B', 'Organic gardening', 'growing tomatoes and herbs');
    lib.put('C', 'Reinforcement learning', 'reward shaping for policies');
    const search = await openIndex('sqlite');
    const ctx = makeCtx(search, lib.router());
    startIndexBuild(ctx);
    await settle(search);

    lib.remove('B');
    lib.put('A', 'Deep learning', 'vision transformers replace the convolutional stack');
    startIndexUpdate(ctx);
    await settle(search);

    // The external-content protocol was followed, or this throws: FTS5 verifies that every
    // indexed term still resolves to a row of the content table.
    const db = (search as any).db;
    expect(() => db.exec("INSERT INTO passages_fts(passages_fts) VALUES('integrity-check')")).not.toThrow();
    // And the index and the content table agree on how many rows there are.
    const ftsRows = Number(db.prepare('SELECT COUNT(*) AS n FROM passages_fts').get().n);
    expect(ftsRows).toBe(search.buildStatus().documents);
    expect(await search.query('tomatoes herbs', { mode: 'keyword' })).toEqual([]);
    expect((await search.query('vision transformers', { limit: 1 }))[0]!.itemKey).toBe('A');
    await search.close();
  });

  sqliteIt('rolls a failed update back to the previous coherent state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-update-rollback-'));
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks classify images');
    lib.put('B', 'Organic gardening', 'growing tomatoes and herbs');
    const search = await openIndex('sqlite', {}, dir);
    const router = lib.router();
    startIndexBuild(makeCtx(search, router));
    await settle(search);
    const before = search.buildStatus();

    // The upserts land, then the deletion census fails: a half-applied delta.
    lib.put('C', 'Photovoltaic perovskites', 'tandem cell stability');
    router.itemVersions.mockRejectedValueOnce(new Error('Zotero 500'));
    startIndexUpdate(makeCtx(search, router));
    await settle(search);
    const s = search.buildStatus();

    expect(s.state).toBe('error');
    expect(s.items).toBe(before.items);
    expect(s.documents).toBe(before.documents);
    expect(s.libraryVersion).toBe(before.libraryVersion);
    expect(await search.query('perovskites tandem', { mode: 'keyword' })).toEqual([]);
    expect(s.updateNotice).toMatch(/rolled back/);
    expect(statusSummary(s)).toMatch(/Index unchanged/);

    // The rollback reached the file too, not only the in-memory counters.
    await search.close();
    const reopened = await openIndex('sqlite', {}, dir);
    expect(reopened.buildStatus().items).toBe(before.items);
    expect(reopened.buildStatus().libraryVersion).toBe(before.libraryVersion);
    expect(await reopened.query('perovskites tandem', { mode: 'keyword' })).toEqual([]);
    await reopened.close();
  });
});

describe('zotero_index action:"update"', () => {
  it('is offered beside build/refresh and explains what each one does', () => {
    expect(indexTool.inputSchema.action._def.values).toContain('update');
    expect(indexTool.description).toMatch(/action: "update"/);
    expect(indexTool.description).toMatch(/rebuild the WHOLE index/);
    expect(indexTool.description).toMatch(/format=versions/);
  });

  it('runs the delta through the tool and reports it like a build does', async () => {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    lib.put('B', 'Organic gardening', 'tomatoes and herbs');
    const search = await openIndex('memory');
    const ctx = makeCtx(search, lib.router());
    await indexTool.handler({ action: 'build' }, ctx);
    await settle(search);

    lib.put('C', 'Photovoltaic perovskites', 'tandem cell stability');
    lib.remove('A');
    const started = await indexTool.handler({ action: 'update' }, ctx);
    expect(started.content[0]!.text).toMatch(/Index update started/);
    await settle(search);

    const status = await indexTool.handler({ action: 'status' }, ctx);
    expect(status.structuredContent?.state).toBe('done');
    expect(status.structuredContent?.operation).toBe('update');
    expect(status.structuredContent?.itemsFetched).toBe(1);
    expect(status.structuredContent?.itemsRemoved).toBe(1);
    expect(status.structuredContent?.items).toBe(2);
    expect(status.content[0]!.text).toMatch(/updated 1 changed/i);
  });

  it('says so in the tool output when the update became a rebuild', async () => {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    const search = await openIndex('memory');
    const ctx = makeCtx(search, lib.router());

    const started = await indexTool.handler({ action: 'update' }, ctx);
    expect(started.content[0]!.text).toMatch(/Full index rebuild started/);
    expect(started.content[0]!.text).toMatch(/not possible/);
    await settle(search);
    expect(search.buildStatus().items).toBe(1);
  });

  it('keeps action:"refresh" a full rebuild', async () => {
    const lib = new FakeLibrary();
    lib.put('A', 'Deep learning', 'convolutional networks');
    lib.put('B', 'Organic gardening', 'tomatoes and herbs');
    const search = await openIndex('memory');
    const router = lib.router();
    const ctx = makeCtx(search, router);
    await indexTool.handler({ action: 'build' }, ctx);
    await settle(search);
    router.searchItems.mockClear();

    await indexTool.handler({ action: 'refresh' }, ctx);
    await settle(search);

    expect(search.buildStatus().operation).toBe('build');
    // No `since` anywhere: refresh crawls the library, it does not diff it.
    for (const call of router.searchItems.mock.calls) expect(call[0].since).toBeUndefined();
    expect(router.itemVersions).not.toHaveBeenCalled();
  });
});
