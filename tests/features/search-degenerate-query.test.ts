import { describe, it, expect } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex, makeSnippet } from '../../src/features/search/index-manager.js';
import type { SearchIndex } from '../../src/features/search/backend.js';
import { isStopword, tokenize } from '../../src/features/search/tokenize.js';
import { MIN_PHRASE_TERMS, pruneTerms } from '../../src/features/search/query-terms.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

/**
 * Ten items, and two of them carry the whole argument.
 *
 * `H` is the only item holding the soliloquy, so it is the right answer to the degenerate
 * query. `D` is the decoy that makes the defect visible rather than theoretical: `not` is
 * the one word of `to be or not to be` that the shipped 29-word list does NOT carry, so on
 * a stock build the query reaches MATCH as the single term `not`, and D — which says
 * nothing else — is what comes back. A confident answer to a question nobody asked.
 */
const items = [
  { key: 'H', data: { itemType: 'book', title: 'Hamlet', abstractNote: 'To be or not to be that is the question, whether tis nobler to suffer' } },
  { key: 'D', data: { itemType: 'book', title: 'Refusals', abstractNote: 'Not not not not not: a study of negation and of refusal in the abstract' } },
  { key: 'G', data: { itemType: 'book', title: 'Organic gardening', abstractNote: 'Growing tomatoes and herbs in the greenhouse' } },
  { key: 'V', data: { itemType: 'journalArticle', title: 'Computer vision', abstractNote: 'Convolutional networks classify the images' } },
  { key: 'R', data: { itemType: 'journalArticle', title: 'Reinforcement', abstractNote: 'Reward shaping for the policies of an agent' } },
  { key: 'C', data: { itemType: 'book', title: 'Cartography', abstractNote: 'Projections of the sphere onto the plane' } },
  { key: 'B', data: { itemType: 'book', title: 'Baking', abstractNote: 'Sourdough starters and the rye loaf' } },
  { key: 'M', data: { itemType: 'book', title: 'Mycology', abstractNote: 'Fruiting bodies of the fungi to be catalogued' } },
  { key: 'A', data: { itemType: 'book', title: 'Astronomy', abstractNote: 'Occultations of the outer planets to be timed' } },
  { key: 'P', data: { itemType: 'book', title: 'Pottery', abstractNote: 'Slipware and the reduction firing of a kiln' } },
  // The decoy for the OTHER direction: it says `in the` over and over and nothing about
  // greenhouses, so it outranks the real answer on any query that abandons pruning.
  { key: 'I', data: { itemType: 'book', title: 'In the', abstractNote: 'In the in the in the in the in the in the in the in the in the in the' } },
];

async function sqliteIndex(): Promise<SearchIndex> {
  const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath: '' });
  await index.build(items);
  return index;
}

async function memoryIndex(): Promise<SearchIndex> {
  const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
  await index.build(items);
  return index;
}

const keys = async (index: SearchIndex, q: string, limit = 10): Promise<string[]> =>
  (await index.query(q, { limit, mode: 'keyword' })).map((h) => h.itemKey);

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

