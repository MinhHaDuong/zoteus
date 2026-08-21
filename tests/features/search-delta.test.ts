import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import semanticSearch from '../../src/tools/semantic-search.js';
import { startIndexBuild, PAGE_SIZE } from '../../src/features/search/build.js';
import { SqliteSearchIndex, defaultSearchDbPath } from '../../src/features/search/sqlite-index.js';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { refreshIndexIfStale } from '../../src/features/search/delta.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A mutable stand-in for one Zotero library, behind the endpoints a delta needs: `?since=`
 * (what changed), `?format=versions` (what still exists) and the two `/fulltext` reads.
 *
 * Every mutation bumps the library version, exactly as Zotero does, because the version is
 * what the whole freshness protocol turns on. Attachments live in the same map as items,
 * as they do in the real API, so `top:true` and `itemType:'attachment'` mean something.
 */
function fakeLibrary() {
  const objects = new Map<string, any>();
  const text = new Map<string, { content: string; version: number }>();
  let version = 100;

  return {
    get version() {
      return version;
    },
    put(key: string, title: string, abstract: string) {
      version += 1;
      objects.set(key, { key, version, data: { key, itemType: 'journalArticle', title, abstractNote: abstract } });
    },
    /** An attachment on `parent`, with no extracted text until `extract` is called. */
    attach(key: string, parent: string) {
      version += 1;
      objects.set(key, { key, version, data: { key, itemType: 'attachment', title: 'PDF', parentItem: parent } });
    },
    extract(key: string, content: string) {
      version += 1;
      text.set(key, { content, version });
      const att = objects.get(key);
      if (att) att.version = version;
    },
    remove(key: string) {
      version += 1;
      objects.delete(key);
      text.delete(key);
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

type FakeLibrary = ReturnType<typeof fakeLibrary>;

/** Desktop local-API client over `lib`. Every method is counted; see `requests()`. */
function fakeLocalClient(lib: FakeLibrary) {
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

function harness(opts: { env?: Record<string, string>; backend?: 'json' | 'sqlite' } = {}) {
  const lib = fakeLibrary();
  const local = fakeLocalClient(lib);
  const web = { listItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })) };
  const backend = opts.backend ?? 'sqlite';
  const config = loadConfig({ ZOTEUS_LOCAL: 'auto', ZOTEUS_SEARCH_BACKEND: backend, ...opts.env } as any);
  // Local-only: no cloud key at all, desktop app up. The delta must work with no cloud.
  const capabilities = { cloud: null as any, localApi: true, localGroupIds: [] as number[] };
  const router = new LibraryRouter({ config, capabilities, web: web as any, local: local as any });
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-delta-'));
  const dbPath = defaultSearchDbPath(dir);
  const search =
    backend === 'sqlite'
      ? new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath })
      : new SearchIndex({ embedder: null, logger: silentLogger });
  const ctx: any = { config, capabilities, router, web, local, search, logger: silentLogger };
  /** Requests made through the desktop client, summed over every endpoint it exposes. */
  const requests = (): number =>
    Object.values(local).reduce((n, fn) => n + (fn as any).mock.calls.length, 0);
  return { lib, local, web, ctx, search, dbPath, capabilities, requests };
}

type Harness = ReturnType<typeof harness>;

