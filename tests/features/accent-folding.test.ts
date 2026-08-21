import { describe, it, expect } from 'vitest';
import { tokenize, normalizeForSearch } from '../../src/features/search/tokenize.js';
import { SearchIndex, makeSnippet } from '../../src/features/search/index-manager.js';
import { MemoryPassageStore, type PassageStore } from '../../src/features/search/passage-store.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';

/**
 * Ticket 0009. `tokenize()` used to match `[a-z0-9]+` over lowercased text, which shredded
 * every accented or non-Latin query before either backend saw it — on FTS5 that turned
 * `théorie` into `"th" OR "orie"`, and `"th"` matched 1 904 documents of ordinary English
 * prose in the author's library (jaccard 0,00 against the JSON backend's correct answer).
 *
 * The fix folds in JS, in front of the shared tokeniser, so index side and query side pass
 * through one function on both backends. What that function must reproduce is
 * `unicode61 remove_diacritics 2`, because the FTS5 *document* side is tokenised by SQLite
 * and cannot be moved into JS: `passages.body` is the display text `get()` reads back for
 * snippets. Every case below is therefore a symmetry assertion as much as a recall one.
 */

/** One store of each kind, so every case is asserted on both backends. */
function eachStore(): Array<[string, () => PassageStore]> {
  return [
    ['MemoryPassageStore', () => new MemoryPassageStore()],
    ['Fts5PassageStore', () => new Fts5PassageStore(':memory:')],
  ];
}

/** A store holding one passage, so a hit is unambiguous. */
function withDoc(make: () => PassageStore, text: string): PassageStore {
  const store = make();
  store.add({ id: 'D#0', itemKey: 'D', title: 'Fixture', text });
  return store;
}

const found = (store: PassageStore, q: string) => store.search(q, 5).map((h) => h.id);

describe.each(eachStore())('accent folding on %s', (_name, make) => {
  it('finds an accented word from the accented spelling', () => {
    expect(found(withDoc(make, 'un élève très appliqué'), 'élève')).toEqual(['D#0']);
  });

  it('finds the accented document from the unaccented spelling', () => {
    expect(found(withDoc(make, 'un élève très appliqué'), 'eleve')).toEqual(['D#0']);
  });

  it('finds the unaccented document from the accented spelling', () => {
    expect(found(withDoc(make, 'un eleve tres applique'), 'élève')).toEqual(['D#0']);
  });

  it('does not shred a French word into a high-frequency fragment', () => {
    // The defect, stated as retrieval: "théorie" must not reach an English-only passage.
    const store = make();
    store.add({ id: 'FR#0', itemKey: 'FR', title: 'Théorie', text: 'théorie économique et réalité industrielle' });
    store.add({ id: 'EN#0', itemKey: 'EN', title: 'English', text: 'the theatre thrives on thoughtful themes throughout' });
    expect(found(store, 'théorie')).toEqual(['FR#0']);
  });

  it('keeps a Greek word whole and finds it either cased', () => {
    const store = withDoc(make, 'Θεωρία της αξίας στην πολιτική οικονομία');
    expect(found(store, 'θεωρία')).toEqual(['D#0']);
    expect(found(store, 'Θεωρία')).toEqual(['D#0']);
  });

  it('keeps a Cyrillic word whole', () => {
    expect(found(withDoc(make, 'Теория стоимости'), 'теория')).toEqual(['D#0']);
  });

  it('keeps a CJK run whole', () => {
    expect(found(withDoc(make, '日本語の研究'), '日本語の研究')).toEqual(['D#0']);
  });

  it('strips Vietnamese tone marks but keeps đ, which is a letter and not a diacritic', () => {
    // Decision recorded in tokenize.ts: đ does NOT fold to d. unicode61 keeps it
    // ("đại" indexes as "đai"), so folding it in JS would re-create this very defect on
    // the SQLite backend. The cost is that the ASCII spelling "dai" does not reach it.
    const store = withDoc(make, 'đại học Việt Nam');
    expect(found(store, 'đại')).toEqual(['D#0']);
    expect(found(store, 'Viet')).toEqual(['D#0']);
    expect(found(store, 'Việt')).toEqual(['D#0']);
    expect(found(store, 'dai')).toEqual([]);
  });

  /**
   * The letters Zotero's `normalizeForSearch` hand-maps (`ø œ æ ł đ ð þ ß ı`) are the trap
   * here, which is why they are in this list. unicode61 keeps every one of them, so a hand
   * map copied over from Zotero would fold the query somewhere the FTS5 index is not — the
   * very defect this ticket repairs, re-created for Norwegian, Polish and Vietnamese. Each
   * word must reach a passage spelled exactly as typed; that is the symmetry, asserted
   * without reaching into either tokenizer.
   */
  it.each([
    'élève', 'théorie', 'Việt', 'đại', 'søren', 'œuvre', 'łódź', 'straße', 'ışık',
    'Θεωρία', 'λόγος', 'теория', '日本語', 'naïve', 'École',
  ])('a word reaches a passage spelled the same way: %s', (word) => {
    expect(found(withDoc(make, `avant ${word} apres`), word)).toEqual(['D#0']);
  });

  it('still answers [] rather than throwing when nothing survives tokenisation', () => {
    const store = withDoc(make, 'un élève très appliqué');
    expect(found(store, '!!! ??? ***')).toEqual([]);
    expect(found(store, 'the a an of')).toEqual([]);
    expect(found(store, '')).toEqual([]);
    expect(found(store, '   ')).toEqual([]);
  });
});

