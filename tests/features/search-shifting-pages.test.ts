import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { PAGE_SIZE, startIndexBuild } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { ChunkRecord, SearchIndex } from '../../src/features/search/backend.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * A build on 1.15.0 aborted with `UNIQUE constraint failed: passages.id` about 1,300 items
 * into a 10,500-item library while a second client session was using the same server (#59).
 *
 * Both Zotero APIs page items newest-modified first and the crawl sends no sort of its own,
 * so one item edited by anyone while the crawl is between two pages, another client's
 * annotation, a tag edit, a sync, moves to the front of the list and shifts every later item
 * down by one: the last item of the page just read is served again at the top of the next.
 * The metadata pass only stepped over items a RESUMED build had inherited; on a fresh build
 * the second copy reached the plain INSERT and the constraint on the passage id aborted the
 * whole job. The children census behind the reader's own words is the same kind of crawl
 * and had the same gap. These cases pin both, and the insert path underneath them.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];
const sqliteIt = hasSqlite ? it : it.skip;

interface Row {
  key: string;
  version: number;
  modified: number;
  data: any;
}

/**
 * A Zotero library that pages the way both real APIs do: newest `dateModified` first, one
 * page of PAGE_SIZE at a time, re-sorted on every request, so an edit between two pages
 * shifts the boundary exactly as it does against the desktop app and the cloud.
 */
class ShiftingLibrary {
  version = 0;
  private clock = 0;
  readonly rows = new Map<string, Row>();
  /** Called before every page is answered: the place a concurrent edit is injected. */
  beforePage: ((q: any) => void) | undefined;

  private write(key: string, data: any): void {
    this.version++;
    this.clock++;
    this.rows.set(key, { key, version: this.version, modified: this.clock, data: { key, ...data } });
  }

  item(key: string, title: string, abstractNote = ''): void {
    this.write(key, { itemType: 'journalArticle', title, abstractNote });
  }

  attachment(key: string, parentItem: string): void {
    this.write(key, { itemType: 'attachment', title: 'PDF', parentItem });
  }

  annotation(key: string, parentItem: string, text: string): void {
    this.write(key, { itemType: 'annotation', annotationType: 'highlight', annotationText: text, parentItem });
  }

  /** Edit an item in place: a new version and a new dateModified, which moves it to the front. */
  touch(key: string): void {
    const row = this.rows.get(key);
    if (row) this.write(key, { ...row.data });
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
    // Newest-modified first: the order Zotero pages in when no sort is asked for.
    return rows.sort((a, b) => b.modified - a.modified);
  }

  router() {
    return {
      servesLocally: vi.fn(() => true),
      defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
      searchItems: vi.fn(async (q: any) => {
        this.beforePage?.(q);
        const rows = this.matching(q);
        const start = q.start ?? 0;
        return {
          data: rows.slice(start, start + (q.limit ?? PAGE_SIZE)).map((r) => ({ key: r.key, data: r.data })),
          totalResults: rows.length,
          // The desktop app: no Last-Modified-Version on a page.
          lastModifiedVersion: 0,
        };
      }),
      itemVersions: vi.fn(async (q: any) => {
        const rows = this.matching(q);
        return {
          versions: Object.fromEntries(rows.map((r) => [r.key, r.version])),
          totalResults: rows.length,
          lastModifiedVersion: 0,
        };
      }),
      fullTextSince: vi.fn(async () => ({})),
      getFullText: vi.fn(async () => null),
    };
  }
}

