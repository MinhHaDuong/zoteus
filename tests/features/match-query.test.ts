import { describe, it, expect } from 'vitest';
import { toMatchQuery } from '../../src/features/search/match-query.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';

/**
 * Every string here is one an FTS5 `MATCH` would choke on if it were passed through raw:
 * an unbalanced quote, an operator, a leading `-`. BM25Index tokenises the query itself
 * and so has never been exposed to any of it; the sanitiser is what buys FTS5 the same
 * immunity. The store assertions below are the ones that matter — a sanitiser that returns
 * a plausible-looking string SQLite still rejects would pass a pure-string test.
 */
const HOSTILE = [
  "d'eau",
  'say "hello" now',
  'wildcard*',
  'gate NEAR ablation',
  '-term',
  '(unbalanced',
  'closing)',
  'neural AND networks',
  'neural OR networks',
  'column:value',
  '^anchored',
  'a "b" (c) -d*',
  '',
  '   ',
  '\t\n',
  'the a an and or of to in on for', // stopwords only
  'x', // single character only
  '!!! ???',
  '☃☃☃',
];

describe('toMatchQuery', () => {
  it('quotes each surviving token and ORs them, matching the JS index semantics', () => {
    expect(toMatchQuery('neural networks')).toBe('"neural" OR "networks"');
  });

  it('drops stopwords and 1-char tokens exactly as tokenize() does', () => {
    expect(toMatchQuery('the a of neural x networks')).toBe('"neural" OR "networks"');
  });

  it('de-duplicates a repeated term', () => {
    expect(toMatchQuery('gate gate GATE')).toBe('"gate"');
  });

  it('strips the query language out of hostile input', () => {
    // Punctuation is gone, so nothing is left to escape and no operator survives.
    expect(toMatchQuery("d'eau")).toBe('"eau"');
    expect(toMatchQuery('say "hello" now')).toBe('"say" OR "hello" OR "now"');
    expect(toMatchQuery('wildcard*')).toBe('"wildcard"');
    expect(toMatchQuery('gate NEAR ablation')).toBe('"gate" OR "near" OR "ablation"');
    expect(toMatchQuery('-term')).toBe('"term"');
    expect(toMatchQuery('neural AND networks')).toBe('"neural" OR "networks"');
    expect(toMatchQuery('column:value')).toBe('"column" OR "value"');
  });

  it('returns null when nothing survives, so search() can skip the MATCH entirely', () => {
    expect(toMatchQuery('')).toBeNull();
    expect(toMatchQuery('   ')).toBeNull();
    expect(toMatchQuery('!!! ???')).toBeNull();
    expect(toMatchQuery('the a an and or of')).toBeNull();
    expect(toMatchQuery('x')).toBeNull();
  });
});

describe('Fts5PassageStore.search survives hostile queries', () => {
  const store = new Fts5PassageStore(':memory:');
  store.add({ id: 'A#0', itemKey: 'A', title: 'Water', text: "the d'eau gate ablation of neural networks" });
  store.add({ id: 'B#0', itemKey: 'B', title: 'Garden', text: 'tomatoes and herbs' });

  it.each(HOSTILE.map((q) => [JSON.stringify(q), q] as const))('never throws on %s', (_label, q) => {
    const hits = store.search(q, 5);
    expect(Array.isArray(hits)).toBe(true);
    for (const h of hits) expect(h.score).toBeGreaterThan(0);
  });

  it('returns hits for the sanitised form of an apostrophe query', () => {
    expect(store.search("d'eau", 5).map((h) => h.id)).toEqual(['A#0']);
  });

  it('returns [] rather than issuing a MATCH when nothing survives', () => {
    expect(store.search('the a an', 5)).toEqual([]);
    expect(store.search('', 5)).toEqual([]);
  });
});
