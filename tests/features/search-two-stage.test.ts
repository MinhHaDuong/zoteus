import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import type { SearchIndex } from '../../src/features/search/backend.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * The two-stage vector path (#30): binary codes scanned by Hamming distance for a candidate
 * pool, then the exact cosine over those candidates' real vectors.
 *
 * What these cases pin is the contract that makes an approximate first stage acceptable at
 * all. Every score the search returns comes from a float32 vector, so the page it returns
 * is ordered by exact cosine and its scores are the ones the full scan would have produced;
 * the codes only decide which rows get scored, and how well they decide is measured here as
 * recall against the full scan rather than asserted. Everything else is about the codes
 * staying level with the vectors: they are rebuilt by a build, by an update, and by the
 * first query on an index written before they existed, and any doubt about their coverage
 * sends the query back to the scan rather than quietly costing recall.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

const sqliteModule = nodeSqliteAvailable()
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

const DIM = 64;

/**
 * Dense, deterministic vectors: an LCG seeded by the text, so the same passage embeds to
 * the same coordinates on every machine and every run. Deliberately dense and unnormalized,
 * unlike the one-hot FakeEmbeddingProvider: sign bits over a mostly-zero vector would say
 * nothing, and recall over such a corpus would measure the fixture rather than the codes.
 */
class DenseEmbedder implements EmbeddingProvider {
  readonly name = 'dense-fake';
  constructor(private readonly dim = DIM) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => vectorFor(t, this.dim));
  }
}

function vectorFor(text: string, dim = DIM): number[] {
  let s = 2166136261;
  for (let i = 0; i < text.length; i++) s = (Math.imul(s ^ text.charCodeAt(i), 16777619) >>> 0) || 1;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s / 4294967296 - 0.5;
  }
  return out;
}

/** One indexable item per passage, so a corpus of N items is a corpus of N vectors. */
function items(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    key: `K${String(i).padStart(4, '0')}`,
    data: { itemType: 'journalArticle', title: `Paper number ${i}`, abstractNote: `subject ${i % 37} topic ${i % 11}` },
  }));
}

interface CorpusOptions {
  count?: number;
  annEnabled?: boolean;
  annOversample?: number;
  annMinCandidates?: number;
  dir?: string;
}

async function corpus(opts: CorpusOptions = {}): Promise<{ index: SearchIndex; jsonPath: string }> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'zoteus-ann-'));
  const jsonPath = join(dir, 'search-index.json');
  const index = await createSearchIndex({
    backend: 'sqlite',
    jsonPath,
    embedder: new DenseEmbedder(),
    logger: silentLogger,
    annEnabled: opts.annEnabled,
    annOversample: opts.annOversample,
    annMinCandidates: opts.annMinCandidates,
  });
  await index.build(items(opts.count ?? 800));
  await index.save();
  return { index, jsonPath };
}

/** The protected ranker, as the fusion calls it: ids and scores, best first. */
function rank(index: SearchIndex, query: number[], topK: number): Array<{ id: string; score: number }> {
  return (index as unknown as { vectorSearch(q: number[], k: number): Array<{ id: string; score: number }> }).vectorSearch(
    query,
    topK,
  );
}

function codeRows(dbPath: string): { codes: number; vectors: number; dim: string | undefined } {
  const db = new DatabaseSync(dbPath);
  const codes = (db.prepare('SELECT count(*) AS n FROM vector_codes').get() as { n: number }).n;
  const vectors = (db.prepare('SELECT count(*) AS n FROM passages WHERE vector IS NOT NULL').get() as { n: number }).n;
  const dim = (db.prepare("SELECT value FROM meta WHERE key = 'codeDim'").get() as { value?: string } | undefined)?.value;
  db.close();
  return { codes, vectors, dim };
}

/** Strip an index back to what a build before this feature wrote: no codes, no mean. */
function removeCodes(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec('DROP TABLE vector_codes');
  db.exec("DELETE FROM meta WHERE key IN ('codeMean', 'codeDim')");
  db.close();
}

function hasCodeTable(dbPath: string): boolean {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'vector_codes'").get();
  db.close();
  return row !== undefined;
}

