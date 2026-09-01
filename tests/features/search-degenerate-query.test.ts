import { describe, it, expect } from 'vitest';
import { tokenize } from '../../src/features/search/tokenize.js';
import { MIN_PHRASE_TERMS, pruneTerms } from '../../src/features/search/query-terms.js';


describe('pruneTerms', () => {
  const prunable = (t: string) => ['the', 'of', 'to', 'in'].includes(t);

  it('drops the common terms when any content term survives', () => {
    expect(pruneTerms(['the', 'neural', 'networks'], prunable)).toEqual(['neural', 'networks']);
  });

  it('never abandons pruning while a term survives, however much was dropped', () => {
    // The property the whole design rests on, and the one an earlier version of this rule
    // got wrong. `in the brain` keeps one content word and drops two common ones; running
    // it unpruned puts documents that merely say "in the" ahead of the one about brains.
    // If a term survived, it is the query.
    expect(pruneTerms(['in', 'the', 'brain'], prunable)).toEqual(['brain']);
    expect(pruneTerms(['in', 'the', 'of', 'to', 'brain'], prunable)).toEqual(['brain']);
  });

  it('runs a phrase as typed when nothing at all survives', () => {
    expect(pruneTerms(['to', 'be', 'or', 'not'], () => true)).toEqual(['to', 'be', 'or', 'not']);
  });

  it('answers one or two common words with nothing, as search always has', () => {
    // Not the raw set: replacing a free honest miss with a slow arbitrary hit is not an
    // improvement. Measured, the bare query `the` goes from 0 ms and no results to 750 ms
    // and ten unrelated documents.
    expect(pruneTerms(['the'], prunable)).toEqual([]);
    expect(pruneTerms(['of', 'the'], prunable)).toEqual([]);
    expect(MIN_PHRASE_TERMS).toBe(3);
  });
});

describe('what the deleted list did to the query this fixes', () => {
  it('reduced to a single meaningless term under the list this replaces', () => {
    // The control, stated where it can still be stated: under the 29 English function words
    // this commit deletes, the whole line pruned down to `not` — one word, and one that
    // means nothing — so the search that ran was a single-term OR and the decoy below is
    // what it returned. The list is written out here rather than imported, because the point
    // is that it is gone.
    const asShipped = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
      'were', 'be', 'by', 'as', 'at', 'that', 'this', 'it', 'from', 'we', 'our', 'their', 'its',
      'these', 'those',
    ]);
    expect(pruneTerms([...new Set(tokenize('to be or not to be'))], (t) => asShipped.has(t))).toEqual(['not']);
  });

});
