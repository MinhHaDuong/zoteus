import { describe, it, expect, beforeAll } from 'vitest';
import { SearchIndex } from '../../src/features/search/index-manager.js';
import { MemoryPassageStore } from '../../src/features/search/passage-store.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';

/**
 * The comparison gate: the FTS5 store must retrieve what the JS index retrieves.
 *
 * Scores are deliberately not compared. FTS5's bm25() runs different k1/b parameters over a
 * different tokenizer with no stopword list, so the numbers cannot agree and an assertion
 * on them would only encode today's accident. What has to agree is the *retrieval*: which
 * items a query surfaces, and whether it surfaces anything at all.
 *
 * Both indexes are built with no embedder, so ranking is purely the keyword side — the
 * only thing the store is responsible for.
 */
const CORPUS = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Deep learning for computer vision', abstractNote: 'convolutional neural networks classify images from labelled datasets' } },
  { key: 'B', data: { itemType: 'book', title: 'Organic gardening', abstractNote: 'growing tomatoes herbs and compost in a small urban garden' } },
  { key: 'C', data: { itemType: 'journalArticle', title: 'Reinforcement learning', abstractNote: 'reward shaping for neural network policies in continuous control' } },
  { key: 'D', data: { itemType: 'journalArticle', title: 'Glacier mass balance', abstractNote: 'satellite altimetry measures ice thickness change across the greenland ice sheet' } },
  { key: 'E', data: { itemType: 'report', title: 'Carbon pricing instruments', abstractNote: 'emissions trading schemes and carbon taxes compared across jurisdictions' } },
  { key: 'F', data: { itemType: 'book', title: 'Bayesian inference', abstractNote: 'markov chain monte carlo sampling for posterior distributions' } },
  { key: 'G', data: { itemType: 'journalArticle', title: 'Sedimentary geology', abstractNote: 'layering in the outcrop records ancient river deltas and floodplains' } },
  { key: 'H', data: { itemType: 'journalArticle', title: 'Urban transport modelling', abstractNote: 'travel demand elasticity and congestion pricing in metropolitan networks' } },
  // Accented, with the unaccented spelling alongside it: kept from ticket 0002, when the
  // JS index could only reach this item through the plain spelling. See the note below.
  { key: 'I', data: { itemType: 'thesis', title: 'Suivi scolaire', abstractNote: "le niveau de l'eleve progresse quand un élève motivé lit davantage" } },
  { key: 'J', data: { itemType: 'journalArticle', title: 'Protein folding', abstractNote: 'alphafold predicts tertiary structure from amino acid sequence alignments' } },
];

const QUERIES = [
  'neural networks',
  'learning',
  'tomatoes compost',
  'reinforcement learning policies',
  'greenland ice sheet altimetry',
  'carbon emissions trading',
  'monte carlo posterior',
  'river deltas outcrop',
  'congestion pricing networks',
  'amino acid sequence',
  'eleve', // accented corpus: unicode61 remove_diacritics 2 on one side, the JS fold on both
  'élève', // and the same query accented — the direction ticket 0009 repaired
  "d'eau", // apostrophe: hostile to MATCH, and absent from the corpus on both sides
  'the a of', // nothing survives tokenisation on either side
];

