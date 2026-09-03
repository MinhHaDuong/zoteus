import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { MemorySearchIndex, makeSnippet } from '../../src/features/search/index-manager.js';
import type { SearchIndex } from '../../src/features/search/backend.js';
import { tokenize } from '../../src/features/search/tokenize.js';
import { highDfMinimum, pruneTerms } from '../../src/features/search/query-terms.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const sqliteIt = hasSqlite ? it : it.skip;

/** Raw node:sqlite access, to age a fixture database into the state an older build left. */
const sqliteModule = hasSqlite
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

/** Take the droplist back out, which is exactly what a database written before it looks like. */
function forgetDroplist(jsonPath: string): void {
  const db = new DatabaseSync(sqliteIndexPath(jsonPath));
  db.exec("DELETE FROM meta WHERE key IN ('droplist', 'droplistPassages')");
  db.close();
}

/**
 * Ten items, and the shape matters more than the words.
 *
 * `zoteus` is in every one: a term with 100% document frequency that NO English stoplist
 * contains, which is the whole argument for deriving the list from the library instead of
 * shipping one. `the`, `of`, `to` and `be` are in most of them, so they clear the 30% bar
 * too — measured from the corpus rather than assumed from the language.
 *
 * `H` is the degenerate query's own answer. It is the only item that holds the soliloquy,
 * and every word of `to be or not to be` is a term this corpus prunes, so a policy that
 * merely drops high-df terms cannot retrieve it and one that falls back on degeneracy can.
 *
 * `D` is the decoy that makes the stock defect visible: `not` is not in upstream's 29-word
 * list, so `to be or not to be` reaches MATCH as the single term `not`, and D is what
 * comes back.
 */
const items = [
  {
    key: 'H',
    data: {
      itemType: 'book',
      title: 'Hamlet',
      abstractNote: 'zoteus edition. To be or not to be that is the question, whether tis nobler to suffer',
    },
  },
  {
    key: 'D',
    data: {
      itemType: 'book',
      title: 'Refusals',
      abstractNote: 'zoteus edition. Not not not not not: a study of negation and of refusal in the abstract',
    },
  },
  {
    key: 'G',
    data: { itemType: 'book', title: 'Organic gardening', abstractNote: 'zoteus edition. Growing tomatoes and herbs in the greenhouse' },
  },
  {
    key: 'V',
    data: { itemType: 'journalArticle', title: 'Computer vision', abstractNote: 'zoteus edition. Convolutional networks classify the images' },
  },
  {
    key: 'R',
    data: { itemType: 'journalArticle', title: 'Reinforcement', abstractNote: 'zoteus edition. Reward shaping for the policies of an agent' },
  },
  {
    key: 'C',
    data: { itemType: 'book', title: 'Cartography', abstractNote: 'zoteus edition. Projections of the sphere onto the plane' },
  },
  {
    key: 'B',
    data: { itemType: 'book', title: 'Baking', abstractNote: 'zoteus edition. Sourdough starters and the rye loaf' },
  },
  {
    key: 'M',
    data: { itemType: 'book', title: 'Mycology', abstractNote: 'zoteus edition. Fruiting bodies of the fungi to be catalogued' },
  },
  {
    key: 'A',
    data: { itemType: 'book', title: 'Astronomy', abstractNote: 'zoteus edition. Occultations of the outer planets to be timed' },
  },
  {
    key: 'P',
    data: { itemType: 'book', title: 'Pottery', abstractNote: 'zoteus edition. Slipware and the reduction firing of a kiln' },
  },
  // The decoy for abandoning the prune too eagerly: it says `the` over and over and
  // nothing about greenhouses, so it outranks G on any query that runs its common words.
  {
    key: 'I',
    data: {
      itemType: 'book',
      title: 'In the',
      abstractNote: 'zoteus edition. The the the the the the the the the the the the the the the the',
    },
  },
];

/**
 * Enough passages for a document frequency to mean anything.
 *
 * The rule under test declines to derive a list below `MIN_DERIVATION_PASSAGES`, because a
 * proportion of five documents is not a proportion. So a fixture that wants to exercise the
 * derivation has to be a corpus, and this is the cheapest honest one: every filler item
 * carries the same saturating vocabulary the narrative items above carry, so the ratios
 * they were designed around survive being scaled up, and each has content of its own so it
 * cannot be mistaken for a hit.
 */