async function settled(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

async function fullBuild(h: Harness, opts: { fulltext?: boolean } = {}): Promise<void> {
  startIndexBuild(h.ctx, undefined, undefined, opts.fulltext ? { fulltext: true } : {});
  await settled(h.search);
}

/** Item keys zotero_semantic_search answers with, through the real tool handler. */
async function found(h: Harness, q: string): Promise<string[]> {
  const res = await semanticSearch.handler({ q, limit: 10, auto_build: false }, h.ctx);
  const hits = ((res.structuredContent as any)?.hits ?? []) as Array<{ itemKey: string }>;
  return hits.map((x) => x.itemKey);
}

function threeItems(h: Harness): void {
  h.lib.put('AAA', 'Deep learning', 'convolutional neural networks');
  h.lib.put('BBB', 'Organic gardening', 'growing tomatoes and herbs');
  h.lib.put('CCC', 'Ocean currents', 'thermohaline circulation');
}

describe('index delta — keeping the index current at query time', () => {
  it('stops returning an item the library no longer has, with no manual rebuild', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    expect(await found(h, 'tomatoes')).toEqual(['BBB']);

    h.lib.remove('BBB');

    // The headline invariant. Before this ticket the index could not express it at all:
    // every build was a full rebuild and nothing ever revisited the library, so a deleted
    // item went on answering queries forever.
    expect(await found(h, 'tomatoes')).toEqual([]);
    expect(await found(h, 'thermohaline')).toEqual(['CCC']);
    expect(h.search.status().items).toBe(2);
  });

  it('finds an item added after the build, with no manual rebuild', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    expect(await found(h, 'photosynthesis')).toEqual([]);

    h.lib.put('DDD', 'Leaf physiology', 'photosynthesis under drought');

    expect(await found(h, 'photosynthesis')).toEqual(['DDD']);
    expect(h.search.status().items).toBe(4);
  });

  it('drops a modified item\'s stale passages rather than adding to them', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    expect(await found(h, 'tomatoes')).toEqual(['BBB']);

    h.lib.put('BBB', 'Marine biology', 'coral reef bleaching');

    // Not "the new text outranks the old" — the old text must be UNFINDABLE. An item that
    // kept its previous passages beside its new ones would still answer for an abstract
    // its owner deleted, and would do so with a plausible-looking score.
    expect(await found(h, 'coral reef bleaching')).toEqual(['BBB']);
    expect(await found(h, 'tomatoes')).toEqual([]);
    expect(h.search.status().items).toBe(3);
  });

  it('spends exactly one request when nothing has changed', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    const before = h.requests();

    expect(await found(h, 'neural networks')).toEqual(['AAA']);

    // The budget, and the ticket's exit criterion: one Last-Modified-Version probe, and
    // nothing else, on a library that has not moved. Pinned as a count rather than as a
    // property, because "no more than a few" is what silently becomes a per-query crawl.
    expect(h.requests() - before).toBe(1);
    expect(h.local.listItems).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }), expect.anything());
    expect(h.local.versions).not.toHaveBeenCalled();
    expect(h.local.fullTextSince).not.toHaveBeenCalled();
  });

  it('reports the outcome without spending a second probe on a concurrent query', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    const before = h.requests();

    // Two searches in flight together must not both interrogate Zotero; the second joins
    // the first. Without the single-flight this is 2 requests, and 20 under load.
    const [a, b] = await Promise.all([refreshIndexIfStale(h.ctx), refreshIndexIfStale(h.ctx)]);
    expect(a.state).toBe('fresh');
    expect(b.state).toBe('fresh');
    expect(h.requests() - before).toBe(1);
  });
});

describe('index delta — the watermark and its provenance', () => {
  it('records the library version, not the item count, and round-trips it through index_meta', async () => {
    const h = harness();
    threeItems(h);
    const version = h.lib.version;
    await fullBuild(h);

    expect(h.search.watermark).toEqual({ version, backend: 'local' });
    // Three items, and a version that is not 3: the old code stored `itemsFetched` here,
    // which is not a stale library version but a number from another quantity entirely.
    expect(h.search.status().builtFromVersion).toBe(version);
    expect(version).not.toBe(3);

    // A second connection onto the same file — a restarted server — sees both halves.
    const reopened = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath: h.dbPath });
    expect(reopened.watermark).toEqual({ version, backend: 'local' });
  });

  it('restores items and full-text counts on reopen, not just the watermark', async () => {
    const h = harness();
    threeItems(h);
    h.lib.attach('ATT1', 'AAA');
    h.lib.extract('ATT1', 'gradient descent converges slowly on ill-conditioned problems');
    await fullBuild(h, { fulltext: true });
    expect(h.search.status().fulltextItems).toBe(1);

    const reopened = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath: h.dbPath });
    const status = reopened.status();
    // The other half of the gap ticket 0005 left: these read 0 after a restart, so a fully
    // built index reported an empty library until somebody rebuilt it by hand.
    expect(status.items).toBe(3);
    expect(status.documents).toBeGreaterThan(3);
    expect(status.fulltextItems).toBe(1);
    expect(status.fulltextPassages).toBeGreaterThan(0);
    expect(status.fulltextEnabled).toBe(true);
  });

  it('rebuilds instead of computing a delta when the watermark came from another backend', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    expect(h.search.watermark.backend).toBe('local');

    // The desktop app closes and a cloud key takes over. The two APIs number their
    // libraries independently — the local one answered 103 here, the cloud is in the
    // thousands — so comparing across the switch would either skip every future change or
    // replay the library.
    h.capabilities.localApi = false;
    h.capabilities.cloud = { userID: 19552201, username: 'oscardvs', access: {} };

    const before = h.requests();
    const outcome = await refreshIndexIfStale(h.ctx);
    expect(outcome.state).toBe('rebuilding');
    // Decided from the label alone: the verdict does not depend on any version, so not one
    // request is spent asking for one.
    expect(outcome.requests).toBe(0);
    expect(h.requests() - before).toBe(0);
    expect(h.web.listItems).toHaveBeenCalled();
  });

  it('rebuilds rather than trusting an unlabelled watermark from an older index', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);

    // What a pre-0006 database looks like: a builtFromVersion holding an ITEM COUNT and no
    // label at all. Reconstructed by handing the index the number with no provenance.
    const legacy = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath: h.dbPath });
    (legacy as any).builtFromVersion = 3;
    (legacy as any).indexBackend = undefined;
    h.ctx.search = legacy;

    const outcome = await refreshIndexIfStale(h.ctx);
    expect(outcome.state).toBe('rebuilding');
    expect(outcome.requests).toBe(0);
  });
});

