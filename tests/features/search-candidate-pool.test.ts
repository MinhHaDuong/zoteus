import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import type {
  OwnWordsAccess,
  OwnWordsEntry,
  SearchIndex,
} from '../../src/features/search/backend.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * The candidate pool behind `query()` (#65).
 *
 * Every retrieval (BM25, FTS5, the vector scan) ranks PASSAGES, and the result is a list of
 * ITEMS: the fused passages are de-duplicated by item key and the first `limit` distinct
 * items are the page. Between the two sat a fixed pool of `limit * 3` passages. An item
 * with forty annotations (#33) contributes forty passages, and when those rank first, as
 * they do whenever the reader highlighted exactly the thing being asked about, the whole
 * pool belongs to that one item: `limit: 5` returned one paper while `limit: 20`, whose
 * pool was wide enough to reach past the annotations, returned all five. The papers were
 * indexed the whole time. What these cases pin is that the pool now widens until the page
 * is full or the candidates are used up, that the widening is bounded and does not run
 * when the first pool already suffices, and that what the page says about each item (its
 * key, its title, where the snippet came from) is unchanged by any of it.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable()
  ? ['memory', 'sqlite']
  : ['memory'];

/**
 * The issue's geometry, as an embedder: every metadata passage (its text begins with the
 * paper's title, `Paper ...`) embeds to [0.8, 0.6], while the reader's own words and the
 * query embed to [1, 0]. So every paper is relevant (cosine 0.8) and every note or
 * annotation ranks above every paper (cosine 1), which is the concentration the pool has
 * to see past.
 */
class PlaneEmbedder implements EmbeddingProvider {
  readonly name = 'plane';
  readonly calls: string[][] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => (t.startsWith('Paper ') ? [0.8, 0.6] : [1, 0]));
  }
}

/**
 * Five papers whose abstracts each mention the query once, in a long passage, and one of
 * them carrying `children` short notes or annotations that say nothing else. BM25 and
 * FTS5's bm25() both normalize for length, so the short children outrank every abstract
 * on the keyword side exactly as they do on the vector side.
 */
const QUERY = 'tidal reasoning';
const ANNOTATED = 'PAPER001';

function paper(n: number, mentionsQuery = true): Record<string, unknown> {
  const mention = mentionsQuery
    ? `in which ${QUERY} appears once`
    : 'in which nothing of note appears';
  return {
    key: `PAPER00${n}`,
    data: {
      itemType: 'journalArticle',
      title: `Paper ${n} on estuaries`,
      abstractNote:
        `a long abstract about coastal processes ${mention} among many other words about ` +
        'sediment transport, salinity gradients, bathymetry surveys and shoreline change over decades',
    },
  };
}

interface Library {
  kind: 'note' | 'annotation';
  children: number;
  papers: number;
  /** Children whose text carries the query terms; the rest say something unrelated. Default: all. */
  childrenOnQuery?: number;
  abstractsMentionQuery?: boolean;
}

async function indexed(
  backend: 'memory' | 'sqlite',
  lib: Library,
  embedder: EmbeddingProvider | null = new PlaneEmbedder(),
) {
  const index = await createSearchIndex({ backend, jsonPath: '', embedder, logger: silentLogger });
  const items = Array.from({ length: lib.papers }, (_, i) =>
    paper(i + 1, lib.abstractsMentionQuery ?? true),
  );
  const onQuery = lib.childrenOnQuery ?? lib.children;
  const entries: OwnWordsEntry[] = Array.from({ length: lib.children }, (_, i) => ({
    key: `CHILD${String(i).padStart(3, '0')}`,
    kind: lib.kind,
    text: i < onQuery ? `${QUERY} ${i}` : `an unrelated remark ${i}`,
  }));
  const ownWords: OwnWordsAccess = {
    childVersions: async () => new Map(entries.map((e, i) => [e.key, i + 1])),
    itemsFor: async () => new Set([ANNOTATED]),
    textsFor: async (key) => (key === ANNOTATED ? entries : []),
  };
  const status = await index.buildIncremental(
    async (start) => ({
      items: start ? [] : items,
      totalResults: items.length,
      lastModifiedVersion: 1,
    }),
    { ownWords },
  );
  expect(status.items).toBe(lib.papers);
  expect(status.ownWordsPassages).toBe(lib.children);
  return index;
}

function keys(hits: Array<{ itemKey: string }>): string[] {
  return hits.map((h) => h.itemKey).sort();
}

const allPapers = ['PAPER001', 'PAPER002', 'PAPER003', 'PAPER004', 'PAPER005'];
const modes = ['semantic', 'keyword', 'auto'] as const;
const kinds = ['annotation', 'note'] as const;

/** Stop a protected retrieval so the pools it was asked for can be read back. */
function watch(index: SearchIndex, method: 'keywordSearch' | 'vectorSearch') {
  return vi.spyOn(index as any, method);
}