describe('a query that prunes down to nothing is answered on what the user typed', () => {
  it('reduced to a single meaningless term before `not` was on the list', () => {
    // The control, stated where it can still be stated: with the list as it shipped, the
    // whole line pruned down to `not` — one word, and one that means nothing — so the
    // search that ran was a single-term OR and the decoy below is what it returned. The old
    // list is written out here rather than imported, because the point is what it lacked.
    const asShipped = new Set([
      'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
      'were', 'be', 'by', 'as', 'at', 'that', 'this', 'it', 'from', 'we', 'our', 'their', 'its',
      'these', 'those',
    ]);
    expect(pruneTerms([...new Set(tokenize('to be or not to be'))], (t) => asShipped.has(t))).toEqual(['not']);
    // And with `not` on it, nothing survives — so the phrase runs as typed instead.
    expect(pruneTerms([...new Set(tokenize('to be or not to be'))], isStopword))
      .toEqual([...new Set(tokenize('to be or not to be'))]);
  });

  sqliteIt('returns the soliloquy, not the decoy', async () => {
    const index = await sqliteIndex();
    // D is what the single-term OR on `not` returned: it says nothing else, and `not` five
    // times. H holds the line. The phrase now runs whole, and H is what comes back.
    expect((await keys(index, 'negation refusal'))[0]).toBe('D');
    expect((await keys(index, 'to be or not to be'))[0]).toBe('H');
    await index.close();
  });

  sqliteIt('leaves an ordinary query with one content word pruned, whatever surrounds it', async () => {
    const index = await sqliteIndex();
    // The regression this rule exists to prevent, at the level a user would feel it. The
    // fixture holds an item that says "in the" and nothing about greenhouses; if the prune
    // were abandoned here it would rank ahead of G on the common words alone.
    for (const q of ['the greenhouse', 'in the greenhouse', 'in the of the greenhouse']) {
      expect((await keys(index, q))[0], q).toBe('G');
    }
    await index.close();
  });

  sqliteIt('sends a degenerate query exactly what an unpruned one would send', async () => {
    const index = await sqliteIndex();
    // The fallback's contract as an identity rather than as a spot check.
    const degenerate = await keys(index, 'to be or not to be', 20);
    const unfiltered = await keys(index, [...new Set(tokenize('to be or not to be'))].join(' '), 20);
    expect(degenerate).toEqual(unfiltered);
    expect(degenerate.length).toBeGreaterThan(1);
    await index.close();
  });

  sqliteIt('leaves an ordinary query pruned exactly as before', async () => {
    const index = await sqliteIndex();
    // The other half of the contract, and the one a reviewer should care about most: three
    // content terms survive, the floor is met, and the function words are dropped as they
    // always were. Nothing about ordinary search changes.
    expect(pruneTerms([...new Set(tokenize('the growing of tomatoes in the greenhouse'))], isStopword))
      .toEqual(['growing', 'tomatoes', 'greenhouse']);
    expect(await keys(index, 'the growing of tomatoes in the greenhouse')).toEqual(['G']);
    await index.close();
  });

  sqliteIt('answers a bare common word with nothing, and does it for free', async () => {
    const index = await sqliteIndex();
    // The regression this rule exists to avoid, pinned on both spellings. `thé` is French
    // for tea and the tokenizer folds it onto `the`, so a French tea query reaches exactly
    // this path — and must not come back with a page of English documents.
    expect(await keys(index, 'the', 20)).toEqual([]);
    expect(await keys(index, 'thé', 20)).toEqual([]);
    expect(await keys(index, 'of the', 20)).toEqual([]);
    await index.close();
  });

  sqliteIt('leaves a short query with one content word on the pruned path', async () => {
    const index = await sqliteIndex();
    // One common word dropped, one content word kept, and the content word alone is the
    // right query — not the pair. G is the only item about greenhouses.
    expect(await keys(index, 'the greenhouse')).toEqual(['G']);
    await index.close();
  });

  sqliteIt('answers the same on both backends', async () => {
    const sqlite = await sqliteIndex();
    const memory = await memoryIndex();
    // The item SET, not its order: the two engines score differently and the existing
    // parity suite compares them the same way. What is asserted is that the same terms
    // reached each one.
    for (const q of ['to be or not to be', 'the growing of tomatoes in the greenhouse', 'of the']) {
      expect((await keys(sqlite, q, 20)).sort(), `sqlite vs memory on "${q}"`).toEqual((await keys(memory, q, 20)).sort());
    }
    await sqlite.close();
  });
});

describe('both backends index every term, so the fallback has something to match', () => {
  it('tokenize no longer consults the list', () => {
    // The document side. It used to drop these, which is why the in-memory backend could
    // not answer a fallback query at all: the terms were not in it.
    expect(tokenize('the a of neural x networks')).toEqual(['the', 'of', 'neural', 'networks']);
  });

  it('the in-memory backend answers the phrase on terms it had to have indexed', async () => {
    const memory = await memoryIndex();
    // The index-side half of the fix, and the half a query-side-only patch would silently
    // omit. `addDoc` used to tokenize the list away, so `to`, `be` and `or` were not in this
    // backend at all: the phrase would have matched nothing whatever the query side did.
    expect((await keys(memory, 'to be or not to be'))[0]).toBe('H');
    await memory.close();
  });
});

describe('snippets take the same rule', () => {
  const filler = 'the of and to be '.repeat(40);
  const text = `${filler}the tomatoes ripened in the greenhouse ${filler}`;

  it('centres on the content word rather than the passage opening', () => {
    // One term survives, and one is enough to know where to look.
    expect(makeSnippet(text, 'the tomatoes')).toContain('tomatoes');
  });

  it('falls back to the passage opening only when nothing at all survives', () => {
    // Nothing left to centre on: the snippet is where it has always been, at character 0,
    // which is the pre-existing behaviour and not a regression this introduces.
    expect(makeSnippet(text, 'the of and')).not.toContain('tomatoes');
  });
});
