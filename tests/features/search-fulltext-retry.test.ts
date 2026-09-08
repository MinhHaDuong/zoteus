import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate, statusSummary } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * A transient attachment read during `action:"update"` must not cost an item its body
 * passages, and must not be stamped past (#67).
 *
 * This is #63 one lane over. `fulltextForPage` caught per item and returned `undefined`,
 * which is the same answer an item with no extracted text gives, so the upsert
 * (`deleteItem` + `addOneItem`) dropped the body text the index held and the stamp advanced
 * anyway. The attachment did not change in Zotero, so the item appeared in no later delta
 * and `/fulltext?since=` would not name it either: its body stayed unsearchable until a
 * full `action:"refresh"`. The catch-up had the matching hole, stepping over items whose
 * read failed while returning the advanced cursor.
 *
 * The rule now: a read that FAILED is told apart from an item with no text (the source
 * throws instead of answering `undefined`), what the index holds is put back through the
 * upsert, and the sequence that would have to offer the item again is held back. A gap on
 * the delta's own items withholds the version stamp; a gap in the catch-up withholds the
 * full-text cursor.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

const BODY_ONE = 'The ablation removes the recurrent gate entirely. '.repeat(20);
const BODY_TWO = 'Perovskite tandem cells degrade under sustained illumination. '.repeat(20);

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

  /** Zotero extracts the PDF: the full-text sequence moves and the item sequence does not. */
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

type Router = ReturnType<FakeZotero['router']>;

/** Make one attachment's body read throw exactly once; every other read answers as before. */
function failOnce(router: Router, attachment: string): void {
  const mock: any = router.getFullText;
  const real = mock.getMockImplementation();
  let fired = false;
  mock.mockImplementation(async (key: string) => {
    if (!fired && key === attachment) {
      fired = true;
      throw new Error('Zotero 503');
    }
    return real(key);
  });
}

function makeCtx(search: SearchIndex, router: any): any {
  return { config: loadConfig({} as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

async function keys(search: SearchIndex, q: string): Promise<string[]> {
  return (await search.query(q, { mode: 'keyword' })).map((h) => h.itemKey);
}

async function update(search: SearchIndex, ctx: any): Promise<void> {
  startIndexUpdate(ctx, undefined, undefined, { fulltext: true, ownWords: false });
  await settle(search);
  expect(search.buildStatus().state).toBe('done');
}

/** Two items, both PDFs read by Zotero, both bodies indexed. */
async function indexed(backend: 'memory' | 'sqlite') {
  const zotero = new FakeZotero();
  zotero.putItem('K1', 'Deep learning', 'convolutional networks classify images');
  zotero.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
  zotero.attach('ATT1', 'K1');
  zotero.attach('ATT2', 'K2');
  zotero.extract('ATT1', BODY_ONE);
  const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
  const router = zotero.router();
  const ctx = makeCtx(search, router);
  startIndexBuild(ctx, undefined, undefined, { fulltext: true, ownWords: false });
  await settle(search);
  const s = search.buildStatus();
  expect(s.fulltextItems).toBe(1);
  expect(s.libraryVersion).toBe(zotero.itemVersion);
  expect(await keys(search, 'recurrent gate ablation')).toEqual(['K1']);
  return { zotero, search, router, ctx, stamp: s.libraryVersion, cursor: s.fulltextVersion, passages: s.fulltextPassages };
}

describe.each(backends)('a failed attachment read is retried by the next update (%s backend)', (backend) => {
  it('the issue: a changed item keeps its body passages, and the stamp waits for them', async () => {
    const { zotero, search, router, ctx, stamp, passages } = await indexed(backend);
    // The reader edits K1's metadata in Zotero, so K1 enters the delta. Its PDF is untouched
    // and its extracted text is older than the full-text cursor, so this delta is the only
    // thing that will ever bring K1 back.
    zotero.putItem('K1', 'Deep learning revisited', 'convolutional networks classify images');
    failOnce(router, 'ATT1');

    await update(search, ctx);

    // The metadata that could be read was refreshed; the body that could not was kept.
    expect(await keys(search, 'revisited')).toEqual(['K1']);
    expect(await keys(search, 'recurrent gate ablation')).toEqual(['K1']);
    const s = search.buildStatus();
    expect(s.fulltextPassages).toBe(passages);
    expect(s.fulltextItems).toBe(1);
    expect(s.itemsFetched).toBe(1);
    // And the stamp stayed where it was, so K1 is in the next delta too.
    expect(s.libraryVersion).toBe(stamp);
    expect(s.fulltextReason).toMatch(/Attachment full text was NOT fully updated for 1 item\(s\)/);
    expect(s.fulltextReason).toMatch(/could not be read \(Zotero 503\)/);
    expect(s.fulltextReason).toMatch(/version stamp stayed at cloud library version/);
    expect(statusSummary(s)).toMatch(/NOT fully updated/);

    // Nothing changes in the library; the retry alone must heal it.
    await update(search, ctx);
    const after = search.buildStatus();
    expect(after.libraryVersion).toBe(zotero.itemVersion);
    expect(after.fulltextReason).toBeUndefined();
    expect(after.fulltextPassages).toBe(passages);
    expect(await keys(search, 'recurrent gate ablation')).toEqual(['K1']);
    expect(await keys(search, 'revisited')).toEqual(['K1']);
    await search.close();
  });

  it('a failed catch-up read leaves the full-text cursor where it was', async () => {
    const { zotero, search, router, ctx, cursor } = await indexed(backend);
    // The other sequence: the reader opens K2's PDF, which Zotero extracts. No item version
    // moves, so only the cursor can ever bring this text in.
    zotero.extract('ATT2', BODY_TWO);
    expect(zotero.fulltextVersion).toBeGreaterThan(cursor);
    failOnce(router, 'ATT2');

    await update(search, ctx);

    const s = search.buildStatus();
    expect(s.fulltextVersion).toBe(cursor);
    expect(s.fulltextItems).toBe(1);
    expect(await keys(search, 'perovskite illumination degrade')).toEqual([]);
    expect(s.fulltextReason).toMatch(/newly extracted attachment text could not be read \(Zotero 503\)/);
    expect(s.fulltextReason).toMatch(/full-text cursor stayed at/);
    // The item delta itself succeeded, so the stamp is free to move.
    expect(s.libraryVersion).toBe(zotero.itemVersion);

    await update(search, ctx);
    const after = search.buildStatus();
    expect(after.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(after.fulltextItems).toBe(2);
    expect(after.fulltextReason).toBeUndefined();
    expect(await keys(search, 'perovskite illumination degrade')).toEqual(['K2']);
    await search.close();
  });

  it('a source that could not open at all replaces nothing and withholds both', async () => {
    const { zotero, search, router, ctx, stamp, cursor, passages } = await indexed(backend);
    zotero.putItem('K1', 'Deep learning revisited', 'convolutional networks classify images');
    zotero.extract('ATT2', BODY_TWO);
    // The census behind the attachment map is what fails here, so the source opens holding
    // nothing: every item looks like an item with no extracted text at all.
    router.fullTextSince.mockRejectedValueOnce(new Error('403 Forbidden'));

    await update(search, ctx);

    const s = search.buildStatus();
    expect(await keys(search, 'recurrent gate ablation')).toEqual(['K1']);
    expect(s.fulltextPassages).toBe(passages);
    expect(s.libraryVersion).toBe(stamp);
    expect(s.fulltextVersion).toBe(cursor);
    expect(s.fulltextReason).toMatch(/full-text index could not be listed: 403 Forbidden/);

    await update(search, ctx);
    const after = search.buildStatus();
    expect(after.libraryVersion).toBe(zotero.itemVersion);
    expect(after.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(after.fulltextReason).toBeUndefined();
    expect(await keys(search, 'recurrent gate ablation')).toEqual(['K1']);
    expect(await keys(search, 'perovskite illumination degrade')).toEqual(['K2']);
    await search.close();
  });

  it('an update whose reads all succeed advances both, and the next one is idle', async () => {
    const { zotero, search, router, ctx, passages } = await indexed(backend);
    zotero.putItem('K1', 'Deep learning revisited', 'convolutional networks classify images');
    zotero.extract('ATT2', BODY_TWO);

    await update(search, ctx);
    const s = search.buildStatus();
    expect(s.libraryVersion).toBe(zotero.itemVersion);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.fulltextReason).toBeUndefined();
    expect(s.fulltextPassages).toBeGreaterThan(passages);
    expect(await keys(search, 'perovskite illumination degrade')).toEqual(['K2']);

    // Nothing moved since: one empty delta, one probe, and no body read at all.
    router.getFullText.mockClear();
    await update(search, ctx);
    const after = search.buildStatus();
    expect(router.getFullText).not.toHaveBeenCalled();
    expect(after.itemsFetched).toBe(0);
    expect(after.libraryVersion).toBe(s.libraryVersion);
    expect(after.fulltextVersion).toBe(s.fulltextVersion);
    expect(after.fulltextPassages).toBe(s.fulltextPassages);
    expect(after.fulltextReason).toBeUndefined();
    await search.close();
  });
});

describe('the SQLite backend keeps its FTS5 index honest through a kept body', () => {
  const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

  sqliteIt('passes an integrity check after body passages survive an upsert', async () => {
    const { zotero, search, router, ctx } = await indexed('sqlite');
    zotero.putItem('K1', 'Deep learning revisited', 'convolutional networks classify images');
    failOnce(router, 'ATT1');
    await update(search, ctx);

    // The passages were deleted and put back through the same external-content protocol, or
    // this throws: FTS5 verifies that every indexed term still resolves to a content row.
    const db = (search as any).db;
    expect(() => db.exec("INSERT INTO passages_fts(passages_fts) VALUES('integrity-check')")).not.toThrow();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM passages_fts').get().n)).toBe(search.buildStatus().documents);
    expect(await keys(search, 'recurrent gate ablation')).toEqual(['K1']);
    await search.close();
  });
});
