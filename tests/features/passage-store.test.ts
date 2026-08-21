import { describe, it, expect } from 'vitest';
import { STORES } from './stores.js';
import {
  Fts5PassageStore,
  VEC_DIM_KEY,
  VEC_POOL_FACTOR,
  VEC_POOL_MIN,
  VEC_TWO_STAGE_DEFAULT,
  loadSqlite,
  defaultVecLoader,
  vectorPoolSize,
} from '../../src/features/search/fts5-store.js';
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

  it('folds diacritics on the query side too, so the accented spelling reaches it', () => {
    // Ticket 0002 asserted the opposite here, and called it a documented limitation: an
    // accented query was shredded ("élève" -> "ve") by a tokenize() matching [a-z0-9]+, so
    // remove_diacritics only helped in the ASCII-query -> accented-document direction.
    // That reasoning assumed the only repair was to diverge the query tokenizer from the
    // index tokenizer, which is what the shared tokenizer exists to prevent. Ticket 0009
    // took the third option instead — normalise in front of the shared tokenizer, so both
    // sides fold and the tokenizers stay identical — and this assertion is inverted rather
    // than dropped, because the old one recorded a real property that has now changed.
    const store = new Fts5PassageStore(':memory:');
    store.add({ id: 'F#0', itemKey: 'F', title: 'Scolarité', text: 'un élève très appliqué' });
    expect(store.search('élève', 5).map((h) => h.id)).toEqual(['F#0']);
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

/**
 * The two-stage vector query: a binary first pass, then an exact rerank of its pool.
 *
 * Every fixture here is 8-dimensional, and that is not arbitrary. `vec_quantize_binary`
 * packs one dimension per bit and refuses any width that is not a whole number of bytes, so
 * 8 is the narrowest width at which the binary column exists at all; the 3- and 4-wide
 * fixtures the rest of this file is written on take the exact float32 path and would prove
 * nothing about the two stages.
 */
describe('Fts5PassageStore two-stage vector search', () => {
  /** All eight components positive, so this quantizes to the same code as every decoy. */
  const PROBE8 = [1, 1, 1, 1, 1, 1, 1, 1];
  /** One sign flipped: Hamming 1 from the probe, cosine 0,853 — the true best below. */
  const TARGET8 = [1, 1, 1, 1, 1, 1, 1, -0.5];

  /**
   * The fixture that separates the two stages, by construction.
   *
   * Eight DECOYS whose components are all positive and all but the first nearly zero: the
   * binary pass cannot tell them from the probe (Hamming distance 0, the smallest there
   * is), while their true cosine is only 0,38 to 0,54. One TARGET differing from the probe
   * in a single sign, so the binary pass ranks it behind every decoy, whose true cosine is
   * 0,853 — the best in the fixture by a wide margin.
   *
   * So the binary ranking and the exact ranking disagree at the top, deliberately and
   * deterministically. A pool wide enough to hold all nine lets the rerank restore the
   * truth; a pool of three cannot, because the target was never in it. That is the claim of
   * this ticket reduced to nine vectors.
   */
  function seedSeparated(store: Fts5PassageStore): Fts5PassageStore {
    store.add({ id: 'T#0', itemKey: 'T', title: 'Target', text: 'target' });
    store.setVector('T#0', TARGET8);
    for (let i = 0; i < 8; i++) {
      const e = 0.01 * (i + 1);
      store.add({ id: `D#${i}`, itemKey: 'D', title: 'Decoy', text: `decoy ${i}` });
      store.setVector(`D#${i}`, [1, e, e, e, e, e, e, e]);
    }
    return store;
  }

  /**
   * The same fixture, in memory, with the two-stage path ON and the pool knob open.
   *
   * The opt-in is explicit in every test below because the shipped default is OFF — see
   * VEC_TWO_STAGE_DEFAULT, where the measurement that decided it lives. A suite that let
   * the default carry it would test the exact scan while claiming to test the two stages,
   * and would keep passing on the day someone deleted the binary column.
   */
  function separated(opts: { poolFactor?: number; poolMin?: number } = {}): Fts5PassageStore {
    return seedSeparated(new Fts5PassageStore(':memory:', { twoStage: true, ...opts }));
  }

  it('recovers the exact best passage that the binary pass ranked LAST', () => {
    // The default pool (128) covers all nine vectors, so stage one proposes everything and
    // stage two sorts it truthfully. 'T#0' coming first is the rerank doing its job: the
    // binary pass put it ninth of nine.
    const hits = separated().vectorSearch(PROBE8, 3);
    expect(hits[0]!.id).toBe('T#0');
    expect(hits[0]!.score).toBeCloseTo(0.8535, 3);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.score).toBeLessThan(hits[i - 1]!.score);
  });

  it('DIVERGES from the exact ranking when the pool is too small — the pool is the accuracy knob', () => {
    // The red step of the ticket, kept as a permanent fixture rather than deleted once it
    // passed. Starve the pool to exactly topK and the target is not in it; no amount of
    // reranking invents a candidate the first pass never proposed. Recall lost in stage one
    // is lost for good, which is what makes VEC_POOL_FACTOR a measured constant and not a
    // taste. Restore the default pool and the same query answers 'T#0' — that is the point.
    const starved = separated({ poolFactor: 1, poolMin: 1 }).vectorSearch(PROBE8, 3);
    expect(starved).toHaveLength(3);
    expect(starved.map((h) => h.id)).not.toContain('T#0');
    // And what comes back is not junk — it is the exact ranking OF THE WRONG POOL. The
    // failure mode is silent by nature: three plausible passages, correctly ordered among
    // themselves, none of them the one that mattered.
    for (const h of starved) expect(h.id.startsWith('D#')).toBe(true);
    for (let i = 1; i < starved.length; i++) {
      expect(starved[i]!.score).toBeLessThanOrEqual(starved[i - 1]!.score);
    }
  });

  it('is exactly the float32 ranking whenever the pool covers the corpus', () => {
    // The rerank's own contract, isolated from recall: when stage one cannot lose anything
    // (50 vectors, pool 128), the answer must be the true cosine ranking to the last
    // decimal. The reference is computed here in JS rather than read from the float32 KNN,
    // so a mistake shared by both SQL paths cannot hide behind agreement between them.
    let seed = 20260821;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const vectors = new Map<string, number[]>();
    const store = new Fts5PassageStore(':memory:', { twoStage: true });
    for (let i = 0; i < 50; i++) {
      const v = Array.from({ length: 8 }, rnd);
      const id = `R#${i}`;
      vectors.set(id, v);
      store.add({ id, itemKey: `R${i}`, title: 'Random', text: `random ${i}` });
      store.setVector(id, v);
    }
    const probe = Array.from({ length: 8 }, rnd);
    const cos = (a: number[], b: number[]) => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dot / Math.sqrt(na * nb);
    };
    const expected = [...vectors.entries()]
      .map(([id, v]) => ({ id, score: cos(v, probe) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    expect(vectorPoolSize(10)).toBeGreaterThanOrEqual(50);
    const hits = store.vectorSearch(probe, 10);
    expect(hits.map((h) => h.id)).toEqual(expected.map((h) => h.id));
    for (let i = 0; i < hits.length; i++) expect(hits[i]!.score).toBeCloseTo(expected[i]!.score, 5);
  });

  it('drops the binary codes with the passages on deleteByItem', () => {
    // Observable only through a starved pool, which is why the test starves it. The eight
    // decoys sit at Hamming 0 and the target at Hamming 1, so a binary table still holding
    // the deleted decoys hands the single pool slot to a rowid whose passage_meta row is
    // gone; the rerank's join then drops it and the query answers NOTHING. A vector that
    // outlives its passage is not a wrong hit here, it is a missing one.
    const store = separated({ poolFactor: 1, poolMin: 1 });
    store.deleteByItem('D');
    expect(store.vectorCount).toBe(1);
    expect(store.vectorSearch(PROBE8, 1).map((h) => h.id)).toEqual(['T#0']);
  });

  it('drops the old binary code when a passage id is added a second time', () => {
    // The same defect reached the other way: add() gives the replacement a fresh rowid, so
    // a code filed under the old one would outlive its passage. The first vector is all
    // positive (Hamming 0 from the probe) and the second has a negative component (Hamming
    // 1), so a surviving stale code strictly outranks the live one, takes the only pool
    // slot, and the query answers nothing at all.
    const store = new Fts5PassageStore(':memory:', { twoStage: true, poolFactor: 1, poolMin: 1 });
    store.add({ id: 'A#0', itemKey: 'A', title: 'One', text: 'tomatoes' });
    store.setVector('A#0', PROBE8);
    store.add({ id: 'A#0', itemKey: 'A', title: 'Two', text: 'gardening' });
    store.setVector('A#0', TARGET8);
    expect(store.vectorCount).toBe(1);
    expect(store.vectorSearch(PROBE8, 1).map((h) => h.id)).toEqual(['A#0']);
  });

  it('takes the binary table with it on clear, and rebuilds both', () => {
    const store = separated({ poolFactor: 1, poolMin: 1 });
    store.clear();
    expect(store.vectorCount).toBe(0);
    expect(store.vectorSearch(PROBE8, 3)).toEqual([]);
    store.add({ id: 'Z#0', itemKey: 'Z', title: 'Fresh', text: 'fresh' });
    store.setVector('Z#0', TARGET8);
    // Dropped and recreated at the same width, so the two-stage query still works. Were the
    // binary table only emptied, this would pass and the first vector of a differently
    // sized model would be refused — the failure the float32 table already guards against.
    expect(store.vectorSearch(PROBE8, 1).map((h) => h.id)).toEqual(['Z#0']);
  });

  it('finds the binary table again when the database is reopened', () => {
    // The statements are prepared from what sqlite_master says the schema holds, so this is
    // the assertion that the reopen path looks. The starved pool is what makes it sharp:
    // the exact fallback would answer 'T#0' here, so a decoy coming back proves the BINARY
    // pass is the one that ran, on a table read off the disk rather than created in session.
    const path = tempDb();
    seedSeparated(new Fts5PassageStore(path)).close();
    const reopened = new Fts5PassageStore(path, { twoStage: true, poolFactor: 1, poolMin: 1 });
    const hits = reopened.vectorSearch(PROBE8, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id.startsWith('D#')).toBe(true);
    reopened.close();
  });

  it('falls back to the exact scan for a width vec0 cannot quantize', () => {
    // Four dimensions is half a byte, and vec_quantize_binary refuses anything that is not
    // a whole number of them. No binary table is created, so the query takes the float32
    // path and the pool knob does not apply — starve it and the answer is still exact.
    // Every embedding model in play is a multiple of 8; what lands here is fixtures.
    const store = new Fts5PassageStore(':memory:', { twoStage: true, poolFactor: 1, poolMin: 1 });
    store.add({ id: 'T#0', itemKey: 'T', title: 'Target', text: 'target' });
    store.setVector('T#0', [1, 1, 1, -0.5]);
    for (let i = 0; i < 8; i++) {
      const e = 0.01 * (i + 1);
      store.add({ id: `D#${i}`, itemKey: 'D', title: 'Decoy', text: `decoy ${i}` });
      store.setVector(`D#${i}`, [1, e, e, e]);
    }
    expect(store.vectorSearch([1, 1, 1, 1], 1).map((h) => h.id)).toEqual(['T#0']);
  });

  it('falls back to the exact scan for a database written before the binary column existed', () => {
    // Backward compatibility, staged rather than assumed: an index built by the previous
    // version has the float32 table and nothing beside it. Removing the binary table behind
    // the store's back is the only faithful way to produce one. Starved pool again, so the
    // answer distinguishes the paths: exact says 'T#0', binary would say a decoy.
    const path = tempDb();
    seedSeparated(new Fts5PassageStore(path)).close();

    const { DatabaseSync } = loadSqlite();
    const raw = new DatabaseSync(path, { allowExtension: true });
    raw.enableLoadExtension(true);
    defaultVecLoader(raw);
    raw.enableLoadExtension(false);
    raw.exec('DROP TABLE passage_vectors_bin');
    raw.close();

    const legacy = new Fts5PassageStore(path, { twoStage: true, poolFactor: 1, poolMin: 1 });
    expect(legacy.vectorCount).toBe(9);
    expect(legacy.vectorSearch(PROBE8, 1).map((h) => h.id)).toEqual(['T#0']);
    legacy.close();
  });

  it('does NOT take the two-stage path by default, while still filling the binary column', () => {
    // The shipped default is the exact scan. VEC_TWO_STAGE_DEFAULT carries the measurement
    // behind that: the pool that preserves the ranking costs more than the scan it would
    // replace. Asserted on the constant AND on behaviour, because the two can drift — a
    // store built with no options answers the starved-pool fixture exactly, which only the
    // float32 path does.
    expect(VEC_TWO_STAGE_DEFAULT).toBe(false);
    const store = seedSeparated(new Fts5PassageStore(':memory:', { poolFactor: 1, poolMin: 1 }));
    expect(store.vectorSearch(PROBE8, 1).map((h) => h.id)).toEqual(['T#0']);
    // And the column is maintained regardless, so flipping the default is a one-line change
    // rather than a reindex: the same database answers the two-stage query correctly.
    expect(store.vectorCount).toBe(9);
  });

  it('sizes the pool by the larger of the floor and the ratio', () => {
    // The floor is what stops a small topK from asking for a pool it can learn nothing
    // from: topK=1 at factor 16 would propose sixteen candidates out of a whole library.
    expect(vectorPoolSize(1)).toBe(VEC_POOL_MIN);
    expect(vectorPoolSize(30)).toBe(30 * VEC_POOL_FACTOR);
    expect(vectorPoolSize(30, 2, 4)).toBe(60);
    expect(vectorPoolSize(1, 2, 4)).toBe(4);
  });
});