describe('normalizeForSearch', () => {
  it('folds Latin diacritics and case', () => {
    expect(normalizeForSearch('Élève Théorie Straße')).toBe('eleve theorie straße');
  });

  it('leaves non-Latin diacritics alone, because remove_diacritics 2 does', () => {
    expect(normalizeForSearch('Θεωρία')).toBe('θεωρία');
    expect(normalizeForSearch('Йошкар')).toBe('йошкар');
  });

  it('folds the Greek final sigma, because unicode61 does', () => {
    expect(normalizeForSearch('λόγος')).toBe('λόγοσ');
  });

  it('is idempotent', () => {
    for (const s of ['élève', 'Θεωρία', 'đại', '日本語', 'Straße', 'ﬁle']) {
      expect(normalizeForSearch(normalizeForSearch(s))).toBe(normalizeForSearch(s));
    }
  });
});

describe('tokenize', () => {
  it('keeps an accented word as one folded token', () => {
    expect(tokenize('théorie')).toEqual(['theorie']);
    expect(tokenize('élève')).toEqual(['eleve']);
  });

  it('keeps non-Latin words as whole tokens', () => {
    expect(tokenize('Θεωρία')).toEqual(['θεωρία']);
    expect(tokenize('теория')).toEqual(['теория']);
    expect(tokenize('日本語の研究')).toEqual(['日本語の研究']);
  });

  it('still drops stopwords and one-character tokens', () => {
    expect(tokenize('the a of neural x networks')).toEqual(['neural', 'networks']);
  });
});

describe('a JSON snapshot written before the fold answers accented queries after it', () => {
  it('re-tokenises on load, so no stored index is left stale by this change', async () => {
    // The snapshot holds raw passage text, not terms: loadFromJSON replays it through
    // store.add(), which re-tokenises. That is why this change needs no index version bump
    // and no forced rebuild — the derived term set is rebuilt on every load by construction.
    const written = new SearchIndex({ embedder: null, store: new MemoryPassageStore() });
    await written.build([
      { key: 'X', data: { itemType: 'thesis', title: 'Scolarité', abstractNote: 'un élève très appliqué' } },
    ]);
    const snapshot = JSON.parse(JSON.stringify(written.toJSON()));

    const reloaded = new SearchIndex({ embedder: null, store: new MemoryPassageStore() });
    reloaded.loadFromJSON(snapshot);
    expect((await reloaded.query('eleve', { limit: 3 }))[0]!.itemKey).toBe('X');
    expect((await reloaded.query('élève', { limit: 3 }))[0]!.itemKey).toBe('X');
  });
});

describe('makeSnippet', () => {
  it('centres on an accented term, which it could not locate before the fold', () => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(6);
    const snippet = makeSnippet(`${filler}un élève très appliqué ${filler}`, 'élève');
    expect(snippet).toContain('élève');
    // Folding the haystack must not fold what is shown: the snippet is display text.
    expect(snippet).not.toContain('eleve ');
  });

  it('locates the accented passage from the unaccented spelling too', () => {
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(6);
    expect(makeSnippet(`${filler}un élève très appliqué ${filler}`, 'eleve')).toContain('élève');
  });
});

/**
 * The twelve codepoints the committed sweep caught going the WRONG way.
 *
 * `bench/results/0009-fold-sweep/codepoints.json` compares this fold against a real FTS5
 * table declared with the shipped tokenizer, codepoint by codepoint. Before these two
 * shields it reported twelve divergences classified `misses` — the query resolving to a
 * token the index does not hold, which is 0009's own defect on rarer input rather than the
 * harmless narrowing an earlier reading called it.
 *
 * Pinned here rather than left to the sweep because the sweep is a bench script nobody runs
 * on a pull request. The expected values are what SQLite's `unicode61 remove_diacritics 2`
 * actually stores, read off that artifact — not what a reading of the Unicode tables
 * suggests it ought to.
 */
describe('codepoints unicode61 does not fold the way JavaScript would (ticket 0009 sweep)', () => {
  it('keeps the mark on letters whose base is itself non-ASCII Latin', () => {
    // NFD decomposes these and the mark-stripping rule would give `a æ ʒ æ ø`, each of
    // which is a token other documents really contain — confident and wrong, not empty.
    expect(normalizeForSearch('Ǡ')).toBe('ǡ');
    expect(normalizeForSearch('ǡ')).toBe('ǡ');
    expect(normalizeForSearch('Ǣ')).toBe('ǣ');
    expect(normalizeForSearch('Ǯ')).toBe('ǯ');
    expect(normalizeForSearch('Ǽ')).toBe('ǽ');
    expect(normalizeForSearch('Ǿ')).toBe('ǿ');
    // Still lowercased, because unicode61 does lowercase them — the shield is against the
    // mark stripping alone, not against the whole fold.
    expect(normalizeForSearch('ǠǢǮǼǾ')).toBe('ǡǣǯǽǿ');
  });

  it('leaves alone the two Greek codepoints unicode61 does not transform', () => {
    // U+037F is newer than unicode61's case table: the index stores it uppercase.
    expect(normalizeForSearch('Ϳ')).toBe('Ϳ');
    // U+0374 is left as-is by SQLite while `normalize` maps it to U+02B9 — two codepoints
    // that print alike and never match.
    expect(normalizeForSearch('\u0374')).toBe('\u0374');
  });

  it('shields nothing when the text contains none of them, and does not leak a placeholder', () => {
    // The shield hides characters behind U+FDD0..U+FDEF noncharacters. A restore that
    // failed would leave one of those in a token, and it would match nothing forever.
    const folded = normalizeForSearch('Théorie générale de l\'emploi Ǽ Ϳ');
    expect(folded).toBe('theorie generale de l\'emploi ǽ Ϳ');
    expect(/[\ufdd0-\ufdef]/u.test(folded)).toBe(false);
    expect(normalizeForSearch('plain ascii text')).toBe('plain ascii text');
  });
});