describe('index delta — degradation', () => {
  it('serves the index it has when Zotero cannot be reached, rather than erroring', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);

    h.local.listItems.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:23119'));

    const res = await semanticSearch.handler({ q: 'tomatoes', limit: 5, auto_build: false }, h.ctx);
    expect(res.isError).toBeFalsy();
    expect(((res.structuredContent as any).hits as any[]).map((x) => x.itemKey)).toEqual(['BBB']);
    expect((res.structuredContent as any).indexRefresh).toBe('unreachable');
    expect(res.content[0]!.text).toMatch(/could not be reached/);
  });

  it('stops probing for a while once Zotero has proved unreachable', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    h.local.listItems.mockRejectedValue(new Error('connect ECONNREFUSED'));

    expect((await refreshIndexIfStale(h.ctx)).requests).toBe(1);
    // A closed desktop app must not make every query pay a connection failure.
    expect((await refreshIndexIfStale(h.ctx)).requests).toBe(0);
  });

  it('rebuilds rather than applying an unbounded delta inline', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    h.lib.put('DDD', 'Leaf physiology', 'photosynthesis under drought');
    h.lib.put('EEE', 'Glacier mass balance', 'ablation and accumulation');

    // A delta far larger than the ceiling is slower than the crawl it replaces, and it
    // would run in front of a user waiting for search results.
    const outcome = await refreshIndexIfStale(h.ctx, undefined, { maxDeltaItems: 1 });
    expect(outcome.state).toBe('rebuilding');
    expect(outcome.detail).toMatch(/delta ceiling/);
  });

  it('leaves the watermark where it was when a delta cannot be completed', async () => {
    const h = harness();
    threeItems(h);
    await fullBuild(h);
    const before = h.search.watermark;
    h.lib.put('DDD', 'Leaf physiology', 'photosynthesis under drought');
    h.local.versions.mockRejectedValue(new Error('local API 500'));

    const outcome = await refreshIndexIfStale(h.ctx);
    expect(outcome.state).toBe('skipped');
    // Unmoved on purpose: a watermark advanced past changes that were never applied marks
    // them as indexed for good. Leaving it means the next query retries the same delta.
    expect(h.search.watermark).toEqual(before);
  });
});

describe('index delta — attachments Zotero has not extracted yet', () => {
  it('picks up an attachment extracted after the build, and records it as pending until then', async () => {
    const h = harness();
    h.lib.put('AAA', 'Deep learning', 'convolutional neural networks');
    h.lib.attach('ATT1', 'AAA');
    // Present without text: Zotero holds the PDF and has not extracted it. Skipping it
    // here is what used to make "no text yet" indistinguishable from "no attachment".
    await fullBuild(h, { fulltext: true });

    expect(await found(h, 'ill-conditioned')).toEqual([]);
    expect(h.search.fulltextPendingItems).toEqual(['AAA']);
    expect(h.search.status().fulltextPendingItems).toBe(1);

    h.lib.extract('ATT1', 'gradient descent converges slowly on ill-conditioned problems');

    expect(await found(h, 'ill-conditioned')).toEqual(['AAA']);
    expect(h.search.status().fulltextItems).toBe(1);
    expect(h.search.fulltextPendingItems).toEqual([]);
  });

  it('carries the pending record across a restart, when nothing is extracted at all', async () => {
    const h = harness();
    h.lib.put('AAA', 'Deep learning', 'convolutional neural networks');
    h.lib.attach('ATT1', 'AAA');
    await fullBuild(h, { fulltext: true });
    expect(h.search.fulltextPendingItems).toEqual(['AAA']);

    // The case with no other evidence: an index whose every attachment is unextracted holds
    // zero full-text passages, so nothing else in the database says it was built for full
    // text. A reopened index that forgot this would run a metadata-only delta and clear the
    // record, and those PDFs would never be indexed however often Zotero extracted them.
    const reopened = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath: h.dbPath });
    expect(reopened.fulltextPendingItems).toEqual(['AAA']);
    expect(reopened.status().fulltextEnabled).toBe(true);

    h.ctx.search = reopened;
    h.lib.extract('ATT1', 'gradient descent converges slowly on ill-conditioned problems');
    expect(await found(h, 'ill-conditioned')).toEqual(['AAA']);
  });
});

describe('index delta — the JSON backend keeps its old behaviour', () => {
  it('runs no freshness check and issues no extra request', async () => {
    const h = harness({ backend: 'json' });
    threeItems(h);
    await fullBuild(h);
    const before = h.requests();

    expect(h.search.supportsDelta).toBe(false);
    const outcome = await refreshIndexIfStale(h.ctx);
    expect(outcome).toEqual({ state: 'unsupported', requests: 0 });

    h.lib.remove('BBB');
    // Unchanged, deliberately: a delta needs cheap partial writes and an indexed
    // delete-by-item, and the resident BM25 index has neither. The JSON backend rebuilds
    // whole or not at all — which is exactly what it did before this ticket.
    expect(await found(h, 'tomatoes')).toEqual(['BBB']);
    expect(h.requests() - before).toBe(0);
  });
});