describe.each(backends)('the candidate pool behind query() (%s backend)', (backend) => {
  describe.each(kinds)('with forty %ss on one of five relevant papers', (kind) => {
    it.each(modes)('returns all five papers at limit 5 in %s mode', async (mode) => {
      const index = await indexed(backend, { kind, children: 40, papers: 5 });
      // The control from the issue: a pool wide enough to reach past the forty passages
      // finds every paper, which is what proves they are indexed and ranked.
      expect(keys(await index.query(QUERY, { limit: 20, mode }))).toEqual(allPapers);

      const hits = await index.query(QUERY, { limit: 5, mode });
      expect(keys(hits)).toEqual(allPapers);
      // One slot for the annotated paper, however many passages of it ranked first.
      expect(hits.filter((h) => h.itemKey === ANNOTATED)).toHaveLength(1);
      await index.close();
    });

    it.each(modes)(
      'keeps item attribution and the source label on each snippet in %s mode',
      async (mode) => {
        const index = await indexed(backend, { kind, children: 40, papers: 5 });
        const hits = await index.query(QUERY, { limit: 5, mode });
        const annotated = hits.find((h) => h.itemKey === ANNOTATED)!;
        // The best passage of the annotated paper is one of the reader's own words, and the
        // page says so, exactly as it did when that paper was the only one on it.
        expect(annotated.source).toBe(kind);
        expect(annotated.title).toBe('Paper 1 on estuaries');
        expect(annotated.snippet).toMatch(new RegExp(`^${QUERY} \\d+$`));
        for (const hit of hits) {
          if (hit.itemKey === ANNOTATED) continue;
          // The others are found by their abstracts: a metadata snippet carries no label.
          expect(hit.source).toBeUndefined();
          expect(hit.title).toBe(`Paper ${hit.itemKey.slice(-1)} on estuaries`);
          expect(hit.snippet).toContain(QUERY);
        }
        // Scores stay in the fused order the page is sorted in.
        for (let i = 1; i < hits.length; i++)
          expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
        await index.close();
      },
    );
  });

  it.each(modes)(
    'stops at the items there are when the library holds fewer than asked, in %s mode',
    async (mode) => {
      // Two papers, forty annotations, limit 5: the pool can widen to every passage in the
      // index and no further, and the page is the two items that exist.
      const index = await indexed(backend, { kind: 'annotation', children: 40, papers: 2 });
      const keyword = watch(index, 'keywordSearch');
      const vector = watch(index, 'vectorSearch');
      const hits = await index.query(QUERY, { limit: 5, mode });
      expect(keys(hits)).toEqual(['PAPER001', 'PAPER002']);
      // 42 passages: the pool goes 15, 30, 42 and is never asked for more than the index holds.
      const pools = (mode === 'keyword' ? keyword : vector).mock.calls.map((c) => c[1]);
      expect(pools).toEqual([15, 30, 42]);
      await index.close();
    },
  );

  it('embeds the query once, however many times the pool widens', async () => {
    const embedder = new PlaneEmbedder();
    const index = await indexed(backend, { kind: 'annotation', children: 40, papers: 5 }, embedder);
    const built = embedder.calls.length;
    const vector = watch(index, 'vectorSearch');
    expect(keys(await index.query(QUERY, { limit: 5, mode: 'semantic' }))).toEqual(allPapers);
    expect(vector.mock.calls.length).toBeGreaterThan(1);
    expect(embedder.calls.length - built).toBe(1);
    await index.close();
  });

  it('does no extra work when the first pool already fills the page', async () => {
    const index = await indexed(backend, { kind: 'annotation', children: 2, papers: 5 });
    const keyword = watch(index, 'keywordSearch');
    const vector = watch(index, 'vectorSearch');
    expect(keys(await index.query(QUERY, { limit: 5, mode: 'auto' }))).toEqual(allPapers);
    // One retrieval per ranker, at the pool every query asked for before this change.
    expect(keyword.mock.calls.map((c) => c[1])).toEqual([15]);
    expect(vector.mock.calls.map((c) => c[1])).toEqual([15]);
    await index.close();
  });

  it('does not re-run a ranker whose candidates are already used up', async () => {
    // Five of the forty annotations carry the query terms and no abstract does, so the
    // keyword side is exhausted at five passages on the first round while the vector side
    // (every annotation embeds to the query) has to widen to reach the other papers.
    const index = await indexed(backend, {
      kind: 'annotation',
      children: 40,
      papers: 5,
      childrenOnQuery: 5,
      abstractsMentionQuery: false,
    });
    const keyword = watch(index, 'keywordSearch');
    const vector = watch(index, 'vectorSearch');
    expect(keys(await index.query(QUERY, { limit: 5, mode: 'auto' }))).toEqual(allPapers);
    expect(keyword.mock.calls.map((c) => c[1])).toEqual([15]);
    expect(vector.mock.calls.map((c) => c[1])).toEqual([15, 30, 45]);
    await index.close();
  });

  it('answers a semantic query on an index with no vectors from the keyword side, as before', async () => {
    const index = await indexed(backend, { kind: 'annotation', children: 40, papers: 5 }, null);
    expect(keys(await index.query(QUERY, { limit: 5, mode: 'keyword' }))).toEqual(allPapers);
    expect(await index.query(QUERY, { limit: 5, mode: 'semantic' })).toEqual([]);
    await index.close();
  });
});
