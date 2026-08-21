import { describe, it, expect } from 'vitest';
import { STORES } from './stores.js';
import { Fts5PassageStore, VEC_DIM_KEY } from '../../src/features/search/fts5-store.js';
import type { ChunkRecord } from '../../src/features/search/passage-store.js';

/** A throwaway on-disk database, so a test can open a SECOND connection to the same file. */
function tempDb(): string {
  return `${process.env.TMPDIR ?? '/tmp'}/zoteus-fts5-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`;
}

const RECORDS: ChunkRecord[] = [
  { id: 'A#0', itemKey: 'A', title: 'Deep learning', text: 'convolutional neural networks classify images' },
  { id: 'A#f0', itemKey: 'A', title: 'Deep learning', text: 'the ablation removes the recurrent gate', source: 'fulltext' },
  { id: 'B#0', itemKey: 'B', title: 'Organic gardening', text: 'growing tomatoes and herbs' },
];

describe.each(STORES)('PassageStore contract (%s)', (_name, makeStore) => {
  function loaded() {
    const store = makeStore();
    for (const rec of RECORDS) store.add(rec);
    return store;
  }

  it('counts what it holds and round-trips a record', () => {
    const store = loaded();
    expect(store.size).toBe(3);
    expect(store.get('A#f0')).toEqual(RECORDS[1]);
    // Absent, not null: an older build reading the JSON must not see a `source` key it
    // does not understand on a metadata passage.
    expect(store.get('A#0')!.source).toBeUndefined();
    expect(store.get('nope')).toBeUndefined();
  });

  it('enumerates every passage in insertion order', () => {
    expect([...loaded().values()]).toEqual(RECORDS);
  });

  it('ranks hits best-first with strictly positive scores', () => {
    const hits = loaded().search('neural networks', 10);
    expect(hits[0]!.id).toBe('A#0');
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
  });

  it('honours topK', () => {
    const store = loaded();
    store.add({ id: 'C#0', itemKey: 'C', title: 'More', text: 'neural neural neural' });
    expect(store.search('neural', 1)).toHaveLength(1);
  });

  it('deleteByItem genuinely removes the passages, keyword index included', () => {
    const store = loaded();
    store.deleteByItem('A');
    expect(store.size).toBe(1);
    expect(store.get('A#0')).toBeUndefined();
    expect(store.get('A#f0')).toBeUndefined();
    // The load-bearing half: a store that forgot only the record and not the index would
    // still return 'A#0' here, and SearchIndex.query would then drop a hit it cannot resolve.
    expect(store.search('neural networks', 10)).toEqual([]);
    expect(store.search('tomatoes', 10).map((h) => h.id)).toEqual(['B#0']);
  });

  it('deleteByItem on an unknown item is a no-op', () => {
    const store = loaded();
    store.deleteByItem('ZZZ');
    expect(store.size).toBe(3);
  });

  it('clear empties the store in place', () => {
    const store = loaded();
    store.clear();
    expect(store.size).toBe(0);
    expect(store.search('neural', 10)).toEqual([]);
    expect([...store.values()]).toEqual([]);
    // Reusable afterwards: SearchIndex.reset() clears rather than reassigns.
    store.add(RECORDS[0]!);
    expect(store.size).toBe(1);
  });

  it('returns no hits for a query with no surviving terms', () => {
    expect(loaded().search('the a of', 10)).toEqual([]);
    expect(loaded().search('', 10)).toEqual([]);
  });

  /**
   * The vector half of the port contract.
   *
   * The direction assertion below is the one that has to be made HERE, on the raw list,
   * and not through a fused query: rrf() collapses both input lists onto their positions
   * and re-sorts, so a reversed vectorSearch still produces a plausible ranking and every
   * fused assertion stays green. Sabotage confirms it — see the comment on the test.
   */
  function vectorised() {
    const store = makeStore();
    // Three passages whose vectors sit at known angles from the probe below: identical,
    // 37° off, and 79° off. All three keep a POSITIVE cosine similarity, so none is
    // dropped by the `score > 0` filter and the assertion is about order alone.
    store.add({ id: 'V#0', itemKey: 'V', title: 'Near', text: 'near' });
    store.add({ id: 'V#1', itemKey: 'V', title: 'Mid', text: 'mid' });
    store.add({ id: 'W#0', itemKey: 'W', title: 'Far', text: 'far' });
    store.setVector('V#0', [1, 0, 0]);
    store.setVector('V#1', [0.8, 0.6, 0]);
    store.setVector('W#0', [0.2, 0.98, 0]);
    return store;
  }
  const PROBE = [1, 0, 0];

  it('counts the vectors it holds', () => {
    const store = vectorised();
    expect(store.vectorCount).toBe(3);
  });

  it('ranks the nearest vector FIRST and the farthest LAST, score descending', () => {
    // The whole sign convention, asserted directly. FTS5 hands back a negative bm25 and
    // vec0 hands back an ascending distance; both are converted at the store boundary so
    // that everything crossing the port is descending-best. Reverse either conversion and
    // this is the assertion that turns red — a fused-output assertion is not, because
    // rrf() ranks by position and would happily fuse a backwards list.
    const hits = vectorised().vectorSearch(PROBE, 10);
    expect(hits.map((h) => h.id)).toEqual(['V#0', 'V#1', 'W#0']);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.score).toBeLessThan(hits[i - 1]!.score);
    // Similarity, not distance: identical vectors score 1, not 0.
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('honours topK on the vector side', () => {
    expect(vectorised().vectorSearch(PROBE, 2).map((h) => h.id)).toEqual(['V#0', 'V#1']);
  });

  it('returns nothing for a query vector with no direction', () => {
    // A zero vector has no angle, so no similarity is defined for it.
    expect(vectorised().vectorSearch([0, 0, 0], 10)).toEqual([]);
  });

  it('dumps its vectors for the JSON snapshot, in passage order', () => {
    const entries = vectorised().vectorEntries();
    expect(entries.map((e) => e.id)).toEqual(['V#0', 'V#1', 'W#0']);
    // float32 on the SQLite side, float64 in the heap — equal to a float32's worth of
    // precision, which is the width the vectors are actually kept at.
    expect(entries[0]!.vector[0]).toBeCloseTo(1, 6);
    expect(entries[1]!.vector[1]).toBeCloseTo(0.6, 6);
  });

  it('deleteByItem takes the item’s vectors with its passages', () => {
    const store = vectorised();
    store.deleteByItem('V');
    expect(store.vectorCount).toBe(1);
    // The load-bearing half: a vector that outlived its passage answers a KNN query with
    // an id nothing can resolve, and SearchIndex.query then drops the hit in silence.
    expect(store.vectorSearch(PROBE, 10).map((h) => h.id)).toEqual(['W#0']);
  });

  it('clear empties the vector side too, and the store stays usable', () => {
    const store = vectorised();
    store.clear();
    expect(store.vectorCount).toBe(0);
    expect(store.vectorSearch(PROBE, 10)).toEqual([]);
    expect(store.vectorEntries()).toEqual([]);
    store.add({ id: 'V#0', itemKey: 'V', title: 'Near', text: 'near' });
    store.setVector('V#0', [1, 0, 0]);
    expect(store.vectorCount).toBe(1);
  });

  it('holds no vectors until one is set', () => {
    const store = loaded();
    expect(store.vectorCount).toBe(0);
    expect(store.vectorSearch(PROBE, 10)).toEqual([]);
  });
});

describe('Fts5PassageStore specifics', () => {
  it('folds diacritics, so an ASCII query reaches an accented passage', () => {
    // `remove_diacritics 2` is why: unicode61 normalises élève to eleve on the index side.
    // The JS index cannot do this — tokenize() matches [a-z0-9]+, so it stores "l"/"ve".
    const store = new Fts5PassageStore(':memory:');
    store.add({ id: 'F#0', itemKey: 'F', title: 'Scolarité', text: 'un élève très appliqué' });
    expect(store.search('eleve', 5).map((h) => h.id)).toEqual(['F#0']);
  });

  it('does NOT fold diacritics on the query side, because the sanitiser is ASCII-only', () => {
    // Documented limitation, not an oversight. toMatchQuery deliberately tokenises with the
    // index's own tokenize(), which matches [a-z0-9]+ — so an accented *query* is shredded
    // ("élève" -> "ve") before FTS5 ever sees it, and remove_diacritics only helps in the
    // ASCII-query -> accented-document direction. Diverging the query tokenizer from the
    // index tokenizer would fix it and would also desynchronise the two backends' term
    // sets, which is the thing the shared tokenizer exists to prevent.
    const store = new Fts5PassageStore(':memory:');
    store.add({ id: 'F#0', itemKey: 'F', title: 'Scolarité', text: 'un élève très appliqué' });
    expect(store.search('élève', 5)).toEqual([]);
  });

  it('replaces rather than duplicates when the same id is added twice', () => {
    const store = new Fts5PassageStore(':memory:');
    store.add({ id: 'A#0', itemKey: 'A', title: 'One', text: 'tomatoes' });
    store.add({ id: 'A#0', itemKey: 'A', title: 'Two', text: 'gardening' });
    expect(store.size).toBe(1);
    expect(store.get('A#0')!.title).toBe('Two');
    expect(store.search('tomatoes', 5)).toEqual([]);
    expect(store.search('gardening', 5)).toHaveLength(1);
  });

  it('persists to a file and reopens with its contents', () => {
    const path = tempDb();
    const a = new Fts5PassageStore(path);
    a.add({ id: 'A#0', itemKey: 'A', title: 'Deep learning', text: 'convolutional neural networks' });
    a.close();
    const b = new Fts5PassageStore(path);
    expect(b.size).toBe(1);
    expect(b.search('neural', 5).map((h) => h.id)).toEqual(['A#0']);
    b.close();
  });

  it('replaces a passage’s vector rather than orphaning it when the id is re-added', () => {
    // add() gives the replacement a fresh FTS5 rowid, so a vector filed under the old one
    // would survive its passage and answer a KNN query with an unresolvable id. The
    // resident store cannot have this defect (its VectorStore is keyed by passage id, not
    // by rowid) and correspondingly appends on a repeated setVector, which nothing does.
    const store = new Fts5PassageStore(':memory:');
    store.add({ id: 'A#0', itemKey: 'A', title: 'One', text: 'tomatoes' });
    store.setVector('A#0', [1, 0, 0]);
    store.add({ id: 'A#0', itemKey: 'A', title: 'Two', text: 'gardening' });
    expect(store.vectorCount).toBe(0);
    store.setVector('A#0', [1, 0, 0]);
    expect(store.vectorSearch([1, 0, 0], 5).map((h) => h.id)).toEqual(['A#0']);
  });

  it('refuses to embed a passage it does not hold', () => {
    const store = new Fts5PassageStore(':memory:');
    expect(() => store.setVector('ghost#0', [1, 0, 0])).toThrow(/no passage with id "ghost#0"/);
  });
});

/**
 * The vec0 half of the SQLite store: what the resident store has no equivalent of.
 *
 * The dimension is the whole difficulty. `vec0` wants `float[N]` in its DDL and zoteus does
 * not know N before a model has run — embeddings.ts reads it off the output tensor — so the
 * table is created on the first setVector and N is recorded in `index_meta`.
 */
describe('Fts5PassageStore vector storage', () => {
  function stored(path = ':memory:') {
    const store = new Fts5PassageStore(path);
    store.add({ id: 'A#0', itemKey: 'A', title: 'Deep learning', text: 'convolutional neural networks' });
    store.add({ id: 'B#0', itemKey: 'B', title: 'Organic gardening', text: 'growing tomatoes and herbs' });
    store.setVector('A#0', [1, 0, 0]);
    store.setVector('B#0', [0, 1, 0]);
    return store;
  }

  it('records the embedding dimension in index_meta', () => {
    expect(stored().getMeta(VEC_DIM_KEY)).toBe('3');
  });

  it('reads the dimension back on reopen and keeps answering KNN from the file', () => {
    // A second connection to a real file, which is the point: an in-memory database would
    // prove nothing about what was written to disk.
    const path = tempDb();
    stored(path).close();
    const reopened = new Fts5PassageStore(path);
    expect(reopened.getMeta(VEC_DIM_KEY)).toBe('3');
    expect(reopened.vectorCount).toBe(2);
    expect(reopened.vectorSearch([1, 0, 0], 5).map((h) => h.id)).toEqual(['A#0']);
    // And it can go on filling the table it inherited.
    reopened.add({ id: 'C#0', itemKey: 'C', title: 'Third', text: 'sequence alignment' });
    reopened.setVector('C#0', [0.9, 0.1, 0]);
    expect(reopened.vectorCount).toBe(3);
    reopened.close();
  });

  it('refuses a vector of a different width, naming both dimensions', () => {
    const store = stored();
    // Mixed widths in one table is the failure that produces plausible nonsense rankings,
    // so it is refused outright rather than coerced or silently dropped.
    expect(() => store.setVector('B#0', [1, 0, 0, 0])).toThrow(/stores 3-dimension/);
    expect(() => store.setVector('B#0', [1, 0, 0, 0])).toThrow(/4-dimension vector arrived/);
    expect(store.vectorCount).toBe(2);
  });

  it('refuses a query vector of a different width, and says to rebuild', () => {
    // Reached when the index was built by one model and ZOTEUS_EMBEDDINGS now names
    // another. Thrown rather than emptied: SearchIndex.query runs this inside the try that
    // catches embedder failures, so the cause reaches status() and the keyword half of the
    // search still comes back.
    expect(() => stored().vectorSearch([1, 0], 5)).toThrow(/2 dimensions but this index stores 3/);
  });

  it('accepts a new dimension after clear, which is how changing the model works', () => {
    // The legitimate route to a different width. SearchIndex.reset() calls clear() at the
    // top of every build, and clear() drops the vec0 table rather than only emptying it —
    // an emptied 3-wide table would still refuse the first 4-wide vector of the rebuild.
    const store = stored();
    store.clear();
    expect(store.getMeta(VEC_DIM_KEY)).toBeUndefined();
    store.add({ id: 'A#0', itemKey: 'A', title: 'Deep learning', text: 'convolutional neural networks' });
    store.setVector('A#0', [1, 0, 0, 0]);
    expect(store.getMeta(VEC_DIM_KEY)).toBe('4');
    expect(store.vectorSearch([1, 0, 0, 0], 5).map((h) => h.id)).toEqual(['A#0']);
  });

  it('degrades to keyword-only, with a stated reason, when sqlite-vec cannot be loaded', () => {
    // The absence is simulated rather than staged by uninstalling the package: the point
    // under test is what this store does when the loader fails, and an uninstall would
    // take the rest of the suite with it.
    const store = new Fts5PassageStore(':memory:', {
      loadVec: () => {
        throw new Error('Cannot find module \'sqlite-vec\'');
      },
    });
    expect(store.vectorReason).toMatch(/sqlite-vec could not be loaded/);
    expect(store.vectorReason).toMatch(/npm i sqlite-vec/);
    // Not a crash, and not silence either: the build runs to the end and stays useful.
    store.add({ id: 'A#0', itemKey: 'A', title: 'Deep learning', text: 'convolutional neural networks' });
    expect(() => store.setVector('A#0', [1, 0, 0])).not.toThrow();
    expect(store.vectorCount).toBe(0);
    expect(store.vectorSearch([1, 0, 0], 5)).toEqual([]);
    expect(store.vectorEntries()).toEqual([]);
    expect(store.search('neural networks', 5).map((h) => h.id)).toEqual(['A#0']);
    // Deleting and clearing must not reach for a table that was never created.
    expect(() => store.deleteByItem('A')).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('says nothing when sqlite-vec loads, which is the healthy case', () => {
    expect(new Fts5PassageStore(':memory:').vectorReason).toBeUndefined();
  });
});
