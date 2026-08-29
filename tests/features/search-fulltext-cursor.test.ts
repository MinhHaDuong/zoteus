import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { IndexSnapshot, SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';

/**
 * Zotero versions extracted full text on a sequence of its own, unrelated to item versions.
 * Opening a PDF for the first time makes Zotero extract it and touches no item version at
 * all, so that item appears in no `?since=` delta, ever — and an index's full-text coverage
 * stayed frozen at build time with a rebuild as the only remedy (#26). An update now carries
 * a cursor into the other sequence and asks it what has been extracted since.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

const BODY_ONE = 'The ablation removes the recurrent gate entirely. '.repeat(20);
const BODY_TWO = 'Perovskite tandem cells degrade under sustained illumination. '.repeat(20);
const BODY_THREE = 'Appendix C derives the isostatic rebound of the mantle. '.repeat(20);

/** A library with the two independent version sequences the real one has. */
class FakeZotero {
  itemVersion = 0;
  fulltextVersion = 0;
  private readonly items = new Map<string, { key: string; version: number; data: any }>();
  private readonly attachments = new Map<
    string,
    { key: string; parent?: string; version?: number; content?: string }
  >();

  putItem(key: string, title: string, abstractNote = ''): void {
    this.itemVersion++;
    this.items.set(key, { key, version: this.itemVersion, data: { key, itemType: 'journalArticle', title, abstractNote } });
  }

  /** A PDF sits under the item. Zotero has not read it yet, so it has no full text. */
  attach(key: string, parent?: string): void {
    this.itemVersion++;
    this.attachments.set(key, { key, parent });
  }

  /**
   * Zotero extracts the PDF, as it does the first time one is opened: the full-text
   * sequence moves and the item sequence does not. That asymmetry is the whole issue.
   */
  extract(key: string, content: string): void {
    this.fulltextVersion++;
    const att = this.attachments.get(key);
    if (!att) throw new Error(`no attachment ${key}`);
    att.version = this.fulltextVersion;
    att.content = content;
  }

  router() {
    const items = () => [...this.items.values()];
    const atts = () => [...this.attachments.values()];
    return {
      servesLocally: vi.fn(() => false),
      defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
      searchItems: vi.fn(async (q: any) => {
        const start = q.start ?? 0;
        const limit = q.limit ?? PAGE_SIZE;
        if (q.itemType === 'attachment') {
          const page = atts().slice(start, start + limit);
          return {
            data: page.map((a) => ({ key: a.key, data: { key: a.key, itemType: 'attachment', parentItem: a.parent } })),
            totalResults: atts().length,
            lastModifiedVersion: this.itemVersion,
          };
        }
        const matching = items().filter((it) => it.version > (q.since ?? 0));
        return {
          data: matching.slice(start, start + limit).map((it) => ({ key: it.key, data: it.data })),
          totalResults: matching.length,
          lastModifiedVersion: this.itemVersion,
        };
      }),
      itemVersions: vi.fn(async (q: any) => {
        const start = q.start ?? 0;
        const page = items().slice(start, start + (q.limit ?? PAGE_SIZE));
        return {
          versions: Object.fromEntries(page.map((it) => [it.key, it.version])),
          totalResults: this.items.size,
          lastModifiedVersion: this.itemVersion,
        };
      }),
      // `/fulltext?since=` answers on the OTHER sequence: attachment keys, their full-text
      // versions, and only those newer than the cursor handed in.
      fullTextSince: vi.fn(async (since: number) =>
        Object.fromEntries(
          atts()
            .filter((a) => a.version !== undefined && a.version > since)
            .map((a) => [a.key, a.version!]),
        ),
      ),
      getFullText: vi.fn(async (key: string) => {
        const att = this.attachments.get(key);
        return att?.content ? { content: att.content } : null;
      }),
    };
  }
}

async function openIndex(backend: 'memory' | 'sqlite', opts: Partial<SearchIndexOptions> = {}): Promise<SearchIndex> {
  return createSearchIndex({ embedder: null, logger: silentLogger, ...opts, backend, jsonPath: '' });
}

function makeCtx(search: SearchIndex, router: any): any {
  return { config: loadConfig({} as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

/** A two-item library: one PDF Zotero has read, one it has not looked at yet. */
function halfExtracted(): FakeZotero {
  const z = new FakeZotero();
  z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
  z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
  z.attach('ATT1', 'K1');
  z.attach('ATT2', 'K2');
  z.extract('ATT1', BODY_ONE);
  return z;
}

describe.each(backends)('full text extracted after the build (%s backend)', (backend) => {
  async function built() {
    const zotero = halfExtracted();
    const search = await openIndex(backend);
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    return { zotero, search, router, ctx };
  }

  it('records the highest full-text version the build consumed', async () => {
    const { zotero, search } = await built();
    const s = search.buildStatus();
    expect(s.fulltextItems).toBe(1);
    // The cursor is a number from Zotero's full-text sequence, not from the item one.
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.libraryVersion).toBe(zotero.itemVersion);
    expect(s.fulltextVersion).not.toBe(s.libraryVersion);
    await search.close();
  });

  it('is picked up by an update although the item itself never changed', async () => {
    const { zotero, search, router, ctx } = await built();
    expect(await search.query('perovskite illumination degrade', { mode: 'keyword' })).toEqual([]);
    const stamped = search.buildStatus().libraryVersion;

    // The ordinary case: the user opens K2's PDF in Zotero, which extracts it. No item
    // version moves, so `?since=` returns nothing at all.
    zotero.extract('ATT2', BODY_TWO);
    expect(zotero.itemVersion).toBe(stamped);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    const s = search.buildStatus();

    expect(s.state).toBe('done');
    expect(s.operation).toBe('update');
    expect(s.itemsFetched).toBe(0); // nothing changed on the item sequence
    expect(s.fulltextItems).toBe(2);
    const hit = (await search.query('perovskite illumination degrade', { limit: 1 }))[0]!;
    expect(hit.itemKey).toBe('K2');
    expect(hit.source).toBe('fulltext');
    // K1's body is untouched, and was not fetched a second time to prove it.
    expect(router.getFullText.mock.calls.filter((c: any[]) => c[0] === 'ATT1')).toHaveLength(1);
    expect(s.updateNotice).toMatch(/1 unchanged item\(s\) gained newly extracted attachment full text/);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    await search.close();
  });

  it('replaces an item\'s body passages when a second attachment is extracted', async () => {
    const { zotero, search, ctx } = await built();
    zotero.attach('ATT3', 'K1');
    zotero.extract('ATT3', BODY_THREE);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // Both bodies are searchable under the one item, and the passage ids the first
    // attachment used were retired rather than written over (SQLite would refuse that).
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect((await search.query('recurrent gate ablation', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(search.buildStatus().fulltextItems).toBe(1);
    await search.close();
  });

  it('costs one probe and one empty page when nothing has been extracted since', async () => {
    const { search, router, ctx } = await built();
    router.searchItems.mockClear();
    router.fullTextSince.mockClear();
    router.getFullText.mockClear();

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // The item crawl is the single empty page it always was.
    const crawls = router.searchItems.mock.calls.filter((c: any[]) => c[0].top);
    expect(crawls).toHaveLength(1);
    expect(crawls[0]![0]).toMatchObject({ since: search.buildStatus().libraryVersion, top: true });
    // The other sequence costs exactly one request, which answers with nothing, so the
    // attachment map is never built and no body is fetched.
    expect(router.fullTextSince).toHaveBeenCalledTimes(1);
    expect(router.fullTextSince.mock.calls[0]![0]).toBe(search.buildStatus().fulltextVersion);
    expect(router.searchItems.mock.calls.filter((c: any[]) => c[0].itemType === 'attachment')).toHaveLength(0);
    expect(router.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().updateNotice).not.toMatch(/gained newly extracted/);
    await search.close();
  });

  it('advances the cursor only when the update fully succeeded', async () => {
    const { zotero, search, router, ctx } = await built();
    const cursor = search.buildStatus().fulltextVersion;
    zotero.extract('ATT2', BODY_TWO);

    // The deletion census fails, so the whole delta is retried next time: a cursor that
    // moved anyway would skip this text forever.
    router.itemVersions.mockRejectedValueOnce(new Error('Zotero 503'));
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().state).toBe('error');
    expect(search.buildStatus().fulltextVersion).toBe(cursor);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    await search.close();
  });
});

describe('the SQLite backend keeps its FTS5 index honest through a catch-up', () => {
  const sqliteIt = hasSqlite ? it : it.skip;

  sqliteIt('passes an integrity check after body passages are replaced', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('sqlite');
    const ctx = makeCtx(search, zotero.router());
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    zotero.extract('ATT2', BODY_TWO);
    zotero.attach('ATT3', 'K1');
    zotero.extract('ATT3', BODY_THREE);
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // The external-content delete protocol was followed for the body rows too, or this
    // throws: FTS5 verifies that every indexed term still resolves to a content row.
    const db = (search as any).db;
    expect(() => db.exec("INSERT INTO passages_fts(passages_fts) VALUES('integrity-check')")).not.toThrow();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM passages_fts').get().n)).toBe(search.buildStatus().documents);
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K1');
    await search.close();
  });
});

describe('an update that was never asked for full text', () => {
  it('does not consult the full-text sequence at all', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    router.fullTextSince.mockClear();

    zotero.extract('ATT2', BODY_TWO);
    startIndexUpdate(ctx, undefined, undefined, { fulltext: false });
    await settle(search);

    expect(router.fullTextSince).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextItems).toBe(1);
  });

  it('never turns a metadata-only index into a full-text crawl', async () => {
    // `update fulltext:true` over an index that holds no body text at all would otherwise
    // become the hours-long build the user did not ask for.
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx);
    await settle(search);
    expect(search.buildStatus().fulltextPassages).toBe(0);
    router.getFullText.mockClear();

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    expect(router.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextPassages).toBe(0);
  });

  it('carries on with the delta when the full-text probe fails', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    const cursor = search.buildStatus().fulltextVersion;

    router.fullTextSince.mockRejectedValueOnce(new Error('403 Forbidden'));
    zotero.putItem('K3', 'Glacial isostasy', 'mantle viscosity inversions');
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.itemsFetched).toBe(1); // the item delta landed
    expect(s.fulltextVersion).toBe(cursor); // and the cursor stayed put, so the next one asks again
    expect((await search.query('mantle viscosity', { limit: 1 }))[0]!.itemKey).toBe('K3');
  });
});

