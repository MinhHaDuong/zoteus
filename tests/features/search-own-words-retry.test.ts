import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate, statusSummary } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { OwnWordsAccess, SearchIndex } from '../../src/features/search/backend.js';

/**
 * A transient failure while catching up the reader's own words must leave the missed notes
 * and annotations eligible for the next successful update (#63).
 *
 * Before this, `ownWordsCatchUp()` swallowed a failed child census and `updateIncremental()`
 * stamped the newer library version anyway. Every later comparison used that stamp
 * (`version > since`), so an edited note kept its OLD text searchable and an added note was
 * never indexed, until a rebuild or an unrelated change happened to force a re-read. Worse,
 * when the census crawl itself failed, the degraded source answered every item with no own
 * words at all and the update replaced the indexed text with that nothing.
 *
 * The rule now: own-words work that did not complete withholds the version stamp, exactly
 * as an unreconciled deletion pass does, and a degraded census replaces nothing. The status
 * says so in one sentence, and the next update repeats the delta and retries.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

const CHILD_CENSUS = 'note || annotation';

interface Row {
  key: string;
  version: number;
  data: any;
}

/** A Zotero library with children in it, each write moving the library's one version sequence. */
class FakeLibrary {
  version = 0;
  readonly rows = new Map<string, Row>();

  private write(key: string, data: any): void {
    this.version++;
    this.rows.set(key, { key, version: this.version, data: { key, ...data } });
  }

  item(key: string, title: string, abstractNote = ''): void {
    this.write(key, { itemType: 'journalArticle', title, abstractNote });
  }

  attachment(key: string, parentItem: string): void {
    this.write(key, { itemType: 'attachment', title: 'PDF', parentItem });
  }

  note(key: string, parentItem: string, note: string): void {
    this.write(key, { itemType: 'note', note, parentItem });
  }

  annotation(key: string, parentItem: string, text: string, comment = ''): void {
    this.write(key, {
      itemType: 'annotation',
      annotationType: 'highlight',
      annotationText: text,
      annotationComment: comment,
      parentItem,
    });
  }

  private matching(q: any): Row[] {
    let rows = [...this.rows.values()];
    if (q.itemType) {
      const types = String(q.itemType).split('||').map((t) => t.trim());
      rows = rows.filter((r) => types.includes(r.data.itemType));
    }
    if (q.itemKey) {
      const keys = String(q.itemKey).split(',');
      rows = rows.filter((r) => keys.includes(r.key));
    }
    if (q.top) rows = rows.filter((r) => !r.data.parentItem);
    if (q.since) rows = rows.filter((r) => r.version > q.since);
    return rows;
  }

  router() {
    return {
      servesLocally: vi.fn(() => false),
      defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
      searchItems: vi.fn(async (q: any) => {
        const rows = this.matching(q);
        const start = q.start ?? 0;
        return {
          data: rows.slice(start, start + (q.limit ?? PAGE_SIZE)).map((r) => ({ key: r.key, data: r.data })),
          totalResults: rows.length,
          lastModifiedVersion: this.version,
        };
      }),
      itemVersions: vi.fn(async (q: any) => {
        const rows = this.matching(q);
        const start = q.start ?? 0;
        const page = rows.slice(start, start + (q.limit ?? 5000));
        return {
          versions: Object.fromEntries(page.map((r) => [r.key, r.version])),
          totalResults: rows.length,
          lastModifiedVersion: this.version,
        };
      }),
      fullTextSince: vi.fn(async () => ({})),
      getFullText: vi.fn(async () => null),
    };
  }
}

type Router = ReturnType<FakeLibrary['router']>;