const filler = Array.from({ length: 110 }, (_, i) => ({
  key: `F${String(i).padStart(3, '0')}`,
  data: {
    itemType: 'journalArticle',
    title: `Filler ${i}`,
    abstractNote: `zoteus edition. The report of the survey number ${i} is to be filed with the registry of the office`,
  },
}));


async function sqliteIndex(jsonPath = ''): Promise<SearchIndex> {
  const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
  await index.build([...items, ...filler]);
  return index;
}

async function memoryIndex(): Promise<SearchIndex> {
  const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
  await index.build([...items, ...filler]);
  return index;
}

const keys = async (index: SearchIndex, q: string, limit = 10): Promise<string[]> =>
  (await index.query(q, { limit, mode: 'keyword' })).map((h) => h.itemKey);

/** One meta row, read cold off the store — what the next process would see. */
function readMeta(jsonPath: string, key: string): string | undefined {
  const db = new DatabaseSync(sqliteIndexPath(jsonPath));
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  db.close();
  return row?.value;
}

/** One-page fetcher over a fixed item list, the shape the incremental paths crawl. */
function pageFetcher(list: any[], version = 42) {
  return async (start: number) => ({
    items: list.slice(start, start + 100),
    totalResults: list.length,
    lastModifiedVersion: version,
  });
}

describe('the droplist is derived from the library, not shipped with the code', () => {
  sqliteIt('prunes a term this corpus is saturated with, which no English stoplist holds', async () => {
    const index = await sqliteIndex();
    // Every item says "zoteus", so the term separates nothing and costs a full posting-list
    // walk. Two content terms survive the prune, so this query is answered on them alone.
    expect(await keys(index, 'zoteus tomatoes greenhouse')).toEqual(['G']);
    // The control that makes the assertion mean something: WITHOUT pruning, the same query
    // matches every item in the library, because `zoteus` does. Asked on its own, `zoteus`
    // prunes to nothing and the raw set runs — a query about the library's own saturating
    // vocabulary is answered slowly rather than not at all. See WhenNothingSurvives.
    expect((await keys(index, 'zoteus', 200)).length).toBe(items.length + filler.length);
    await index.close();
  });

  sqliteIt('answers a query of nothing but function words on its own content', async () => {
    const index = await sqliteIndex();
    // Every term of the soliloquy clears the 30% bar in this corpus, so fewer than two
    // survive and the raw set is what reaches MATCH. H holds the line; D is what stock
    // upstream returns, because `not` is the one word its 29-item list does not carry.
    expect((await keys(index, 'to be or not to be'))[0]).toBe('H');
    await index.close();
  });

  sqliteIt('sends a degenerate query exactly what an unpruned one would send', async () => {
    const index = await sqliteIndex();
    // The fallback's contract, asserted as an identity rather than as a spot check: a query
    // whose terms are all prunable must return what the unfiltered token set returns.
    const degenerate = await keys(index, 'to be or not to be', 20);
    const unfiltered = await keys(index, [...new Set(tokenize('to be or not to be'))].join(' '), 20);
    expect(degenerate).toEqual(unfiltered);
    expect(degenerate.length).toBeGreaterThan(1);
    await index.close();
  });

  sqliteIt('leaves an index built before this change filtering nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-droplist-'));
    const jsonPath = join(dir, 'search-index.json');
    const built = await sqliteIndex(jsonPath);
    await built.save();
    await built.close();

    // What an older build left behind: rows, meta, and no droplist. Taking the two keys out
    // is exactly the state a v1.12.0 database is in, and it must not be a stranded one.
    forgetDroplist(jsonPath);

    const reopened = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    // Unpruned: `zoteus` is searched on, so every item comes back — the pre-change answer.
    expect((await keys(reopened, 'zoteus tomatoes greenhouse', 200)).length).toBe(items.length + filler.length);
    await reopened.close();
  });

  sqliteIt('adopts a droplist on the first build over an index that had none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-droplist-adopt-'));
    const jsonPath = join(dir, 'search-index.json');
    const built = await sqliteIndex(jsonPath);
    await built.save();
    await built.close();

    forgetDroplist(jsonPath);

    const reopened = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await reopened.build([...items, ...filler]);
    await reopened.save();
    expect(await keys(reopened, 'zoteus tomatoes greenhouse')).toEqual(['G']);
    await reopened.close();
  });

  sqliteIt('prunes the same terms on both backends', async () => {
    const sqlite = await sqliteIndex();
    const memory = await memoryIndex();
    // The item SET, not its order: the two backends score with different BM25
    // implementations and the existing parity suite compares them the same way. What is
    // being asserted here is that the same terms reached each engine.
    for (const q of ['zoteus tomatoes greenhouse', 'to be or not to be', 'zoteus reward shaping policies']) {
      const s = (await keys(sqlite, q, 20)).sort();
      const m = (await keys(memory, q, 20)).sort();
      expect(s, `sqlite vs memory on "${q}"`).toEqual(m);
    }
    await sqlite.close();
  });
});

