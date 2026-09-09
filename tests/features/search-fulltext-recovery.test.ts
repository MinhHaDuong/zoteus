import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';

/**
 * The recovery an incomplete attachment map owes, and the four ways it went wrong (#78).
 *
 * A build whose attachment map stopped short withholds the full-text cursor and records
 * that its coverage is partial, and the mark is what makes a later update re-read the whole
 * census rather than only the items holding no body text at all. That recovery has to be
 * bounded (a read that always fails must not buy a whole-census crawl on every update,
 * forever), reachable (a mark raised while a cursor is already stamped has to be actable),
 * honest (a pass that read nothing recovered nothing), and visible (the mark outlives the
 * process, so the status has to say so).
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

const BODY_ONE = 'The ablation removes the recurrent gate entirely. '.repeat(20);
const BODY_TWO = 'Perovskite tandem cells degrade under sustained illumination. '.repeat(20);
const BODY_THREE = 'Appendix C derives the isostatic rebound of the mantle. '.repeat(20);
const BODY_FOUR = 'Table 4 lists the wafer annealing temperatures used throughout. '.repeat(20);

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
    this.items.set(key, {
      key,
      version: this.itemVersion,
      data: { key, itemType: 'journalArticle', title, abstractNote },
    });
  }

  attach(key: string, parent?: string): void {
    this.itemVersion++;
    this.attachments.set(key, { key, parent });
  }

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
            data: page.map((a) => ({
              key: a.key,
              data: { key: a.key, itemType: 'attachment', parentItem: a.parent },
            })),
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

async function openIndex(
  backend: 'memory' | 'sqlite',
  opts: Partial<SearchIndexOptions> = {},
): Promise<SearchIndex> {
  return createSearchIndex({ embedder: null, logger: silentLogger, ...opts, backend, jsonPath: '' });
}

function makeCtx(search: SearchIndex, router: any): any {
  return { config: loadConfig({} as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

/** Three items, three extracted PDFs, one per item. */
function threeExtracted(): FakeZotero {
  const z = new FakeZotero();
  z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
  z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
  z.putItem('K3', 'Glacial isostasy', 'mantle viscosity inversions');
  z.attach('ATT1', 'K1');
  z.attach('ATT2', 'K2');
  z.attach('ATT3', 'K3');
  z.extract('ATT1', BODY_ONE);
  z.extract('ATT2', BODY_TWO);
  z.extract('ATT3', BODY_THREE);
  return z;
}

/** K1 holds ATT1 and ATT4, K2 holds ATT2, and Zotero has extracted all three. */
function straddling(): FakeZotero {
  const z = new FakeZotero();
  z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
  z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
  z.attach('ATT1', 'K1');
  z.attach('ATT2', 'K2');
  z.attach('ATT4', 'K1');
  z.extract('ATT1', BODY_ONE);
  z.extract('ATT2', BODY_TWO);
  z.extract('ATT4', BODY_FOUR);
  return z;
}

/** The attachment listing serves one attachment and then takes longer than the budget. */
function mapStopsAfterOnePage(zotero: FakeZotero): any {
  const router = zotero.router();
  const listing = router.searchItems;
  let attachmentPages = 0;
  router.searchItems = vi.fn(async (q: any) => {
    if (q.itemType !== 'attachment') return listing(q);
    if (attachmentPages++ > 0) {
      throw new Error('Zotero took longer than the 25s budget to answer a single request');
    }
    return listing({ ...q, limit: 1 });
  });
  return router;
}

/** A healthy router whose map reaches the end, but where one attachment cannot be read. */
function healthyExcept(zotero: FakeZotero, unreadable: string): any {
  const router = zotero.router();
  const read = router.getFullText;
  router.getFullText = vi.fn(async (key: string) => {
    if (key === unreadable) throw new Error('ENOENT: the attachment file is missing');
    return read(key);
  });
  return router;
}

/** The attachment keys one router was asked for the body text of, in order. */
function reads(router: any): string[] {
  return router.getFullText.mock.calls.map((c: any[]) => c[0] as string);
}

/**
 * FINDING 1: the recovery re-read has to be bounded by more than the map.
 *
 * With the mark standing, the map complete and one attachment whose read always fails (a
 * missing file, a 403, a linked file the server will not serve), every update paid a
 * whole-census body crawl and recovered nothing: on the reporter's 8,953-attachment
 * library, a full body crawl on every update, indefinitely. The cursor must stay withheld
 * and the mark must stay standing, and the crawl must stop being paid.
 */
