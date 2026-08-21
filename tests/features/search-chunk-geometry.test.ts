import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SearchIndex,
  DEFAULT_CHUNK_GEOMETRY,
  geometryKey,
  META_CHUNK_SIZE,
  META_CHUNK_OVERLAP,
  FULLTEXT_CHUNK_SIZE,
  FULLTEXT_CHUNK_OVERLAP,
} from '../../src/features/search/index-manager.js';
import { SqliteSearchIndex, defaultSearchDbPath } from '../../src/features/search/sqlite-index.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A fixture long enough that geometry decides the answer.
 *
 * Deterministic, and built from real-shaped prose rather than a repeated character: word
 * boundaries are where the chunker actually cuts, so a fixture with none of them would
 * exercise the arithmetic and none of the boundary logic.
 */
function fixture(words: number): string {
  const vocab = ['circulation', 'thermohaline', 'equilibrium', 'duopoly', 'actualisation', 'entropy', 'estimator'];
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(`${vocab[i % vocab.length]}${i % 13}`);
  return out.join(' ');
}

function item(key: string, body: string) {
  return { key, data: { key, itemType: 'journalArticle', title: `Paper ${key}`, abstractNote: body } };
}

describe('chunk geometry is configuration, and its defaults are what shipped (ticket 0007)', () => {
  it('the shipped defaults are exactly the three constants that were hardcoded', () => {
    // The criterion this closes is "defaults unchanged", so the defaults are asserted
    // against their literal values, not against themselves. A test comparing
    // DEFAULT_CHUNK_GEOMETRY.metaSize to META_CHUNK_SIZE would pass however both moved.
    expect(META_CHUNK_SIZE).toBe(512);
    expect(META_CHUNK_OVERLAP).toBe(64);
    expect(FULLTEXT_CHUNK_SIZE).toBe(1200);
    expect(FULLTEXT_CHUNK_OVERLAP).toBe(150);
    expect(DEFAULT_CHUNK_GEOMETRY).toEqual({
      metaSize: 512,
      metaOverlap: 64,
      fulltextSize: 1200,
      fulltextOverlap: 150,
    });
    expect(geometryKey(DEFAULT_CHUNK_GEOMETRY)).toBe('512/64+1200/150');
  });

  it('an unconfigured environment yields the shipped geometry', () => {
    const config = loadConfig({} as any);
    expect(config.chunkGeometry).toEqual(DEFAULT_CHUNK_GEOMETRY);
  });

  it('the default path produces the SAME passage count as before the knob existed', async () => {
    const body = fixture(4000);
    // Built two ways: with no geometry given at all (the old code path, which took
    // chunkText's own defaults) and with the geometry passed explicitly. The criterion is
    // that making it configurable moved nothing, so the two must agree exactly.
    const implicit = new SearchIndex({ embedder: null, logger: silentLogger });
    await implicit.build([item('AAA', body)]);

    const explicit = new SearchIndex({ embedder: null, logger: silentLogger, geometry: DEFAULT_CHUNK_GEOMETRY });
    await explicit.build([item('AAA', body)]);

    expect(implicit.status().documents).toBe(explicit.status().documents);
    // And the passages themselves, not only how many: a geometry change that preserved the
    // count while shifting every boundary would pass a count-only assertion.
    const q = 'thermohaline1';
    expect((await implicit.query(q, { limit: 10 })).map((h) => h.id)).toEqual(
      (await explicit.query(q, { limit: 10 })).map((h) => h.id),
    );
  });

  it('a different geometry actually changes the passages, so the knob is not decorative', async () => {
    const body = fixture(4000);
    const shipped = new SearchIndex({ embedder: null, logger: silentLogger });
    await shipped.build([item('AAA', body)]);

    const tighter = new SearchIndex({
      embedder: null,
      logger: silentLogger,
      geometry: { ...DEFAULT_CHUNK_GEOMETRY, metaSize: 128, metaOverlap: 16 },
    });
    await tighter.build([item('AAA', body)]);

    // Smaller passages, more of them. Without this the "defaults unchanged" test above
    // would pass just as well against a knob that was silently ignored.
    expect(tighter.status().documents).toBeGreaterThan(shipped.status().documents);
  });

  it('refuses a delta across a geometry change rather than mixing two populations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-geom-'));
    const dbPath = defaultSearchDbPath(dir);

    const first = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath });
    await first.buildIncremental(
      async (start) =>
        start === 0
          ? { items: [item('AAA', fixture(2000))], totalResults: 1, libraryVersion: 410 }
          : { items: [], totalResults: 1, libraryVersion: 410 },
      { backend: 'local' },
    );
    expect(first.watermark.version).toBe(410);
    expect(first.geometryMismatch).toBeUndefined();

    // Reopened by a process configured differently — one environment variable away.
    const reopened = new SqliteSearchIndex({
      embedder: null,
      logger: silentLogger,
      dbPath,
      geometry: { ...DEFAULT_CHUNK_GEOMETRY, fulltextSize: 800, fulltextOverlap: 100 },
    });
    const mismatch = reopened.geometryMismatch;
    expect(mismatch).toBeDefined();
    expect(mismatch!.stored).toBe('512/64+1200/150');
    expect(mismatch!.configured).toBe('512/64+800/100');

    // And the same process reading its own geometry back sees no mismatch, so the guard
    // does not fire on every restart.
    const same = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath });
    expect(same.geometryMismatch).toBeUndefined();
  });
});