/** Make one router read throw exactly once, for the requests `when` picks out; the rest answer as before. */
function failOnce(router: Router, method: 'searchItems' | 'itemVersions', when: (q: any) => boolean): void {
  // Typed loosely: the two mocks answer with different shapes, and this wraps either.
  const mock: any = router[method];
  const real = mock.getMockImplementation();
  let fired = false;
  mock.mockImplementation(async (q: any) => {
    if (!fired && when(q)) {
      fired = true;
      throw new Error('Zotero 503');
    }
    return real(q);
  });
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 800 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

function makeCtx(search: SearchIndex, router: any): any {
  return { config: loadConfig({} as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

async function keys(search: SearchIndex, q: string): Promise<string[]> {
  return (await search.query(q, { mode: 'keyword' })).map((h) => h.itemKey);
}

/** An indexed library: one annotated item, one noted item, one bare item. */
async function indexed(backend: 'memory' | 'sqlite', extraAnnotations = 0) {
  const lib = new FakeLibrary();
  lib.item('AAAAAAAA', 'Coastal erosion', 'shoreline retreat rates');
  lib.attachment('ATTACHAA', 'AAAAAAAA');
  lib.annotation('ANNOTAA1', 'ATTACHAA', 'sediment budgets are unreliable', 'this contradicts Nakamura entirely');
  // Enough children to make the census page, for the cases where page two is what fails.
  for (let i = 0; i < extraAnnotations; i++) {
    lib.annotation(`ANNOT${String(i).padStart(3, '0')}`, 'ATTACHAA', `tidal marker ${i}`, 'tidal reasoning');
  }
  lib.item('BBBBBBBB', 'Urban heat', 'city temperature anomalies');
  lib.note('NOTEBBB1', 'BBBBBBBB', '<p>My own objection: the albedo assumption is doing all the work.</p>');
  lib.item('CCCCCCCC', 'Nothing hangs off this one', 'a bare item');
  const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
  const router = lib.router();
  const ctx = makeCtx(search, router);
  startIndexBuild(ctx);
  await settle(search);
  expect(search.buildStatus().libraryVersion).toBe(lib.version);
  return { lib, search, router, ctx, stamp: lib.version };
}

/** The issue's step 2: one note edited and one added, the parent item's version untouched. */
function editAndAddNotes(lib: FakeLibrary): void {
  const itemVersion = lib.rows.get('BBBBBBBB')!.version;
  lib.note('NOTEBBB1', 'BBBBBBBB', '<p>Second thoughts: the ventilation term is the weak one.</p>');
  lib.note('NOTEBBB2', 'BBBBBBBB', '<p>And a fresh worry about the ozone column.</p>');
  expect(lib.rows.get('BBBBBBBB')!.version).toBe(itemVersion);
}

async function update(search: SearchIndex, ctx: any): Promise<void> {
  startIndexUpdate(ctx);
  await settle(search);
  expect(search.buildStatus().state).toBe('done');
}

/** What every failed attempt must leave behind: the old text, the old stamp, and a status that says so. */
async function expectWithheld(search: SearchIndex, stamp: number, cause: RegExp): Promise<void> {
  const s = search.buildStatus();
  expect(s.libraryVersion).toBe(stamp);
  expect(s.ownWordsReason).toMatch(/Notes and annotations were NOT fully caught up/);
  expect(s.ownWordsReason).toMatch(cause);
  expect(s.ownWordsReason).toMatch(/the next action:"update" repeats this delta/);
  expect(statusSummary(s)).toMatch(/NOT fully caught up/);
}

/** What the successful retry must do: both changes found, the stale text gone, the stamp current. */
async function expectCaughtUp(search: SearchIndex, lib: FakeLibrary): Promise<void> {
  expect(await keys(search, 'ventilation term')).toEqual(['BBBBBBBB']);
  expect(await keys(search, 'ozone column')).toEqual(['BBBBBBBB']);
  expect(await keys(search, 'albedo assumption')).toEqual([]);
  const s = search.buildStatus();
  expect(s.libraryVersion).toBe(lib.version);
  expect(s.ownWordsReason).toBeUndefined();
}

/** And the update after that must be idle: one keys-only request, no census, nothing moved. */
async function expectIdle(search: SearchIndex, ctx: any, router: Router): Promise<void> {
  const before = search.buildStatus();
  router.searchItems.mockClear();
  router.itemVersions.mockClear();
  await update(search, ctx);
  expect(router.searchItems.mock.calls.filter((c: any[]) => c[0].itemType === CHILD_CENSUS)).toHaveLength(0);
  expect(router.itemVersions.mock.calls.filter((c: any[]) => c[0].itemType === CHILD_CENSUS)).toHaveLength(1);
  const after = search.buildStatus();
  expect(after.libraryVersion).toBe(before.libraryVersion);
  expect(after.ownWordsPassages).toBe(before.ownWordsPassages);
  expect(after.ownWordsReason).toBeUndefined();
}

describe.each(backends)('a failed own-words catch-up is retried by the next update (%s backend)', (backend) => {
  it('the issue: a one-shot failure of the child versions request no longer strands the edit and the addition', async () => {
    const { lib, search, router, ctx, stamp } = await indexed(backend);
    editAndAddNotes(lib);
    failOnce(router, 'itemVersions', (q) => q.itemType === CHILD_CENSUS);

    await update(search, ctx);
    // The item delta and the live-key census succeeded, and the update still reports done;
    // but the stamp did not move past the children it could not compare.
    await expectWithheld(search, stamp, /could not be listed \(Zotero 503\)/);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);
    expect(await keys(search, 'ventilation term')).toEqual([]);

    // Nothing changes in the library; the retry alone must heal it.
    await update(search, ctx);
    await expectCaughtUp(search, lib);
    expect(search.buildStatus().ownWordsPassages).toBe(3);

    await expectIdle(search, ctx, router);
    await search.close();
  });

  it('a failed note-body read keeps the old text rather than replacing it with nothing', async () => {
    const { lib, search, router, ctx, stamp } = await indexed(backend);
    editAndAddNotes(lib);
    // The keys-only question answers fine and names the edited note; the census that reads
    // the bodies is what fails. The degraded source answered "no own words" for every item,
    // and the old code indexed that answer over the text it already held.
    failOnce(router, 'searchItems', (q) => q.itemType === CHILD_CENSUS);

    await update(search, ctx);
    await expectWithheld(search, stamp, /could not be listed \(Zotero 503\)/);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);
    expect(search.buildStatus().ownWordsPassages).toBe(2);

    await update(search, ctx);
    await expectCaughtUp(search, lib);
    await expectIdle(search, ctx, router);
    await search.close();
  });

  it('a failed parent-attribution read keeps the annotations it could not attribute', async () => {
    const { lib, search, router, ctx, stamp } = await indexed(backend);
    // One annotation edited and one added, on an attachment whose item never moved. The
    // census crawl succeeds; resolving the annotated attachment to its item is what fails,
    // which used to drop every annotation on it from the answer and then from the index.
    lib.annotation('ANNOTAA1', 'ATTACHAA', 'sediment budgets are unreliable', 'on reflection Nakamura was right');
    lib.annotation('ANNOTAA2', 'ATTACHAA', 'the 1998 survey', 'worth checking against the raw bathymetry');
    failOnce(router, 'searchItems', (q) => q.itemType === 'attachment');

    await update(search, ctx);
    await expectWithheld(search, stamp, /annotated attachment\(s\) could not be resolved to their items \(Zotero 503\)/);
    expect(await keys(search, 'contradicts entirely')).toEqual(['AAAAAAAA']);
    expect(await keys(search, 'raw bathymetry')).toEqual([]);

    await update(search, ctx);
    expect(await keys(search, 'Nakamura was right')).toEqual(['AAAAAAAA']);
    expect(await keys(search, 'raw bathymetry')).toEqual(['AAAAAAAA']);
    // Words only the old comment had: keyword search matches any term, so the query must
    // not share one with the replacement.
    expect(await keys(search, 'contradicts entirely')).toEqual([]);
    expect(search.buildStatus().libraryVersion).toBe(lib.version);
    expect(search.buildStatus().ownWordsReason).toBeUndefined();
    await expectIdle(search, ctx, router);
    await search.close();
  });

  it('a census that stopped early is a failed read, not a library with fewer notes in it', async () => {
    // 102 children, so the census pages; page two is what fails.
    const { lib, search, router, ctx, stamp } = await indexed(backend, 100);
    editAndAddNotes(lib);
    failOnce(router, 'searchItems', (q) => q.itemType === CHILD_CENSUS && (q.start ?? 0) > 0);

    await update(search, ctx);
    await expectWithheld(search, stamp, /stopped early after \d+ parent\(s\) \(Zotero 503\)/);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);
    expect(search.buildStatus().ownWordsPassages).toBe(102);

    await update(search, ctx);
    await expectCaughtUp(search, lib);
    expect(search.buildStatus().ownWordsPassages).toBe(103);
    await expectIdle(search, ctx, router);
    await search.close();
  });

  it('a changed item keeps its own words through the upsert when the census cannot be read', async () => {
    const { lib, search, router, ctx, stamp } = await indexed(backend);
    // The item itself is in the delta this time, so the update replaces it wholesale and
    // must read its own words back from the census, which is down.
    lib.item('BBBBBBBB', 'Urban heat islands revisited', 'city temperature anomalies');
    failOnce(router, 'searchItems', (q) => q.itemType === CHILD_CENSUS);

    await update(search, ctx);
    await expectWithheld(search, stamp, /could not be listed \(Zotero 503\)/);
    // The metadata that could be read was refreshed; the note that could not was kept.
    expect(await keys(search, 'islands revisited')).toEqual(['BBBBBBBB']);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);
    expect(search.buildStatus().ownWordsPassages).toBe(2);
    expect(search.buildStatus().itemsFetched).toBe(1);

    await update(search, ctx);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);
    expect(search.buildStatus().ownWordsPassages).toBe(2);
    expect(search.buildStatus().libraryVersion).toBe(lib.version);
    expect(search.buildStatus().ownWordsReason).toBeUndefined();
    await expectIdle(search, ctx, router);
    await search.close();
  });

  it('a library reporting no children at all withholds the stamp too, so the retry sees them', async () => {
    const { lib, search, router, ctx, stamp } = await indexed(backend);
    editAndAddNotes(lib);
    const real = router.itemVersions.getMockImplementation()!;
    let fired = false;
    router.itemVersions.mockImplementation(async (q: any) => {
      if (!fired && q.itemType === CHILD_CENSUS) {
        fired = true;
        return { versions: {}, totalResults: 0, lastModifiedVersion: lib.version };
      }
      return real(q);
    });

    await update(search, ctx);
    await expectWithheld(search, stamp, /reported no notes or annotations at all/);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);

    await update(search, ctx);
    await expectCaughtUp(search, lib);
    await search.close();
  });

  it('an access that throws while reading or attributing is handled the same way, without failing the delta', async () => {
    const { lib, search, stamp } = await indexed(backend);
    editAndAddNotes(lib);
    const live = new Map(
      [...lib.rows.values()]
        .filter((r) => r.data.parentItem && r.data.itemType !== 'attachment')
        .map((r) => [r.key, r.version]),
    );
    const top = new Set(['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']);
    const drive = (ownWords: OwnWordsAccess) =>
      search.updateIncremental({
        backend: 'cloud',
        fetchChanged: async () => ({ items: [], totalResults: 0, lastModifiedVersion: lib.version }),
        liveKeys: async () => top,
        ownWords,
      });

    // The body of the edited note cannot be read: nothing is cleared, the stamp stays.
    let s = await drive({
      childVersions: async () => live,
      itemsFor: async () => new Set(),
      textsFor: async () => {
        throw new Error('census exploded');
      },
    });
    expect(s.state).toBe('done');
    expect(s.libraryVersion).toBe(stamp);
    expect(s.ownWordsReason).toMatch(/could not be read \(census exploded\)/);
    expect(await keys(search, 'albedo assumption')).toEqual(['BBBBBBBB']);

    // The added note cannot be attributed: same outcome.
    s = await drive({
      childVersions: async () => live,
      itemsFor: async () => {
        throw new Error('attribution exploded');
      },
      textsFor: async () => [{ key: 'NOTEBBB1', kind: 'note', text: 'the ventilation term is the weak one' }],
    });
    expect(s.state).toBe('done');
    expect(s.libraryVersion).toBe(stamp);
    expect(s.ownWordsReason).toMatch(/could not be attributed to their items \(attribution exploded\)/);

    // A working access catches everything up and the stamp advances.
    s = await drive({
      childVersions: async () => live,
      itemsFor: async () => new Set(['BBBBBBBB']),
      textsFor: async () => [
        { key: 'NOTEBBB1', kind: 'note', text: 'the ventilation term is the weak one' },
        { key: 'NOTEBBB2', kind: 'note', text: 'a fresh worry about the ozone column' },
      ],
    });
    expect(s.libraryVersion).toBe(lib.version);
    expect(s.ownWordsReason).toBeUndefined();
    expect(await keys(search, 'ozone column')).toEqual(['BBBBBBBB']);
    expect(await keys(search, 'albedo assumption')).toEqual([]);
    await search.close();
  });
});