describe('the coded path and the exact scan agree on what they return', () => {
  sqliteIt('scores every hit from its real vector, in exact-cosine order', async () => {
    const { index } = await corpus();
    const exact = await corpus({ annEnabled: false });
    try {
      for (const q of ['transformers for protein folding', 'medieval trade routes', 'quantum error correction']) {
        const qv = vectorFor(q);
        const coded = rank(index, qv, 10);
        const reference = new Map(rank(exact.index, qv, 800).map((h) => [h.id, h.score]));
        expect(index.buildStatus().vectorScan).toBe('codes');
        expect(exact.index.buildStatus().vectorScan).toBe('exact');
        expect(coded.length).toBe(10);
        for (const hit of coded) {
          // Bit-identical, not merely close: the rescore reads the same float32 vector the
          // full scan reads and runs the same cosine over it.
          expect(hit.score).toBe(reference.get(hit.id));
        }
        for (let i = 1; i < coded.length; i++) {
          expect(coded[i - 1]!.score).toBeGreaterThanOrEqual(coded[i]!.score);
        }
      }
    } finally {
      await index.close();
      await exact.index.close();
    }
  });

  sqliteIt('reproduces the exact ranking when the pool reaches the whole corpus', async () => {
    // 799 candidates out of 800 vectors: the code stage still runs (it is off entirely once
    // the pool covers the index), and rescoring all but the single furthest row leaves the
    // top of the exact ranking untouched.
    const { index } = await corpus({ annMinCandidates: 799 });
    const exact = await corpus({ annEnabled: false });
    try {
      const qv = vectorFor('a query with no relation to any title');
      const coded = rank(index, qv, 20);
      expect(index.buildStatus().vectorScan).toBe('codes');
      expect(coded).toEqual(rank(exact.index, qv, 20));
    } finally {
      await index.close();
      await exact.index.close();
    }
  });

  sqliteIt('keeps recall high against the exact ranking at the default oversampling', async () => {
    const { index } = await corpus();
    const exact = await corpus({ annEnabled: false });
    try {
      let found = 0;
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const qv = vectorFor(`probe query ${i}`);
        const wanted = new Set(rank(exact.index, qv, 10).map((h) => h.id));
        for (const hit of rank(index, qv, 10)) if (wanted.has(hit.id)) found++;
        total += wanted.size;
      }
      // Measured on real embeddings, a 16x pool recalled 0.986 of the exact top 30 and more
      // at wider vectors (#30). This corpus is 64-dimensional, the least favourable case
      // for sign bits, so the bar is set where a genuine regression would cross it rather
      // than at the number the fixture happens to produce.
      expect(found / total).toBeGreaterThanOrEqual(0.9);
    } finally {
      await index.close();
      await exact.index.close();
    }
  });
});

describe('choosing between the two paths', () => {
  sqliteIt('falls back to the exact scan, and says why, when ZOTEUS_INDEX_ANN is off', async () => {
    const { index, jsonPath } = await corpus({ annEnabled: false });
    try {
      rank(index, vectorFor('anything'), 10);
      const status = index.buildStatus();
      expect(status.vectorScan).toBe('exact');
      expect(status.vectorScanNotice).toContain('ZOTEUS_INDEX_ANN=false');
      // And nothing was written: an operator who turned the path off does not pay for it.
      expect(codeRows(sqliteIndexPath(jsonPath)).codes).toBe(0);
    } finally {
      await index.close();
    }
  });

  sqliteIt('scans exactly on an index too small for the codes to narrow anything', async () => {
    const { index, jsonPath } = await corpus({ count: 40 });
    try {
      rank(index, vectorFor('anything'), 10);
      const status = index.buildStatus();
      expect(status.vectorScan).toBe('exact');
      expect(status.vectorScanNotice).toContain('40 vectors');
      // A small library is left exactly as it was: no codes are built for a pool that
      // would cover the whole index anyway.
      expect(codeRows(sqliteIndexPath(jsonPath)).codes).toBe(0);
    } finally {
      await index.close();
    }
  });

  sqliteIt('reports the coded path on the status once it serves a query', async () => {
    const { index } = await corpus();
    try {
      expect(index.buildStatus().vectorScan).toBeUndefined();
      rank(index, vectorFor('anything'), 10);
      const status = index.buildStatus();
      expect(status.vectorScan).toBe('codes');
      expect(status.vectorScanNotice).toBeUndefined();
    } finally {
      await index.close();
    }
  });
});

