import { describe, it, expect, vi } from 'vitest';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import {
  createOwnWordsSource,
  DEFAULT_OWN_WORDS_MAX_CHARS,
  type OwnWords,
} from '../../src/features/search/own-words-source.js';
import { startIndexBuild, startIndexUpdate, statusSummary, PAGE_SIZE } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Sentences that share no vocabulary with any item's metadata, so a hit on one is
 * attributable to the note or the annotation it came from and to nothing else.
 */
const NOTE_TEXT = 'The estimator collapses whenever the instrument is weak in the second stage.';
const COMMENT = 'This contradicts what Ostrom argued about polycentric governance.';
const HIGHLIGHT = 'Groundwater basins were governed without a central authority for four decades.';

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));
}

function pager(library: any[], pageSize = 100) {
  return async (start: number) => ({ items: library.slice(start, start + pageSize), totalResults: library.length });
}

describe('SearchIndex own-words passages', () => {
  it('indexes a child note and attributes the hit to the item it hangs off', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(3)), {
      ownWordsFor: async (key) => (key === 'K1' ? [{ kind: 'note', text: NOTE_TEXT }] : []),
    });

    expect(final.ownWordsItems).toBe(1);
    expect(final.ownWordsPassages).toBe(1);
    expect(final.documents).toBe(4); // 3 metadata passages + the note

    const hits = await search.query('weak instrument second stage', { limit: 3 });
    expect(hits[0]!.itemKey).toBe('K1');
    expect(hits[0]!.source).toBe('note');
    expect(hits[0]!.title).toBe('Item 1'); // the item's title, not the note's
  });

  it('indexes an annotation under its own label, distinct from body text', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await search.buildIncremental(pager(makeLibrary(2)), {
      ownWordsFor: async (key) => (key === 'K0' ? [{ kind: 'annotation', text: `${COMMENT}\n\n${HIGHLIGHT}` }] : []),
      fulltextFor: async (key) => (key === 'K1' ? 'A body of prose about sedimentary layering.' : undefined),
    });

    const onComment = await search.query('Ostrom polycentric governance', { limit: 1 });
    expect(onComment[0]!.itemKey).toBe('K0');
    expect(onComment[0]!.source).toBe('annotation');

    // The highlighted passage is searchable too: it is what the reader chose to keep.
    const onHighlight = await search.query('groundwater basins central authority', { limit: 1 });
    expect(onHighlight[0]!.itemKey).toBe('K0');

    // And body text keeps its own label, so the three kinds stay distinguishable.
    const body = await search.query('sedimentary layering', { limit: 1 });
    expect(body[0]!.source).toBe('fulltext');
  });

  it('extends the corpus without displacing the item it belongs to', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    // Forty annotations on one item, all matching the query: the pathological case for
    // "own words dilute the results".
    const many: OwnWords[] = Array.from({ length: 40 }, (_, i) => ({
      kind: 'annotation' as const,
      text: `${HIGHLIGHT} Marginal remark number ${i}.`,
    }));
    await search.buildIncremental(pager(makeLibrary(5)), {
      ownWordsFor: async (key) => (key === 'K3' ? many : []),
    });

    const hits = await search.query('groundwater basins central authority', { limit: 10 });
    // One place in the result list, not forty: hits are de-duplicated by item.
    expect(hits.filter((h) => h.itemKey === 'K3')).toHaveLength(1);

    // And an item's own metadata still answers a metadata query — the annotated item has
    // not crowded the others out of the ranking.
    const meta = await search.query('topic2', { limit: 1 });
    expect(meta[0]!.itemKey).toBe('K2');
    expect(meta[0]!.source).toBeUndefined();
  });

  it('reports zero own words for a library whose reader wrote none', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(2)));
    expect(final.ownWordsItems).toBe(0);
    expect(final.ownWordsPassages).toBe(0);
  });

  it('round-trips own-words passages through persistence', async () => {
    const a = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await a.buildIncremental(pager(makeLibrary(2)), {
      ownWordsFor: async (key) => (key === 'K0' ? [{ kind: 'note', text: NOTE_TEXT }] : []),
    });

    const b = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    b.loadFromJSON(JSON.parse(JSON.stringify(a.toJSON())));

    const status = b.status();
    expect(status.ownWordsItems).toBe(1);
    expect(status.ownWordsPassages).toBe(1);
    const hits = await b.query('weak instrument second stage', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('K0');
    expect(hits[0]!.source).toBe('note');
  });
});