describe('retrieval parity: FTS5 store against the JS index', () => {
  const js = new SearchIndex({ embedder: null, store: new MemoryPassageStore() });
  const fts = new SearchIndex({ embedder: null, store: new Fts5PassageStore(':memory:') });

  beforeAll(async () => {
    await js.build(CORPUS);
    await fts.build(CORPUS);
    expect(js.status().documents).toBe(fts.status().documents);
  });

  it.each(QUERIES)('%s — FTS5 top-3 items are among the JS index top-5', async (q) => {
    const reference = (await js.query(q, { limit: 5 })).map((h) => h.itemKey);
    const candidate = (await fts.query(q, { limit: 3 })).map((h) => h.itemKey);
    for (const key of candidate) expect(reference).toContain(key);
  });

  it.each(QUERIES)('%s — neither backend goes empty while the other answers', async (q) => {
    const reference = await js.query(q, { limit: 5 });
    const candidate = await fts.query(q, { limit: 5 });
    expect(candidate.length === 0).toBe(reference.length === 0);
  });

  it('finds the accented item from an ASCII query on both sides, now for the same reason', async () => {
    // Both sides fold: FTS5 through remove_diacritics 2 at index time, the JS index through
    // tokenize()'s own normalizeForSearch on both sides. Before ticket 0009 the JS index
    // passed this only because the fixture also spells "eleve" plainly — parity was a
    // coincidence of the corpus, which is why the next test drops that crutch.
    expect((await js.query('eleve', { limit: 3 }))[0]!.itemKey).toBe('I');
    expect((await fts.query('eleve', { limit: 3 }))[0]!.itemKey).toBe('I');
  });

  it('reaches a purely accented passage on both backends, from either spelling', async () => {
    // Ticket 0002 asserted here that the JS index returned nothing where FTS5 returned the
    // item, and 0001's invariant carried that as a stated exception. Ticket 0009 removed
    // the exception rather than the test: the fold now happens in JS, in front of the
    // tokenizer both stores share, so the two backends answer the same on both spellings.
    const accented = [{ key: 'X', data: { itemType: 'thesis', title: 'Scolarité', abstractNote: 'un élève très appliqué' } }];
    const jsOnly = new SearchIndex({ embedder: null, store: new MemoryPassageStore() });
    const ftsOnly = new SearchIndex({ embedder: null, store: new Fts5PassageStore(':memory:') });
    await jsOnly.build(accented);
    await ftsOnly.build(accented);
    for (const spelling of ['eleve', 'élève']) {
      expect((await jsOnly.query(spelling, { limit: 3 }))[0]!.itemKey).toBe('X');
      expect((await ftsOnly.query(spelling, { limit: 3 }))[0]!.itemKey).toBe('X');
    }
  });
});

/**
 * A graded-relevance corpus: eight passages of identical token length whose only
 * difference is how often they say "signal" (8 times down to 1). Every document matches,
 * so the query cannot be answered by membership alone — only by ranking.
 *
 * This exists because the topical queries above do not, on their own, make the gate bite:
 * each of them matches two or three items, so "FTS5 top-3 within the JS top-5" holds no
 * matter what order the hits come back in. Verified by sabotage — reversing the store's
 * ORDER BY left every topical query green and only this corpus turned red.
 */
const GRADED = Array.from({ length: 8 }, (_, i) => {
  const repeats = 8 - i;
  const filler = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  const words = [
    ...Array.from({ length: repeats }, () => 'signal'),
    ...Array.from({ length: 30 - repeats }, (_, k) => filler[k % filler.length]),
  ];
  return { key: `R${repeats}`, data: { itemType: 'journalArticle', title: `Trace ${i}`, abstractNote: words.join(' ') } };
});

describe('ranking parity on a graded corpus', () => {
  const js = new SearchIndex({ embedder: null, store: new MemoryPassageStore() });
  const fts = new SearchIndex({ embedder: null, store: new Fts5PassageStore(':memory:') });

  beforeAll(async () => {
    await js.build(GRADED);
    await fts.build(GRADED);
  });

  it('agrees on which passages are most relevant, not merely on which match', async () => {
    const reference = (await js.query('signal', { limit: 5 })).map((h) => h.itemKey);
    const candidate = (await fts.query('signal', { limit: 3 })).map((h) => h.itemKey);
    expect(reference).toHaveLength(5); // all eight match; the gate is about order
    expect(candidate).toHaveLength(3);
    for (const key of candidate) expect(reference).toContain(key);
  });

  it('neither backend goes empty while the other answers', async () => {
    const reference = await js.query('signal', { limit: 5 });
    const candidate = await fts.query('signal', { limit: 5 });
    expect(candidate.length === 0).toBe(reference.length === 0);
  });
});