describe('a build over a census that stopped early says so', () => {
  it('reports the gap on the status instead of looking complete', async () => {
    const lib = new FakeLibrary();
    lib.item('AAAAAAAA', 'Coastal erosion', 'shoreline retreat rates');
    lib.attachment('ATTACHAA', 'AAAAAAAA');
    for (let i = 0; i < 101; i++) lib.annotation(`ANNOT${String(i).padStart(3, '0')}`, 'ATTACHAA', `tidal marker ${i}`);
    lib.item('BBBBBBBB', 'Urban heat', 'city temperature anomalies');
    lib.note('NOTEBBB1', 'BBBBBBBB', '<p>the albedo assumption is doing all the work</p>');
    const router = lib.router();
    failOnce(router, 'searchItems', (q) => q.itemType === CHILD_CENSUS && (q.start ?? 0) > 0);
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: '' });
    startIndexBuild(makeCtx(search, router));
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    // What page one delivered is indexed; what page two would have is not, and the status
    // says so rather than reporting an index that quietly lacks it.
    expect(s.ownWordsPassages).toBe(100);
    expect(s.ownWordsReason).toMatch(/stopped early after 1 parent\(s\) \(Zotero 503\)/);
    expect(s.ownWordsReason).toMatch(/Re-run zotero_index action:"build"/);
    await search.close();
  });
});