describe('the prune holds while a term survives, end to end', () => {
  sqliteIt('answers a one-survivor query on the survivor, not on the common words', async () => {
    const index = await sqliteIndex();
    // `the` clears the bar and is dropped; `greenhouse` survives and is the query. The
    // fixture holds a decoy that says `the` sixteen times and nothing about greenhouses —
    // any rule that runs the raw set here ranks it ahead of the answer.
    expect((await keys(index, 'the greenhouse'))[0]).toBe('G');
    await index.close();
  });
});

describe('the derivation declines to store a list that is the whole vocabulary', () => {
  sqliteIt('stores an empty list over a corpus where every term clears the bar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-droplist-vocab-'));
    const jsonPath = join(dir, 'search-index.json');
    // Enough passages for the derivation to run, and every one of them the same words: all
    // terms sit at 100% document frequency, so the 30% bar catches the entire vocabulary.
    const clones = Array.from({ length: 110 }, (_, i) => ({
      key: `S${String(i).padStart(3, '0')}`,
      data: { itemType: 'book', title: 'Sameness', abstractNote: 'identical words everywhere always' },
    }));
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await index.build(clones);
    await index.save();
    // A real derivation happened and recorded that nothing is prunable — the stored value
    // is an empty string, not an absent row, which is what separates this from an index
    // that never derived at all.
    expect(readMeta(jsonPath, 'droplist')).toBe('');
    // And pruning by the whole vocabulary is exactly what must not happen: the query still
    // answers on its words.
    expect((await keys(index, 'identical words', 200)).length).toBe(clones.length);
    await index.close();
  });
});

describe('a delta update rederives only past the drift bound', () => {
  sqliteIt('keeps the stored list through a small delta and rederives past 10%', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-droplist-drift-'));
    const jsonPath = join(dir, 'search-index.json');
    const corpus = [...items, ...filler];
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await index.buildIncremental(pageFetcher(corpus), { versionBackend: 'local' });
    const derivedAt = Number(readMeta(jsonPath, 'droplistPassages'));
    expect(derivedAt).toBeGreaterThan(0);

    // Five new items over this corpus is well under the 10% drift bound: the update must
    // NOT pay the vocabulary scan, so the stored count stays at the derivation point.
    const small = Array.from({ length: 5 }, (_, i) => ({
      key: `N${i}`,
      data: { itemType: 'book', title: `New ${i}`, abstractNote: `zoteus edition. Fresh material about topic ${i}` },
    }));
    const live = new Set([...corpus, ...small].map((i) => i.key));
    await index.updateIncremental({
      backend: 'local',
      fetchChanged: pageFetcher(small, 43),
      liveKeys: async () => live,
    });
    expect(Number(readMeta(jsonPath, 'droplistPassages'))).toBe(derivedAt);

    // Twenty more crosses the bound (25 added against the stored count), and the update
    // rederives: the stored count moves to the corpus the list now describes.
    const big = Array.from({ length: 20 }, (_, i) => ({
      key: `M${i}`,
      data: { itemType: 'book', title: `More ${i}`, abstractNote: `zoteus edition. Additional material about subject ${i}` },
    }));
    const live2 = new Set([...corpus, ...small, ...big].map((i) => i.key));
    await index.updateIncremental({
      backend: 'local',
      fetchChanged: pageFetcher(big, 44),
      liveKeys: async () => live2,
    });
    expect(Number(readMeta(jsonPath, 'droplistPassages'))).toBeGreaterThan(derivedAt);
    await index.close();
  });
});

