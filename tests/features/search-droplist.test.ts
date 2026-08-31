import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { makeSnippet } from '../../src/features/search/index-manager.js';
import { tokenize, pruneByDocumentFrequency } from '../../src/features/search/tokenize.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const sqliteIt = hasSqlite ? it : it.skip;
// Loaded once, at module scope, so Node 20 skips the SQLite cases without ever touching
// the constructor — the same shape the schema-version suite uses.
const sqliteModule = hasSqlite
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

/**
 * A corpus whose function words are pervasive and whose content words are not, which is
 * the only shape in which a document-frequency rule has anything to say. Ten items, one
 * passage each; `to be or not to be` appears in exactly one of them.
 *
 * DECOY is what makes the first case discriminating: it is short and says `not` twice, so
 * a search that has kept `not` alone out of the soliloquy ranks IT first. A corpus without
 * it would let the broken behaviour pass.
 */
const items = [
  { key: 'HAMLET00', title: 'Hamlet, Act III', abstractNote: 'To be, or not to be, that is the question.' },
  { key: 'DECOY000', title: 'Not applicable', abstractNote: 'Not measured, and not reported.' },
  { key: 'ENTROPY0', title: 'A note on entropy', abstractNote: 'The entropy of the ensemble is what we are to compute, or so it is said.' },
  { key: 'MANUSCR0', title: 'The manuscript', abstractNote: 'A manuscript that is to be read, or not, as the reader decides.' },
  { key: 'CATALOG0', title: 'The catalogue', abstractNote: 'This is the catalogue of the collection, to be revised.' },
  { key: 'LEDGER00', title: 'The ledger', abstractNote: 'The ledger is to be balanced, or it is not a ledger at all.' },
  { key: 'ARCHIVE0', title: 'The archive', abstractNote: 'What is in the archive is to be kept, or it is not archived.' },
  { key: 'PRESS000', title: 'The press', abstractNote: 'The press is to be trusted, or it is not the press.' },
  { key: 'BINDING0', title: 'The binding', abstractNote: 'The binding is to be repaired, or the book is not to be lent.' },
  { key: 'MARGIN00', title: 'The margin', abstractNote: 'The margin is to be wide, that a reader is to be able to write in it.' },
];

const open = async (backend: 'sqlite' | 'memory', dir: string) =>
  createSearchIndex({ backend, jsonPath: join(dir, 'search-index.json'), logger: silentLogger });

const scratch = (tag: string) => mkdtempSync(join(tmpdir(), `zoteus-droplist-${tag}-`));

describe('query-term pruning by document frequency', () => {
  it('drops the listed terms, and falls back to the raw set when fewer than two survive', () => {
    const drop = new Set(['to', 'be', 'or', 'not', 'the', 'is']);
    expect(pruneByDocumentFrequency(['the', 'entropy', 'of', 'ensembles'], drop)).toEqual([
      'entropy',
      'of',
      'ensembles',
    ]);
    // Every term common: sending the empty set would answer a question nobody asked.
    expect(pruneByDocumentFrequency(['to', 'be', 'or', 'not'], drop)).toEqual(['to', 'be', 'or', 'not']);
    // One survivor is the case that made the deletion worse than the stoplist: `not` alone
    // is a confident wrong answer, so one survivor falls back too.
    expect(pruneByDocumentFrequency(['to', 'be', 'or', 'not', 'entropy'], drop)).toEqual([
      'to',
      'be',
      'or',
      'not',
      'entropy',
    ]);
    // Nothing derived yet: an index that carries no droplist filters nothing.
    expect(pruneByDocumentFrequency(['the', 'entropy'], new Set())).toEqual(['the', 'entropy']);
  });

  it('leaves tokenize language-agnostic: no term is dropped by the tokenizer itself', () => {
    // The English literal is gone, so `the` survives tokenisation exactly as `le`, `der`
    // and `và` always did. What happens to it afterwards is the corpus's business.
    expect(tokenize('the theory')).toEqual(['the', 'theory']);
    expect(tokenize('le théorème')).toEqual(['le', 'theoreme']);
  });
});

describe('a query made only of function words', () => {
  for (const backend of ['sqlite', 'memory'] as const) {
    const runner = backend === 'sqlite' ? sqliteIt : it;
    runner(`answers the question that was asked (${backend})`, async () => {
      const index = await open(backend, scratch(backend));
      await index.build(items, { version: 1 });
      const hits = await index.query('to be or not to be', { limit: 3, mode: 'keyword' });
      expect(hits[0]?.itemKey).toBe('HAMLET00');
      await index.close();
    });
  }

  sqliteIt('derives the droplist from the corpus and stores it beside the passage count', async () => {
    const dir = scratch('meta');
    const index = await open('sqlite', dir);
    await index.build(items, { version: 1 });
    await index.save();
    await index.close();

    const db = new DatabaseSync(join(dir, 'search-index.sqlite'));
    const meta = (key: string) =>
      (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const droplist = new Set((meta('droplist') ?? '').split(' ').filter(Boolean));
    const derivedAt = Number(meta('droplistPassages'));
    db.close();

    // Pervasive: dropped. Rare: kept. The list is derived from THIS corpus at THIS
    // granularity — nothing about it is a property of English.
    expect(droplist).toContain('the');
    expect(droplist).toContain('to');
    expect(droplist).not.toContain('entropy');
    expect(droplist).not.toContain('manuscript');
    expect(derivedAt).toBe(items.length);
  });

  sqliteIt('filters nothing until an index carries a droplist of its own', async () => {
    const dir = scratch('adopt');
    const index = await open('sqlite', dir);
    await index.build(items, { version: 1 });
    await index.save();
    await index.close();

    // Two rare terms survive pruning, so the fallback does NOT fire and the pruned search
    // reads only the two passages that hold them.
    const pruned = await open('sqlite', dir);
    const withList = await pruned.query('the entropy is the manuscript', { limit: 10, mode: 'keyword' });
    await pruned.close();
    expect(withList.length).toBeLessThanOrEqual(2);

    // An index built before this change has no droplist row. It must behave exactly as it
    // did: every passage holding `the` or `of` comes back.
    const db = new DatabaseSync(join(dir, 'search-index.sqlite'));
    db.exec("DELETE FROM meta WHERE key IN ('droplist', 'droplistPassages')");
    db.close();

    const legacy = await open('sqlite', dir);
    const withoutList = await legacy.query('the entropy is the manuscript', { limit: 10, mode: 'keyword' });
    await legacy.close();
    expect(withoutList.length).toBeGreaterThan(withList.length);
  });
});

describe('snippets', () => {
  it('centre on content, not on the first function word in the passage', () => {
    const opening = 'The '.repeat(70);
    const text = `${opening}and the theory of relativity is what the passage is about.`;
    const drop = new Set(['the', 'of', 'is', 'and', 'what']);
    // Unpruned, the earliest matching token is `the` at character 0 and the window opens
    // on the filler — the passage's content never appears. This is what deleting the
    // stoplist broke, and the droplist is what repairs it.
    expect(makeSnippet(text, 'the theory of relativity', 240, drop)).toContain('relativity');
  });
});