function makeCtx(search: SearchIndex, router: any, env: Record<string, string> = {}): any {
  const config = loadConfig({ ZOTEUS_INDEX_OWN_WORDS: 'false', ...env } as any);
  return { config, search, router, logger: silentLogger, searchIndexPath: '' };
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

async function openIndex(backend: 'memory' | 'sqlite', embedder: EmbeddingProvider | null = null): Promise<SearchIndex> {
  return createSearchIndex({ embedder, logger: silentLogger, backend, jsonPath: '' });
}

/** An embedder that records every text it embeds, so a duplicate is visible as a double embed. */
function countingEmbedder(): { provider: EmbeddingProvider; texts: string[] } {
  const texts: string[] = [];
  const provider: EmbeddingProvider = {
    name: 'counting',
    model: 'fake-model',
    embed: async (batch: string[]) => {
      texts.push(...batch);
      return batch.map((t) => [t.length % 7, 1, 0]);
    },
  };
  return { provider, texts };
}

describe.each(backends)('a crawl whose pages shift under it (%s backend)', (backend) => {
  it('indexes an item the shifted pages served twice once, and finishes', async () => {
    const lib = new ShiftingLibrary();
    for (let i = 0; i < 250; i++) lib.item(`K${String(i).padStart(3, '0')}`, `Item ${i}`, `abstract about topic${i}`);
    // Another client edits an item while the crawl is between its first and second page.
    // The item at the page boundary is then served again at the top of page two.
    lib.beforePage = (q) => {
      if (q.top && q.start === PAGE_SIZE) lib.touch('K010');
    };
    const embedder = countingEmbedder();
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (m: unknown) => void warnings.push(String(m)) };
    const search = await createSearchIndex({ embedder: embedder.provider, logger, backend, jsonPath: '' });
    startIndexBuild(makeCtx(search, lib.router()));
    await settle(search);

    const s = search.buildStatus();
    expect(s.lastError).toBeUndefined();
    expect(s.state).toBe('done');
    // 249, not 250: the edited item jumped to the front of a list the crawl had already
    // passed, so this crawl cannot see it. That is the nature of paging a live library, and
    // its edit is after the crawl's version stamp, so the next update indexes it. What must
    // not happen is the other half: the boundary item, served twice, written twice.
    expect(s.items).toBe(249);
    expect(s.documents).toBe(249);
    expect(new Set(embedder.texts).size).toBe(embedder.texts.length);
    expect(warnings.join('\n')).toMatch(/1 item\(s\) and 0 passage\(s\) were served twice and indexed once/);
    await search.close();
  });

  it('indexes an annotation the children census listed twice once', async () => {
    const lib = new ShiftingLibrary();
    for (let i = 0; i < 3; i++) lib.item(`ITEM000${i}`, `Item ${i}`, `abstract ${i}`);
    lib.attachment('ATTACH00', 'ITEM0001');
    // Enough annotations for the census to page, with a boundary to shift.
    for (let i = 0; i < PAGE_SIZE + 5; i++) lib.annotation(`ANN${String(i).padStart(5, '0')}`, 'ATTACH00', `highlight ${i}`);
    // An annotation is edited while the census is between its pages, so the one at the
    // boundary is listed twice.
    lib.beforePage = (q) => {
      if (String(q.itemType ?? '').includes('annotation') && q.start === PAGE_SIZE) lib.touch('ANN00003');
    };
    const search = await openIndex(backend);
    startIndexBuild(makeCtx(search, lib.router(), { ZOTEUS_INDEX_OWN_WORDS: 'true' }));
    await settle(search);

    const s = search.buildStatus();
    expect(s.lastError).toBeUndefined();
    expect(s.state).toBe('done');
    expect(s.items).toBe(3);
    // PAGE_SIZE + 4: the edited annotation moved ahead of the census the same way an
    // edited item moves ahead of the crawl, and belongs to the next update. The one at the
    // boundary, listed twice, is indexed once.
    expect(s.ownWordsPassages).toBe(PAGE_SIZE + 4);
    expect(s.documents).toBe(3 + PAGE_SIZE + 4);
    await search.close();
  });

  it('stores a passage whose id arrives twice once, and the build goes on', async () => {
    // Straight past the census: an own-words source that hands the same child back twice
    // is the narrowest way to put a duplicate id in front of the insert itself.
    const lib = new ShiftingLibrary();
    lib.item('AAAAAAAA', 'Coastal erosion', 'shoreline retreat');
    lib.item('BBBBBBBB', 'Urban heat', 'city temperature');
    const embedder = countingEmbedder();
    const warnings: string[] = [];
    const logger = { ...silentLogger, warn: (m: unknown) => void warnings.push(String(m)) };
    const search = await createSearchIndex({ embedder: embedder.provider, logger, backend, jsonPath: '' });
    const twice = { key: 'NOTE0001', kind: 'note' as const, text: 'my own objection to the albedo assumption' };
    await search.buildIncremental(
      async (start) => {
        const page = await lib.router().searchItems({ top: true, start, limit: PAGE_SIZE });
        return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: 0 };
      },
      {
        ownWords: {
          childVersions: async () => new Map(),
          itemsFor: async () => new Set(),
          textsFor: async (itemKey) => (itemKey === 'AAAAAAAA' ? [twice, twice] : []),
        },
      },
    );
    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(2);
    // Two metadata passages and ONE note passage: the second copy was skipped, counted,
    // and not embedded.
    expect(s.documents).toBe(3);
    expect(s.ownWordsPassages).toBe(1);
    expect(s.vectors).toBe(3);
    expect(embedder.texts.filter((t) => t === twice.text)).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/0 item\(s\) and 1 passage\(s\) were served twice and indexed once/);
    expect((await search.query('albedo', { limit: 5 }))[0]!.itemKey).toBe('AAAAAAAA');
    await search.close();
  });
});