describe('the codes stay level with the vectors', () => {
  sqliteIt('writes one code per vector at build time', async () => {
    const { index, jsonPath } = await corpus();
    try {
      const rows = codeRows(sqliteIndexPath(jsonPath));
      expect(rows.vectors).toBe(800);
      expect(rows.codes).toBe(rows.vectors);
      expect(rows.dim).toBe(String(DIM));
    } finally {
      await index.close();
    }
  });

  sqliteIt('an index written before the codes existed still opens, searches and gains them', async () => {
    const { index, jsonPath } = await corpus();
    await index.close();
    const dbPath = sqliteIndexPath(jsonPath);
    removeCodes(dbPath);
    // The fixture is a database this build has never touched: the table it keeps the codes
    // in does not exist at all, exactly as in every index written before 1.9.0.
    expect(hasCodeTable(dbPath)).toBe(false);

    const reopened = await createSearchIndex({
      backend: 'sqlite',
      jsonPath,
      embedder: new DenseEmbedder(),
      logger: silentLogger,
    });
    try {
      // The schema stamp did not move, so nothing was sidelined and nothing was rebuilt:
      // the codes are derived state, and an older file is missing a cache, not data.
      const dir = dirname(dbPath);
      expect(readdirSync(dir).filter((f) => f.startsWith(`${basename(dbPath)}.incompatible-`))).toHaveLength(0);
      expect(reopened.buildStatus().storageNotice).toBeUndefined();

      const hits = rank(reopened, vectorFor('a first query on an upgraded index'), 10);
      expect(hits).toHaveLength(10);
      const status = reopened.buildStatus();
      expect(status.vectorScan).toBe('codes');
      // The one-time backfill says so rather than being silently charged to a query.
      expect(status.vectorScanNotice).toContain('800 vectors');
      expect(codeRows(dbPath).codes).toBe(800);
    } finally {
      await reopened.close();
    }
  });

  sqliteIt('codes the passages an update adds, and drops the ones it deletes', async () => {
    const { index, jsonPath } = await corpus({ count: 600 });
    const dbPath = sqliteIndexPath(jsonPath);
    try {
      rank(index, vectorFor('warm the cache'), 10);
      const added = [
        { key: 'NEW1', data: { itemType: 'book', title: 'A newly added work', abstractNote: 'fresh subject matter' } },
      ];
      await index.updateIncremental({
        backend: 'local',
        fetchChanged: async (start: number) => (start === 0 ? { items: added, totalResults: 1, lastModifiedVersion: 9 } : { items: [], totalResults: 1 }),
        liveKeys: async () => new Set([...items(600).map((i) => i.key as string), 'NEW1']),
      });
      const afterAdd = codeRows(dbPath);
      expect(afterAdd.vectors).toBe(601);
      expect(afterAdd.codes).toBe(601);

      // The added passage is reachable through the coded path, which is the point of
      // coding it: a delta whose codes were never written would be invisible to stage one.
      const hits = rank(index, vectorFor('A newly added work. fresh subject matter'), 5);
      expect(index.buildStatus().vectorScan).toBe('codes');
      expect(hits.some((h) => h.id.startsWith('NEW1'))).toBe(true);

      // A deletion takes the codes with it. It has to: codes are keyed by rowid, and
      // SQLite hands a deleted rowid to the next insert.
      await index.updateIncremental({
        backend: 'local',
        fetchChanged: async () => ({ items: [], totalResults: 0, lastModifiedVersion: 10 }),
        liveKeys: async () => new Set(items(600).map((i) => i.key as string)),
      });
      const afterDelete = codeRows(dbPath);
      expect(afterDelete.vectors).toBe(600);
      expect(afterDelete.codes).toBe(600);
    } finally {
      await index.close();
    }
  });

  sqliteIt('refuses the coded path when the codes do not cover the vectors', async () => {
    const { index, jsonPath } = await corpus();
    await index.close();
    // Half the codes removed by something that is not this build: the count no longer
    // matches, and a code that survives a passage it did not describe is exactly the
    // failure this check exists for.
    const db = new DatabaseSync(sqliteIndexPath(jsonPath));
    db.exec('DELETE FROM vector_codes WHERE pid % 2 = 0');
    db.close();

    const reopened = await createSearchIndex({
      backend: 'sqlite',
      jsonPath,
      embedder: new DenseEmbedder(),
      logger: silentLogger,
    });
    try {
      const qv = vectorFor('a query over a half-coded index');
      const hits = rank(reopened, qv, 10);
      const status = reopened.buildStatus();
      // The gap is filled rather than tolerated: the mean is still stored, so only the
      // uncoded rows are read, and the query is served by the codes it just completed.
      expect(status.vectorScan).toBe('codes');
      expect(codeRows(sqliteIndexPath(jsonPath)).codes).toBe(800);
      expect(hits).toHaveLength(10);
    } finally {
      await reopened.close();
    }
  });

  sqliteIt('scans exactly when more codes exist than vectors to describe', async () => {
    const { index, jsonPath } = await corpus();
    await index.close();
    // A code left behind by a writer that deleted passages without deleting them. It can
    // never be filled in, because nothing names which vector it belongs to, and SQLite
    // will eventually hand its rowid to a new passage.
    const db = new DatabaseSync(sqliteIndexPath(jsonPath));
    db.prepare('INSERT INTO vector_codes(pid, code) VALUES (?, ?)').run(9_000_001, new Uint8Array(8));
    db.close();

    const reopened = await createSearchIndex({
      backend: 'sqlite',
      jsonPath,
      embedder: new DenseEmbedder(),
      logger: silentLogger,
    });
    try {
      const hits = rank(reopened, vectorFor('a query over an index with a stray code'), 10);
      const status = reopened.buildStatus();
      expect(status.vectorScan).toBe('exact');
      expect(status.vectorScanNotice).toContain('more binary codes');
      // Refusing the codes is not refusing the search: the exact scan still answers, which
      // is why a doubtful cache costs time rather than results.
      expect(hits).toHaveLength(10);
    } finally {
      await reopened.close();
    }
  });

  sqliteIt('serves a whole semantic query, fusion and snippets included, through the codes', async () => {
    const { index } = await corpus();
    const exact = await corpus({ annEnabled: false });
    try {
      const q = 'a paper on a subject somewhere in this library';
      const hits = await index.query(q, { limit: 5, mode: 'semantic' });
      expect(hits.length).toBe(5);
      expect(index.buildStatus().vectorScan).toBe('codes');
      // The tool boundary, not just the ranker: the same query through the full scan
      // returns the same items in the same order, with the same fused scores.
      expect(hits).toEqual(await exact.index.query(q, { limit: 5, mode: 'semantic' }));
    } finally {
      await index.close();
      await exact.index.close();
    }
  });

  sqliteIt('rebuilds the codes when the vectors are replaced', async () => {
    const { index, jsonPath } = await corpus({ count: 600 });
    const dbPath = sqliteIndexPath(jsonPath);
    try {
      expect(codeRows(dbPath).codes).toBe(600);
      // A rebuild empties the store, codes included, and writes both again.
      await index.build(items(700));
      await index.save();
      const rows = codeRows(dbPath);
      expect(rows.vectors).toBe(700);
      expect(rows.codes).toBe(700);
      const hits = rank(index, vectorFor('after the rebuild'), 10);
      expect(index.buildStatus().vectorScan).toBe('codes');
      expect(hits).toHaveLength(10);
    } finally {
      await index.close();
    }
  });
});

describe('the code itself', () => {
  sqliteIt('sets a bit exactly where a coordinate is above the corpus mean', async () => {
    const { packCode, unpackCode } = await import('../../src/features/search/sqlite-index.js');
    const mean = Float32Array.from([0, 0, 0.5, -0.5, 0, 0, 0, 0, 1]);
    const v = Float32Array.from([1, -1, 0.4, -0.4, 0, Number.NaN, 2, -2, 1]);
    const code = packCode(v, mean, 1);
    const bits = [...code.slice(0, 2)].flatMap((byte) => Array.from({ length: 8 }, (_, b) => (byte >> b) & 1));
    // Above the mean: 1 > 0, -0.4 > -0.5, 2 > 0. Not above it: -1, 0.4 < 0.5, 0, 2 (equal),
    // and NaN, which compares false in both directions and must not invent a set bit.
    expect(bits.slice(0, 9)).toEqual([1, 0, 0, 1, 0, 0, 1, 0, 0]);
    // The code is padded to whole words, so reading it back is one word at a time.
    expect(code.byteLength).toBe(4);
    const words = new Uint32Array(1);
    unpackCode(code, words, 0, 1);
    expect(words[0]).toBe(code[0]! | (code[1]! << 8));
  });
});