describe('the droplist composes with query expansion: prune first, then expand the survivors', () => {
  /**
   * A corpus where the two transforms meet. `the` is common (it clears the 30% bar) and
   * the vocabulary also holds its accented sibling `thé`; `theorie` is rare and the
   * vocabulary holds `théorie`. The order is a decision, and it is prune-then-expand:
   * the droplist judges the TYPED terms, and expansion serves the survivors — so a
   * dropped common term must not be resurrected through its accented spellings, and a
   * surviving unaccented term must still reach the accented documents.
   */
  const accentedCorpus = [
    // The target: the only items about théorie. An unaccented query must reach them.
    { key: 'T1', data: { itemType: 'book', title: 'Théorie', abstractNote: 'La théorie des jeux' } },
    { key: 'T2', data: { itemType: 'book', title: 'Théorie encore', abstractNote: 'Une théorie générale' } },
    // The decoy: saturated with `thé` and with `the`, and about neither query.
    ...Array.from({ length: 108 }, (_, i) => ({
      key: `W${String(i).padStart(3, '0')}`,
      data: { itemType: 'book', title: `Blend ${i}`, abstractNote: `the thé harvest of the plantation record ${i}` },
    })),
  ];

  it('drops a common typed term without dragging in its accented spellings, and expands a survivor', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await index.build(accentedCorpus);
    // `the` clears the bar and is dropped; `theorie` survives and expands to `théorie`.
    // If expansion ran first — or a dropped term's variants were kept — the 108 thé
    // documents would swamp the two the query is about.
    const hits = (await index.query('the theorie', { mode: 'keyword', limit: 5 })).map((h) => h.itemKey);
    expect(hits.sort()).toEqual(['T1', 'T2']);
    // The survivor's expansion is real: alone, it reaches the accented documents too.
    const alone = (await index.query('theorie', { mode: 'keyword', limit: 5 })).map((h) => h.itemKey);
    expect(alone.sort()).toEqual(['T1', 'T2']);
  });

  sqliteIt('answers the same on the SQLite backend', async () => {
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath: '' });
    await index.build(accentedCorpus);
    const hits = (await index.query('the theorie', { mode: 'keyword', limit: 5 })).map((h) => h.itemKey);
    expect(hits.sort()).toEqual(['T1', 'T2']);
    await index.close();
  });
});

describe('snippets centre on content once the high-df terms are pruned', () => {
  const filler = 'the of and to be '.repeat(40);

  it('does not centre on a function word the passage opens with', () => {
    const text = `${filler}the tomatoes ripened in the greenhouse ${filler}`;
    // Nothing declared high-df: the raw token set is used, `the` is found at offset 0, and
    // the snippet is the passage opening — the regression deleting the stoplist would ship.
    expect(makeSnippet(text, 'the tomatoes')).not.toContain('tomatoes');
    // With `the` pruned, the same query centres on the one word that says where to look.
    expect(makeSnippet(text, 'the tomatoes', 240, (t) => t === 'the')).toContain('tomatoes');
  });

  it('keeps the raw set when the query is nothing but pruned terms', () => {
    const text = `${filler}the tomatoes ripened${filler}`;
    // One surviving term is enough to anchor a snippet, so the snippet rule is not the
    // MATCH rule; with none surviving it must still return the pre-change window rather
    // than an empty one.
    const all = makeSnippet(text, 'the of', 240, () => true);
    expect(all).toBe(makeSnippet(text, 'the of'));
  });
});

describe('the pruning rule itself', () => {
  it('puts the bar where the measured working point is', () => {
    expect(highDfMinimum(477512)).toBe(143254);
    expect(highDfMinimum(10)).toBe(3);
    // A corpus too small for document-frequency statistics prunes everything and therefore
    // degenerates, which is the same as pruning nothing.
    expect(highDfMinimum(3)).toBe(1);
  });

  it('never abandons pruning while a term survives, and runs the raw set when none does', () => {
    const terms = ['to', 'be', 'or', 'not'];
    // One survivor out of four is still the query. Abandoning the prune here is what put a
    // document saying "in the" sixty times ahead of the one about brains.
    expect(pruneTerms(terms, (t) => t !== 'not', 'raw')).toEqual(['not']);
    expect(pruneTerms(terms, (t) => t === 'to' || t === 'be', 'raw')).toEqual(['or', 'not']);
    // Nothing survives, and the list is measured rather than curated — so the raw set runs
    // rather than the search going silent on a term the library is merely saturated with.
    expect(pruneTerms(terms, () => true, 'raw')).toEqual(terms);
    // No droplist at all is not the same as an empty one, and neither prunes.
    expect(pruneTerms(terms, undefined, 'raw')).toEqual(terms);
  });
});