describe('the SQLite insert path', () => {
  sqliteIt('never leaves a half-written item behind when an insert fails partway through it', async () => {
    const { SqliteSearchIndex } = await import('../../src/features/search/sqlite-index.js');
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-half-item-'));
    const path = sqliteIndexPath(join(dir, 'search-index.json'));
    /** Refuses the SECOND chunk of one long item, once: a constraint or an I/O fault mid-item. */
    class Faulty extends SqliteSearchIndex {
      failures = 0;
      protected override putPassage(rec: ChunkRecord): boolean {
        if (rec.id === 'K005#1' && this.failures++ === 0) throw new Error('simulated constraint failure');
        return super.putPassage(rec);
      }
    }
    const lib = new ShiftingLibrary();
    for (let i = 0; i < 12; i++) {
      // K005 is long enough to chunk twice, so a failure can land between its passages.
      lib.item(`K${String(i).padStart(3, '0')}`, `Item ${i}`, i === 5 ? 'word '.repeat(300) : `abstract ${i}`);
    }
    const fetchPage = async (start: number) => {
      const page = await lib.router().searchItems({ top: true, start, limit: PAGE_SIZE });
      return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: 0 };
    };

    const first = new Faulty({ embedder: null, logger: silentLogger, path });
    await first.open();
    const failed = await first.buildIncremental(fetchPage, {});
    expect(failed.state).toBe('error');
    expect(failed.lastError).toContain('simulated constraint failure');
    // The item the failure landed in is absent as a whole, not present with one chunk of
    // two: what is committed is complete items only, so nothing can be stepped over later
    // as if it were finished. The build stops there, as it always did, with the six items
    // the crawl (newest first) had completed before it.
    expect((await first.query('word', { limit: 3 })).map((h) => h.itemKey)).toEqual([]);
    expect(first.buildStatus().items).toBe(6);
    expect(first.buildStatus().documents).toBe(6);
    await first.save();
    await first.close();

    // And the resumed build indexes it, both chunks.
    const resumed = new Faulty({ embedder: null, logger: silentLogger, path });
    resumed.failures = 1;
    await resumed.open();
    const done = await resumed.buildIncremental(fetchPage, {});
    expect(done.state).toBe('done');
    expect(done.items).toBe(12);
    // Eleven single-passage items plus every chunk of the long one, whole this time.
    expect(done.documents).toBeGreaterThan(12);
    expect((await resumed.query('word', { limit: 3 })).map((h) => h.itemKey)).toEqual(['K005']);
    await resumed.close();
  });
});