/** Router doubles shaped like the real responses, keyed on what the crawl asks for. */
function makeCtx(
  opts: {
    children?: any[];
    attachments?: any[];
    items?: any[];
    childrenThrows?: boolean;
    config?: Record<string, string>;
  } = {},
) {
  const children = opts.children ?? [];
  const attachments = opts.attachments ?? [];
  const items = opts.items ?? [];
  const searchItems = vi.fn(async (q: any) => {
    const start = q.start ?? 0;
    const limit = q.limit ?? PAGE_SIZE;
    if (q.itemKey) {
      const wanted = new Set(String(q.itemKey).split(','));
      const found = [...attachments, ...items].filter((it) => wanted.has(it.key));
      return { data: found, totalResults: found.length, lastModifiedVersion: 1 };
    }
    if (q.itemType === 'note || annotation') {
      if (opts.childrenThrows) throw new Error('403 Forbidden');
      return { data: children.slice(start, start + limit), totalResults: children.length, lastModifiedVersion: 1 };
    }
    if (q.top) {
      return { data: items.slice(start, start + limit), totalResults: items.length, lastModifiedVersion: 1 };
    }
    return { data: [], totalResults: 0, lastModifiedVersion: 1 };
  });
  const ctx: any = {
    config: loadConfig((opts.config ?? {}) as any),
    router: {
      searchItems,
      fullTextSince: vi.fn(async () => ({})),
      getFullText: vi.fn(async () => null),
      itemVersions: vi.fn(async () => ({ versions: Object.fromEntries(items.map((i) => [i.key, 1])) })),
      servesLocally: () => false,
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    search: new MemorySearchIndex({ embedder: null, logger: silentLogger }),
    logger: silentLogger,
    searchIndexPath: '',
  };
  return { ctx, searchItems };
}

function note(key: string, parent: string | undefined, html: string) {
  return { key, data: { key, itemType: 'note', parentItem: parent, note: html } };
}

function annotation(key: string, attachment: string, comment: string, text: string) {
  return {
    key,
    data: {
      key,
      itemType: 'annotation',
      parentItem: attachment,
      annotationType: 'highlight',
      annotationComment: comment,
      annotationText: text,
    },
  };
}

function attachment(key: string, parent?: string) {
  return { key, data: { key, itemType: 'attachment', contentType: 'application/pdf', parentItem: parent } };
}

describe('createOwnWordsSource', () => {
  it('attaches a child note to its item, as text rather than as markup', async () => {
    const { ctx } = makeCtx({ children: [note('N1', 'ITEM1', `<div><p>${NOTE_TEXT}</p></div>`)] });
    const src = await createOwnWordsSource(ctx, undefined);

    expect(src.notes).toBe(1);
    expect(src.items).toBe(1);
    expect(src.wordsFor('ITEM1')).toEqual([{ kind: 'note', text: NOTE_TEXT }]);
    expect(src.wordsFor('ITEM2')).toEqual([]);
  });

  it('follows an annotation through its attachment to the item it belongs to', async () => {
    const { ctx, searchItems } = makeCtx({
      children: [annotation('A1', 'ATT1', COMMENT, HIGHLIGHT)],
      attachments: [attachment('ATT1', 'ITEM1')],
    });
    const src = await createOwnWordsSource(ctx, undefined);

    expect(src.annotations).toBe(1);
    // The comment leads, the highlight follows; both are in one passage.
    expect(src.wordsFor('ITEM1')).toEqual([{ kind: 'annotation', text: `${COMMENT}\n\n${HIGHLIGHT}` }]);
    // One lookup for the attachments that carry an annotation, not a walk of every
    // attachment in the library.
    const lookups = searchItems.mock.calls.filter((c: any[]) => c[0].itemKey);
    expect(lookups).toHaveLength(1);
  });

  it('treats a top-level attachment as its own item', async () => {
    const { ctx } = makeCtx({
      children: [annotation('A1', 'ATT1', COMMENT, '')],
      attachments: [attachment('ATT1')],
    });
    const src = await createOwnWordsSource(ctx, undefined);
    expect(src.wordsFor('ATT1')).toEqual([{ kind: 'annotation', text: COMMENT }]);
  });

  it('skips a standalone note, which the metadata pass already indexes as an item', async () => {
    const { ctx } = makeCtx({ children: [note('N1', undefined, `<p>${NOTE_TEXT}</p>`)] });
    const src = await createOwnWordsSource(ctx, undefined);
    expect(src.notes).toBe(0);
    expect(src.items).toBe(0);
  });

  it('drops a highlight with no comment only when it carries no text at all', async () => {
    const { ctx } = makeCtx({
      children: [annotation('A1', 'ATT1', '', ''), annotation('A2', 'ATT1', '', HIGHLIGHT)],
      attachments: [attachment('ATT1', 'ITEM1')],
    });
    const src = await createOwnWordsSource(ctx, undefined);
    expect(src.annotations).toBe(1);
    expect(src.wordsFor('ITEM1')).toEqual([{ kind: 'annotation', text: HIGHLIGHT }]);
  });

  it('caps the own words indexed per item', async () => {
    const { ctx } = makeCtx({
      children: [
        note('N1', 'ITEM1', 'a'.repeat(30)),
        note('N2', 'ITEM1', 'b'.repeat(30)),
      ],
    });
    const src = await createOwnWordsSource(ctx, undefined, { maxChars: 40 });
    expect(src.wordsFor('ITEM1').map((w) => w.text.length)).toEqual([30, 10]);
  });

  it('takes maxChars:0 as no cap', async () => {
    const { ctx } = makeCtx({
      children: [note('N1', 'ITEM1', 'c'.repeat(DEFAULT_OWN_WORDS_MAX_CHARS + 500))],
    });
    const src = await createOwnWordsSource(ctx, undefined, { maxChars: 0 });
    expect(src.wordsFor('ITEM1')[0]!.text).toHaveLength(DEFAULT_OWN_WORDS_MAX_CHARS + 500);
  });

  it('degrades with a reason instead of throwing when the crawl is refused', async () => {
    const { ctx } = makeCtx({ childrenThrows: true });
    const src = await createOwnWordsSource(ctx, undefined);
    expect(src.unavailable).toMatch(/403 Forbidden/);
    expect(src.wordsFor('ITEM1')).toEqual([]);
  });
});

describe('startIndexBuild with own words', () => {
  async function finished(search: SearchIndex): Promise<void> {
    for (let i = 0; i < 2000 && search.buildStatus().state === 'building'; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it('makes a note and an annotation searchable end to end, on a default build', async () => {
    const { ctx } = makeCtx({
      items: makeLibrary(3),
      children: [note('N1', 'K0', `<p>${NOTE_TEXT}</p>`), annotation('A1', 'ATT1', COMMENT, HIGHLIGHT)],
      attachments: [attachment('ATT1', 'K2')],
    });

    startIndexBuild(ctx);
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    // Not opt-in: no `fulltext` flag was passed and no environment variable was set.
    expect(s.fulltextEnabled).toBe(false);
    expect(s.ownWordsItems).toBe(2);
    expect(s.ownWordsPassages).toBe(2);
    expect(statusSummary(s)).toMatch(/2 passages from your own notes and annotations across 2 items/);

    const onNote = await ctx.search.query('weak instrument second stage', { limit: 1 });
    expect(onNote[0]!.itemKey).toBe('K0');
    expect(onNote[0]!.source).toBe('note');

    const onAnnotation = await ctx.search.query('Ostrom polycentric governance', { limit: 1 });
    expect(onAnnotation[0]!.itemKey).toBe('K2');
    expect(onAnnotation[0]!.source).toBe('annotation');
  });

  it('can be turned off, and then indexes metadata exactly as before', async () => {
    const { ctx, searchItems } = makeCtx({
      items: makeLibrary(2),
      children: [note('N1', 'K0', `<p>${NOTE_TEXT}</p>`)],
      config: { ZOTEUS_INDEX_OWN_WORDS: 'false' },
    });

    startIndexBuild(ctx);
    await finished(ctx.search);

    expect(ctx.search.buildStatus().ownWordsPassages).toBe(0);
    expect(await ctx.search.query('weak instrument second stage', { limit: 1 })).toEqual([]);
    // The census is not merely ignored, it is never crawled.
    expect(searchItems.mock.calls.filter((c: any[]) => c[0].itemType)).toHaveLength(0);
  });
});

describe('startIndexUpdate with own words', () => {
  async function finished(search: SearchIndex): Promise<void> {
    for (let i = 0; i < 2000 && search.buildStatus().state === 'building'; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it('picks up an annotation written after the build, though the item never changed', async () => {
    // The zotero_annotate case: the tool writes an annotation onto an attachment, which
    // leaves the parent item's version exactly where it was. Nothing in a `?since=` delta
    // over top-level items names that item, so an update that only crawled the delta would
    // never look at it again.
    const items = makeLibrary(2);
    const { ctx, searchItems } = makeCtx({ items, attachments: [attachment('ATT1', 'K1')] });

    startIndexBuild(ctx);
    await finished(ctx.search);
    expect(await ctx.search.query('Ostrom polycentric governance', { limit: 1 })).toEqual([]);

    // Zotero now holds an annotation on K1's attachment, and no item changed.
    const written = annotation('A1', 'ATT1', COMMENT, HIGHLIGHT);
    searchItems.mockImplementation(async (q: any) => {
      if (q.itemKey) {
        const wanted = new Set(String(q.itemKey).split(','));
        const found = [attachment('ATT1', 'K1'), ...items].filter((it) => wanted.has(it.key));
        return { data: found, totalResults: found.length, lastModifiedVersion: 2 };
      }
      if (q.itemType === 'note || annotation') {
        return { data: [written], totalResults: 1, lastModifiedVersion: 2 };
      }
      if (q.top) return { data: [], totalResults: 0, lastModifiedVersion: 2 };
      return { data: [], totalResults: 0, lastModifiedVersion: 2 };
    });

    startIndexUpdate(ctx);
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    const hits = await ctx.search.query('Ostrom polycentric governance', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('K1');
    expect(hits[0]!.source).toBe('annotation');
  });

  it('steps over a whole batch of parents that no longer resolve', async () => {
    // Fifty-one items whose notes all changed, of which the first fifty — one whole
    // `itemKey=` batch — have since been deleted. The batch answers with nothing, and an
    // empty page is what ends a crawl: read naively, the fifty-first item would never be
    // looked at.
    const items = makeLibrary(51);
    const { ctx, searchItems } = makeCtx({ items });

    startIndexBuild(ctx);
    await finished(ctx.search);

    const alive = new Set(['K50']);
    searchItems.mockImplementation(async (q: any) => {
      if (q.itemKey) {
        const wanted = new Set(String(q.itemKey).split(','));
        const found = items.filter((it) => wanted.has(it.key) && alive.has(it.key));
        return { data: found, totalResults: found.length, lastModifiedVersion: 2 };
      }
      if (q.itemType === 'note || annotation') {
        const children = items.map((it, i) => note(`N${i}`, it.key, `<p>${NOTE_TEXT}</p>`));
        return { data: children, totalResults: children.length, lastModifiedVersion: 2 };
      }
      return { data: [], totalResults: 0, lastModifiedVersion: 2 };
    });

    startIndexUpdate(ctx);
    await finished(ctx.search);

    expect(ctx.search.buildStatus().state).toBe('done');
    const hits = await ctx.search.query('weak instrument second stage', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('K50');
  });

  it('drops the passages of a note that was deleted', async () => {
    const items = makeLibrary(2);
    const { ctx, searchItems } = makeCtx({
      items,
      children: [note('N1', 'K0', `<p>${NOTE_TEXT}</p>`)],
    });

    startIndexBuild(ctx);
    await finished(ctx.search);
    expect((await ctx.search.query('weak instrument second stage', { limit: 1 }))[0]!.itemKey).toBe('K0');

    // The note is gone. Its parent still appears in the own-words delta — an emptied or
    // deleted note is a change to the child, and the child's version moves with it.
    searchItems.mockImplementation(async (q: any) => {
      if (q.itemKey) {
        const wanted = new Set(String(q.itemKey).split(','));
        const found = items.filter((it) => wanted.has(it.key));
        return { data: found, totalResults: found.length, lastModifiedVersion: 2 };
      }
      if (q.itemType === 'note || annotation') {
        return { data: [note('N1', 'K0', '')], totalResults: 1, lastModifiedVersion: 2 };
      }
      return { data: [], totalResults: 0, lastModifiedVersion: 2 };
    });

    startIndexUpdate(ctx);
    await finished(ctx.search);

    expect(ctx.search.buildStatus().ownWordsPassages).toBe(0);
    expect(await ctx.search.query('weak instrument second stage', { limit: 1 })).toEqual([]);
  });
});