describe('an index built before the full-text cursor existed', () => {
  /** The v1.9.0 artifact: rows, a stamp, and no `fulltextVersion` at all. */
  async function migrated(): Promise<{ zotero: FakeZotero; search: MemorySearchIndex; router: any; ctx: any }> {
    const zotero = halfExtracted();
    const built = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const first = makeCtx(built, zotero.router());
    startIndexBuild(first, undefined, undefined, { fulltext: true });
    await settle(built);
    const snapshot = JSON.parse(JSON.stringify(built.toJSON())) as IndexSnapshot;
    delete snapshot.fulltextVersion;

    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    search.loadFromJSON(snapshot);
    const router = zotero.router();
    return { zotero, search, router, ctx: makeCtx(search, router) };
  }

  it('loads, and reports no cursor rather than a wrong one', async () => {
    const { search } = await migrated();
    expect(search.buildStatus().fulltextVersion).toBe(0);
    expect(search.buildStatus().fulltextItems).toBe(1);
    expect(search.buildStatus().libraryVersion).toBeGreaterThan(0);
  });

  it('closes its coverage gap once, then keeps a real cursor', async () => {
    const { zotero, search, router, ctx } = await migrated();
    zotero.extract('ATT2', BODY_TWO);
    router.getFullText.mockClear();

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // Bounded by the gap: only the item holding no body passages was fetched, never the
    // one already covered, although a cursor of 0 makes the census report both as new.
    expect(router.getFullText.mock.calls.map((c: any[]) => c[0])).toEqual(['ATT2']);
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);

    // And the catch-up is a one-off: with a real cursor, the next update asks from there.
    router.fullTextSince.mockClear();
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(router.fullTextSince.mock.calls[0]![0]).toBe(zotero.fulltextVersion);
  });
});