describe.each(backends)('a recovery whose reads keep failing (%s backend)', (backend) => {
  async function partialIndex(zotero: FakeZotero) {
    const search = await openIndex(backend);
    startIndexBuild(makeCtx(search, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(search);
    // The map reached one attachment: K1 holds body text, the cursor was withheld.
    expect(search.buildStatus().fulltextItems).toBe(1);
    expect(search.buildStatus().fulltextVersion).toBe(0);
    return search;
  }

  it('stops paying the whole-census crawl, keeping the withheld cursor and the mark', async () => {
    const zotero = threeExtracted();
    const search = await partialIndex(zotero);

    // Three recoveries over a complete map, each ending on the same unreadable attachment.
    for (let i = 0; i < 3; i++) {
      const router = healthyExcept(zotero, 'ATT3');
      startIndexUpdate(makeCtx(search, router), undefined, undefined, { fulltext: true });
      await settle(search);
      expect(reads(router).sort()).toEqual(['ATT1', 'ATT2', 'ATT3']);
      expect(search.buildStatus().fulltextVersion).toBe(0);
    }

    // The fourth stops paying for it: only K3, which holds no body text at all, is asked
    // for. K1 and K2 are left alone rather than re-read for the fourth time.
    const bounded = healthyExcept(zotero, 'ATT3');
    startIndexUpdate(makeCtx(search, bounded), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().state).toBe('done');
    expect(reads(bounded)).toEqual(['ATT3']);
    // Honest throughout: no cursor, the mark still standing, and the status says why.
    expect(search.buildStatus().fulltextVersion).toBe(0);
    expect(search.buildStatus().fulltextPartial).toBe(true);
    expect(search.buildStatus().fulltextReason).toMatch(/keeps failing|failed .* time/i);

    // And it stays bounded.
    const again = healthyExcept(zotero, 'ATT3');
    startIndexUpdate(makeCtx(search, again), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(reads(again)).toEqual(['ATT3']);
    await search.close();
  });

  it('still recovers when the failure was transient', async () => {
    const zotero = threeExtracted();
    const search = await partialIndex(zotero);

    const flaky = healthyExcept(zotero, 'ATT3');
    startIndexUpdate(makeCtx(search, flaky), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().fulltextVersion).toBe(0);
    expect(search.buildStatus().fulltextPartial).toBe(true);

    // The file comes back: the whole-census re-read is still paid, once, and finishes.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(reads(healthy).sort()).toEqual(['ATT1', 'ATT2', 'ATT3']);
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect(search.buildStatus().fulltextPartial).toBeFalsy();
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K3');
    await search.close();
  });

  it('is cleared by a fresh build, which starts the coverage over', async () => {
    const zotero = threeExtracted();
    const search = await partialIndex(zotero);
    for (let i = 0; i < 4; i++) {
      startIndexUpdate(makeCtx(search, healthyExcept(zotero, 'ATT3')), undefined, undefined, { fulltext: true });
      await settle(search);
    }
    expect(search.buildStatus().fulltextPartial).toBe(true);

    // action:"refresh" is exactly this: a build with fresh:true.
    startIndexBuild(makeCtx(search, zotero.router()), undefined, undefined, { fulltext: true, fresh: true });
    await settle(search);
    const s = search.buildStatus();
    expect(s.fulltextPartial).toBeFalsy();
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.fulltextItems).toBe(3);
    await search.close();
  });
});

/**
 * FINDING 2: a mark raised on the delta path was unreachable.
 *
 * A delta that writes body text over an incomplete map raises the mark, and that happens
 * while a cursor is already stamped. Recovery required the stored cursor to be 0, and the
 * cursor only ever moves forward, so the mark stood forever: no update ever re-read
 * anything, nothing on the status said so, and the text the truncated map dropped was
 * recorded nowhere. While the mark stands the catch-up asks Zotero's sequence from the
 * START, whatever cursor is stored.
 */
describe.each(backends)('a mark raised by a delta over a truncated map (%s backend)', (backend) => {
  it('is acted on by the next update, which asks the sequence from the start', async () => {
    const zotero = straddling();
    const search = await openIndex(backend);
    // A healthy build: a real cursor, whole coverage, both of K1's bodies indexed.
    startIndexBuild(makeCtx(search, zotero.router()), undefined, undefined, { fulltext: true });
    await settle(search);
    const cursor = search.buildStatus().fulltextVersion;
    expect(cursor).toBe(zotero.fulltextVersion);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');

    // The reader edits K1 while the attachment map truncates: the delta re-indexes K1 off
    // ATT1 alone and drops ATT4's body text, which no `?since=` will ever name again.
    zotero.putItem('K1', 'Deep learning revisited', 'convolutional networks classify images');
    startIndexUpdate(makeCtx(search, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(await search.query('wafer annealing temperatures', { mode: 'keyword' })).toEqual([]);
    expect(search.buildStatus().fulltextPartial).toBe(true);
    expect(search.buildStatus().fulltextVersion).toBe(cursor);

    // Nothing has changed in Zotero and the cursor is well past everything it holds, so a
    // `?since=<cursor>` delta of the full-text sequence would name nothing at all. The
    // mark is what sends this pass back to the start of that sequence.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(healthy.fullTextSince.mock.calls[0]![0]).toBe(0);
    expect(reads(healthy).sort()).toEqual(['ATT1', 'ATT2', 'ATT4']);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(search.buildStatus().fulltextPartial).toBeFalsy();
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect(search.buildStatus().fulltextReason).toBeUndefined();

    // And it is a one-off: the next update is the idle one it always was.
    const idle = zotero.router();
    startIndexUpdate(makeCtx(search, idle), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(idle.getFullText).not.toHaveBeenCalled();
    expect(idle.fullTextSince.mock.calls[0]![0]).toBe(zotero.fulltextVersion);
    await search.close();
  });
});

/**
 * FINDING 3: an empty census retired the mark having read nothing.
 *
 * When `/fulltext?since=0` answers empty the pass returns before the attachment source is
 * ever opened, so "the map reached the end of the library" answered true because nothing
 * had been crawled. No read failed, so the pass reported itself recovered, the mark came
 * off, and the next update ran gap-only: it skipped the straddling item, stamped the
 * cursor, and lost that text for good.
 */
describe.each(backends)('a recovery whose census came back empty (%s backend)', (backend) => {
  it('recovers nothing, and leaves the mark for a pass that actually reads', async () => {
    const zotero = straddling();
    const search = await openIndex(backend);
    startIndexBuild(makeCtx(search, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().fulltextPartial).toBe(true);
    expect(await search.query('wafer annealing temperatures', { mode: 'keyword' })).toEqual([]);

    // Zotero answers its full-text sequence with nothing at all (its own index rebuilding,
    // say). Nothing is read, no map is opened, and so nothing is recovered.
    const blind = zotero.router();
    blind.fullTextSince = vi.fn(async () => ({}));
    startIndexUpdate(makeCtx(search, blind), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().state).toBe('done');
    expect(blind.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextPartial).toBe(true);
    expect(search.buildStatus().fulltextVersion).toBe(0);
    // And it says so, rather than reporting a recovery that never happened.
    expect(search.buildStatus().fulltextReason).toMatch(/named no extracted attachment/);

    // Which is what leaves the straddling item recoverable: the next real pass re-reads it.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(reads(healthy).sort()).toEqual(['ATT1', 'ATT2', 'ATT4']);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    await search.close();
  });
});

/**
 * FINDING 4: the recovery state was invisible.
 *
 * The mark is persisted but nothing surfaced it, and the per-pass reason does not survive a
 * restart: after a close and reopen the index still owed a full body re-read, and nothing
 * on `action:"status"` said so.
 */
describe('the status of an index holding partial coverage', () => {
  it('says so after a restart, and says what the next full-text update may cost', async () => {
    const zotero = straddling();
    const built = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    startIndexBuild(makeCtx(built, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(built);
    expect(built.buildStatus().fulltextPartial).toBe(true);

    // The process restarts: everything a caller can learn comes off the artifact.
    const reloaded = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    reloaded.loadFromJSON(JSON.parse(JSON.stringify(built.toJSON())));
    const s = reloaded.buildStatus();
    expect(s.fulltextVersion).toBe(0);
    expect(s.fulltextPartial).toBe(true);
    expect(s.fulltextReason).toMatch(/partial/i);
    expect(s.fulltextReason).toMatch(/re-read|crawl/i);
  });

  it('says nothing of the kind for an index whose coverage is whole', async () => {
    const zotero = straddling();
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    startIndexBuild(makeCtx(search, zotero.router()), undefined, undefined, { fulltext: true });
    await settle(search);
    const s = search.buildStatus();
    expect(s.fulltextPartial).toBeFalsy();
    expect(s.fulltextReason).toBeUndefined();
  });
});

/**
 * The documentation claim a reviewer measured as false: at the moment the CHANGELOG
 * describes, an update over an index holding no body text at all, the status said nothing
 * about opening PDFs and building.
 */
describe('an update over an index holding no body text at all', () => {
  it('says on the status what to do about it', async () => {
    const zotero = threeExtracted();
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const ctx = makeCtx(search, zotero.router());
    startIndexBuild(ctx); // metadata only
    await settle(search);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    const s = search.buildStatus();
    expect(s.fulltextVersion).toBe(0);
    expect(s.fulltextReason).toMatch(/open/i);
    expect(s.fulltextReason).toMatch(/fulltext:true/);
  });
});
