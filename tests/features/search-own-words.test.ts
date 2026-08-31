import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate, statusSummary } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * The reader's own words in the index: child notes and PDF annotations (#33).
 *
 * Every index crawl asked for `top: true`, so the corpus was the library's top-level items
 * and nothing hanging off them. Once `zotero_annotate` shipped that stopped being a
 * coverage gap and became a disagreement inside the server: Zoteus wrote an annotation onto
 * an attachment and could not then find it, on any query, ever. These cases pin the whole
 * of the answer — that a note and an annotation are indexed under the ITEM they belong to
 * (an annotation through the attachment it sits on, which is the only key it names), that
 * an item with many of them is still one search result, and that an update keeps them
 * current, including the deletion no `?since=` can report.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

interface Row {
  key: string;
  version: number;
  data: any;
}

/**
 * A Zotero library with children in it: items, their attachments, the notes hanging off
 * items and the annotations hanging off attachments — each with its own version in the
 * library's one sequence, which is what makes the update path testable at all.
 */
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

  standaloneNote(key: string, note: string): void {
    this.write(key, { itemType: 'note', note });
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

  remove(key: string): void {
    this.version++;
    this.rows.delete(key);
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
    // `/items/top` is the crawl a build makes: regular items and standalone notes, never
    // anything with a parent.
    if (q.top) rows = rows.filter((r) => !r.data.parentItem);
    if (q.since) rows = rows.filter((r) => r.version > q.since);
    return rows;
  }

  /** Router double: only the reads a build and an update make. */
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

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 800 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

function makeCtx(search: SearchIndex, router: any, env: Record<string, string> = {}): any {
  return { config: loadConfig(env as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

/** A library with one annotated, one noted and one bare item, indexed. */
async function indexed(backend: 'memory' | 'sqlite', env: Record<string, string> = {}) {
  const lib = new FakeLibrary();
  lib.item('AAAAAAAA', 'Coastal erosion', 'shoreline retreat rates');
  lib.attachment('ATTACHAA', 'AAAAAAAA');
  lib.annotation('ANNOTAA1', 'ATTACHAA', 'sediment budgets are unreliable', 'this contradicts Nakamura entirely');
  lib.item('BBBBBBBB', 'Urban heat', 'city temperature anomalies');
  lib.note('NOTEBBB1', 'BBBBBBBB', '<div class="zotero-note"><p>My own <strong>objection</strong>: the albedo assumption is doing all the work.</p></div>');
  lib.item('CCCCCCCC', 'Nothing hangs off this one', 'a bare item');
  const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
  const router = lib.router();
  const ctx = makeCtx(search, router, env);
  startIndexBuild(ctx);
  await settle(search);
  return { lib, search, router, ctx };
}

describe.each(backends)('the reader\'s own words (%s backend)', (backend) => {
  it('finds an item by the comment written on its PDF, which is what zotero_annotate writes', async () => {
    const { search } = await indexed(backend);
    const hits = await search.query('contradicts Nakamura', { mode: 'keyword' });
    expect(hits.map((h) => h.itemKey)).toEqual(['AAAAAAAA']);
    // The hit is attributed to the ITEM, titled as the item, and says where it came from.
    expect(hits[0]!.title).toBe('Coastal erosion');
    expect(hits[0]!.source).toBe('annotation');
    await search.close();
  });

  it('finds an item by a child note, with the HTML stripped out of it', async () => {
    const { search } = await indexed(backend);
    const hits = await search.query('albedo assumption', { mode: 'keyword' });
    expect(hits.map((h) => h.itemKey)).toEqual(['BBBBBBBB']);
    expect(hits[0]!.source).toBe('note');
    // The markup is not indexed text: searching for it finds nothing, and no snippet carries it.
    expect(await search.query('zotero-note strong', { mode: 'keyword' })).toEqual([]);
    expect(hits[0]!.snippet).not.toMatch(/</);
    await search.close();
  });

  it('counts them apart from everything else, and says so on the status', async () => {
    const { search } = await indexed(backend);
    const s = search.buildStatus();
    expect(s.ownWordsEnabled).toBe(true);
    expect(s.ownWordsItems).toBe(2);
    expect(s.ownWordsPassages).toBe(2);
    expect(s.ownWordsReason).toBeUndefined();
    expect(statusSummary(s)).toMatch(/notes and annotations of 2 of them \(2 passages\)/);
    await search.close();
  });

  it('keeps an item with many annotations to one result slot', async () => {
    const lib = new FakeLibrary();
    lib.item('AAAAAAAA', 'Coastal erosion', 'shoreline retreat');
    lib.attachment('ATTACHAA', 'AAAAAAAA');
    for (let i = 0; i < 12; i++) lib.annotation(`ANNOT${String(i).padStart(3, '0')}`, 'ATTACHAA', `tidal marker ${i}`, 'tidal reasoning');
    lib.item('BBBBBBBB', 'Tidal flats', 'tidal reasoning appears here too');
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
    const ctx = makeCtx(search, lib.router());
    startIndexBuild(ctx);
    await settle(search);

    const hits = await search.query('tidal reasoning', { mode: 'keyword' });
    // Twelve annotations, one slot — and the other item is not pushed off the page by them.
    expect(hits.filter((h) => h.itemKey === 'AAAAAAAA')).toHaveLength(1);
    expect(hits.map((h) => h.itemKey).sort()).toEqual(['AAAAAAAA', 'BBBBBBBB']);
    expect(search.buildStatus().ownWordsPassages).toBe(12);
    await search.close();
  });

  it('does not index a standalone note twice: it is a top-level item already', async () => {
    const lib = new FakeLibrary();
    lib.standaloneNote('NOTESOLO', '<p>a thought that belongs to no paper</p>');
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
    startIndexBuild(makeCtx(search, lib.router()));
    await settle(search);

    expect((await search.query('belongs to no paper', { mode: 'keyword' })).map((h) => h.itemKey)).toEqual(['NOTESOLO']);
    expect(search.buildStatus().ownWordsPassages).toBe(0);
    await search.close();
  });

  it('leaves them out when they are turned off', async () => {
    const { search } = await indexed(backend, { ZOTEUS_INDEX_OWN_WORDS: 'false' });
    expect(await search.query('contradicts Nakamura', { mode: 'keyword' })).toEqual([]);
    expect(search.buildStatus().ownWordsPassages).toBe(0);
    await search.close();
  });
});

describe.each(backends)('an update keeps the reader\'s own words current (%s backend)', (backend) => {
  it('finds an annotation added to an item whose own version never moved', async () => {
    const { lib, search, ctx } = await indexed(backend);
    const itemVersionBefore = lib.rows.get('AAAAAAAA')!.version;
    lib.annotation('ANNOTAA2', 'ATTACHAA', 'the 1998 survey', 'worth checking against the raw bathymetry');
    // The point of the case: annotating changed nothing about the item itself, so no
    // `?since=` over /items/top will ever mention it.
    expect(lib.rows.get('AAAAAAAA')!.version).toBe(itemVersionBefore);

    startIndexUpdate(ctx);
    await settle(search);

    const hits = await search.query('raw bathymetry', { mode: 'keyword' });
    expect(hits.map((h) => h.itemKey)).toEqual(['AAAAAAAA']);
    expect(search.buildStatus().updateNotice).toMatch(/1 item\(s\) had their notes and annotations re-indexed/);
    await search.close();
  });

  it('replaces an edited note rather than keeping both versions of it', async () => {
    const { lib, search, ctx } = await indexed(backend);
    lib.note('NOTEBBB1', 'BBBBBBBB', '<p>Second thoughts: the ventilation term is the weak one.</p>');

    startIndexUpdate(ctx);
    await settle(search);

    expect((await search.query('ventilation term', { mode: 'keyword' })).map((h) => h.itemKey)).toEqual(['BBBBBBBB']);
    expect(await search.query('albedo assumption', { mode: 'keyword' })).toEqual([]);
    expect(search.buildStatus().ownWordsPassages).toBe(2);
    await search.close();
  });

  it('removes a deleted note, which no version anywhere reports', async () => {
    const { lib, search, ctx } = await indexed(backend);
    lib.remove('NOTEBBB1');

    startIndexUpdate(ctx);
    await settle(search);

    expect(await search.query('albedo assumption', { mode: 'keyword' })).toEqual([]);
    // The item itself is untouched: only its own words went.
    expect((await search.query('temperature anomalies', { mode: 'keyword' })).map((h) => h.itemKey)).toEqual(['BBBBBBBB']);
    expect(search.buildStatus().ownWordsItems).toBe(1);
    await search.close();
  });

  it('costs one keys-only request when nothing was written or highlighted', async () => {
    const { lib, search, ctx, router } = await indexed(backend);
    // A real library always holds children that yield no passage — an image annotation
    // with no text, a note someone emptied — and they are what an "is everything indexed?"
    // check would trip over on every single update.
    lib.annotation('ANNOTIMG', 'ATTACHAA', '', '');
    startIndexUpdate(ctx);
    await settle(search);
    router.searchItems.mockClear();
    router.itemVersions.mockClear();

    startIndexUpdate(ctx);
    await settle(search);

    // The census that reads note and annotation BODIES is never opened: the keys-only
    // question answered "nothing moved", and that is the whole cost of staying current.
    const childCrawls = router.searchItems.mock.calls.filter((c: any[]) => c[0].itemType === 'note || annotation');
    expect(childCrawls).toHaveLength(0);
    expect(search.buildStatus().ownWordsPassages).toBe(2);
    expect(router.itemVersions.mock.calls.filter((c: any[]) => c[0].itemType === 'note || annotation')).toHaveLength(1);
    await search.close();
  });

  it('keeps them when the library reports no children at all, which is a failed read', async () => {
    const { search, ctx, router } = await indexed(backend);
    const before = search.buildStatus().ownWordsPassages;
    router.itemVersions.mockImplementation(async (q: any) => ({
      versions: q.itemType ? {} : { AAAAAAAA: 1, BBBBBBBB: 2, CCCCCCCC: 3 },
      totalResults: q.itemType ? 0 : 3,
      lastModifiedVersion: 99,
    }));

    startIndexUpdate(ctx);
    await settle(search);

    expect(search.buildStatus().ownWordsPassages).toBe(before);
    expect((await search.query('contradicts Nakamura', { mode: 'keyword' })).map((h) => h.itemKey)).toEqual(['AAAAAAAA']);
    await search.close();
  });

  it('fills the gap in an index built before own words existed, once', async () => {
    // Exactly the state a 1.10.0 index is in: items indexed, nothing of the reader's own.
    const { lib, search } = await indexed(backend, { ZOTEUS_INDEX_OWN_WORDS: 'false' });
    expect(search.buildStatus().ownWordsPassages).toBe(0);

    const withOwnWords = makeCtx(search, lib.router());
    startIndexUpdate(withOwnWords);
    await settle(search);

    expect((await search.query('contradicts Nakamura', { mode: 'keyword' })).map((h) => h.itemKey)).toEqual(['AAAAAAAA']);
    expect(search.buildStatus().ownWordsItems).toBe(2);

    // And it is a one-off: the next update has nothing left to do about them.
    const router = withOwnWords.router;
    router.searchItems.mockClear();
    startIndexUpdate(withOwnWords);
    await settle(search);
    expect(router.searchItems.mock.calls.filter((c: any[]) => c[0].itemType === 'note || annotation')).toHaveLength(0);
    await search.close();
  });

  it('drops the own words of an item the library no longer holds', async () => {
    const { lib, search, ctx } = await indexed(backend);
    lib.remove('AAAAAAAA');
    lib.remove('ATTACHAA');
    lib.remove('ANNOTAA1');

    startIndexUpdate(ctx);
    await settle(search);

    expect(await search.query('contradicts Nakamura', { mode: 'keyword' })).toEqual([]);
    expect(search.buildStatus().ownWordsItems).toBe(1);
    await search.close();
  });
});

describe('own words when the library cannot answer', () => {
  it('builds without them and says why, rather than failing the build', async () => {
    const lib = new FakeLibrary();
    lib.item('AAAAAAAA', 'Coastal erosion', 'shoreline retreat rates');
    const router = lib.router();
    router.searchItems.mockImplementation(async (q: any) => {
      if (q.itemType === 'note || annotation') throw new Error('Zotero 503');
      return {
        data: [{ key: 'AAAAAAAA', data: lib.rows.get('AAAAAAAA')!.data }],
        totalResults: 1,
        lastModifiedVersion: lib.version,
      };
    });
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: '' });
    startIndexBuild(makeCtx(search, router));
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(1);
    expect(s.ownWordsReason).toMatch(/could not be listed \(Zotero 503\)/);
    expect(statusSummary(s)).toMatch(/could not be listed/);
    await search.close();
  });
});