/**
 * The two query-side transforms together, because only the merged tree has both.
 *
 * The droplist arrived on a branch that predates `ZOTEUS_ACCENT_EXPANSION`, so nothing
 * before this merge could assert how they behave side by side. The order is the one the
 * droplist branch argued for and the one the code runs: prune the TYPED terms first, then
 * expand whatever the prune ruled worth running. Neither half may quietly disable the
 * other, and the flag governs exactly one of them.
 */
describe('the droplist and accent expansion, in the order they run', () => {
  const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

  /**
   * A corpus in which one term saturates and one accented spelling dominates.
   *
   * `zoteus` is in every passage, so the derivation prunes it. `théorie` is written with
   * its accent in three passages and never without, so an unaccented `theorie` clears the
   * dominance gate and expands. Nothing else connects the two, which is what makes the
   * assertions below separable.
   */
  const corpus = [
    ...Array.from({ length: 3 }, (_, i) => ({
      key: `T${i}`,
      data: {
        itemType: 'book',
        // Titled without the word, deliberately: the title is indexed too, and an
        // unaccented spelling anywhere in the fixture would answer the query below
        // without any expansion at all.
        title: `Essai ${i}`,
        abstractNote: 'zoteus edition. théorie économique et réalité industrielle',
      },
    })),
    ...Array.from({ length: 110 }, (_, i) => ({
      key: `F${String(i).padStart(3, '0')}`,
      data: {
        itemType: 'journalArticle',
        title: `Filler ${i}`,
        abstractNote: `zoteus edition. The report of the survey number ${i} is to be filed with the registry`,
      },
    })),
  ];

  async function expansionIndex(backend: 'memory' | 'sqlite', accentExpansion: boolean): Promise<SearchIndex> {
    const store = await createSearchIndex({
      embedder: null,
      logger: silentLogger,
      backend,
      jsonPath: '',
      accentExpansion,
    });
    await store.build(corpus);
    return store;
  }

  it.each(backends)('prunes the saturating term and expands the survivor (%s)', async (backend) => {
    const store = await expansionIndex(backend, true);
    // `zoteus` is in all 113 passages and is dropped; `theorie` survives and reaches the
    // accented documents through expansion. Both transforms fired, in that order.
    expect((await keys(store, 'zoteus theorie', 200)).sort()).toEqual(['T0', 'T1', 'T2']);
    await store.close();
  });

  it.each(backends)('still prunes with expansion off, and then answers as typed (%s)', async (backend) => {
    const store = await expansionIndex(backend, false);
    // The flag gates the expansion step and nothing else: `zoteus` is still dropped, so
    // this is not the whole library, and `theorie` now runs strictly as typed, which no
    // passage spells that way.
    expect(await keys(store, 'zoteus theorie', 200)).toEqual([]);
    // And the proof that pruning is what emptied it rather than the query missing
    // outright: the accented spelling still answers exactly, flag or no flag.
    expect((await keys(store, 'zoteus théorie', 200)).sort()).toEqual(['T0', 'T1', 'T2']);
    await store.close();
  });

  it.each(backends)('leaves a dropped term no expansion of its own (%s)', async (backend) => {
    const store = await expansionIndex(backend, true);
    // A dropped term takes its spellings with it: `zoteus` never reaches the variants
    // lookup, so a query carrying it beside a content word costs one posting list rather
    // than the library. Asked alone it prunes to nothing and the raw set runs, which is
    // the degeneracy fallback rather than an expansion.
    expect((await keys(store, 'zoteus theorie', 200)).sort()).toEqual(['T0', 'T1', 'T2']);
    expect((await keys(store, 'zoteus', 200)).length).toBe(corpus.length);
    await store.close();
  });
});
