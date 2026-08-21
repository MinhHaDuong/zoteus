import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryPassageStore } from '../../src/features/search/passage-store.js';
import type { ChunkRecord } from '../../src/features/search/passage-store.js';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';
import { SqliteSearchIndex } from '../../src/features/search/sqlite-index.js';
import {
  JsonIndexScanError,
  maybeMigrateJsonIndex,
  migrateJsonIndex,
  migrateJsonIndexToSqlite,
} from '../../src/features/search/migrate-json.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'zoteus-migrate-'));
}

/** Write `body` verbatim, so a fixture can be malformed in an exactly chosen way. */
function writeRaw(dir: string, body: string): string {
  const path = join(dir, 'search-index.json');
  writeFileSync(path, body);
  return path;
}

/** A well-formed snapshot in the shape SearchIndex.toJSON() emits. */
function writeIndex(
  dir: string,
  data: { chunks?: unknown[]; vectors?: unknown[]; builtFromVersion?: number },
): string {
  return writeRaw(dir, JSON.stringify({ chunks: [], vectors: [], builtFromVersion: 0, ...data }));
}

async function migrateToMemory(jsonPath: string, opts: { maxObjectBytes?: number; batchSize?: number } = {}) {
  const store = new MemoryPassageStore();
  const report = await migrateJsonIndex({ jsonPath, store, ...opts });
  return { store, report, records: [...store.values()] as ChunkRecord[] };
}

/**
 * The fixture the scanner exists for.
 *
 * One passage's text carries an unbalanced `}`, an unbalanced `{`, and an escaped quote.
 * It kills two different wrong scanners, which is why it is one fixture and not two:
 *
 *  - a **depth-only** scanner counts the `}` and believes the record ended there;
 *  - a **string-aware but escape-blind** scanner reads `\"` as the closing quote of the
 *    text, falls out of the string, and then believes the same `}` is structure.
 *
 * Both are invisible on any fixture whose passages happen to contain no braces — and real
 * academic full text is full of them: LaTeX, code listings, JSON quoted inside a paper.
 */
const TRICKY = 'He wrote "unbalanced } brace { and \\section{Intro}" in the margin';

describe('the JSON scanner reads braces and quotes inside a passage as data', () => {
  it('cuts records on structure only, and round-trips the text exactly', async () => {
    const dir = tmpDir();
    const path = writeIndex(dir, {
      chunks: [
        { id: 'A#0', itemKey: 'A', title: 'Before', text: 'plain' },
        { id: 'A#f0', itemKey: 'A', title: 'Tricky', text: TRICKY, source: 'fulltext' },
        { id: 'B#0', itemKey: 'B', title: 'After', text: 'also plain' },
      ],
    });

    const { report, records, store } = await migrateToMemory(path);

    expect(report.chunks).toBe(3);
    expect(store.size).toBe(3);
    expect(records[1]!.text).toBe(TRICKY);
    // Not merely "contains braces": the exact string, so a scanner that cuts one character
    // early or late is caught even when JSON.parse happens to survive the cut.
    expect(records.map((r) => r.id)).toEqual(['A#0', 'A#f0', 'B#0']);
  });

  it('keeps a nested object inside a chunk from ending the chunk', async () => {
    // Nothing writes this today, but depth is the other half of the invariant and a
    // fixture that never nests cannot tell a working stack from an absent one.
    const dir = tmpDir();
    const path = writeRaw(
      dir,
      '{"chunks":[{"id":"A#0","itemKey":"A","title":"T","text":"x","extra":{"deep":{"deeper":[1,2]}}},' +
        '{"id":"B#0","itemKey":"B","title":"T","text":"y"}],"vectors":[],"builtFromVersion":0}',
    );
    const { records } = await migrateToMemory(path);
    expect(records.map((r) => r.id)).toEqual(['A#0', 'B#0']);
    // `extra` is dropped rather than forwarded: records are rebuilt field by field.
    expect(records[0]).toEqual({ id: 'A#0', itemKey: 'A', title: 'T', text: 'x' });
  });
});

describe('what the migration carries and what it refuses to pretend it carried', () => {
  it('preserves the presence and absence of source: fulltext', async () => {
    const dir = tmpDir();
    const path = writeIndex(dir, {
      chunks: [
        { id: 'A#0', itemKey: 'A', title: 'Meta', text: 'metadata passage' },
        { id: 'A#f0', itemKey: 'A', title: 'Body', text: 'full text passage', source: 'fulltext' },
      ],
    });
    const { records } = await migrateToMemory(path);
    // Absent, not null: ChunkRecord's two cases are "absent" and "'fulltext'".
    expect('source' in records[0]!).toBe(false);
    expect(records[1]!.source).toBe('fulltext');
  });

  it('counts the vectors it skips, even when they come before the chunks', async () => {
    const dir = tmpDir();
    // Key order in the file is whatever JSON.stringify emitted; the scanner must not
    // assume chunks come first.
    const path = writeRaw(
      dir,
      '{"builtFromVersion":11,"vectors":[{"id":"A#0","v":[0.1,0.2]},{"id":"B#0","v":[0.3,0.4]},' +
        '{"id":"C#0","v":[0.5,0.6]}],"chunks":[{"id":"A#0","itemKey":"A","title":"T","text":"one"}]}',
    );
    const { report, records } = await migrateToMemory(path);
    expect(report.chunks).toBe(1);
    expect(report.vectorsSkipped).toBe(3);
    expect(report.builtFromVersion).toBe(11);
    expect(records).toHaveLength(1);
  });

  it('reports zero skipped vectors for an empty vectors array', async () => {
    const dir = tmpDir();
    const path = writeIndex(dir, { chunks: [{ id: 'A#0', itemKey: 'A', title: 'T', text: 'one' }] });
    const { report } = await migrateToMemory(path);
    expect(report.vectorsSkipped).toBe(0);
  });

  it('carries builtFromVersion across', async () => {
    const dir = tmpDir();
    const path = writeIndex(dir, {
      chunks: [{ id: 'A#0', itemKey: 'A', title: 'T', text: 'one' }],
      builtFromVersion: 7540,
    });
    const { report } = await migrateToMemory(path);
    expect(report.builtFromVersion).toBe(7540);
  });

  it('accepts a well-formed but empty index', async () => {
    const dir = tmpDir();
    const path = writeIndex(dir, { chunks: [] });
    const { report, records } = await migrateToMemory(path);
    expect(report.chunks).toBe(0);
    expect(records).toEqual([]);
  });

  it('leaves the source JSON byte-identical', async () => {
    const dir = tmpDir();
    const path = writeIndex(dir, {
      chunks: [{ id: 'A#0', itemKey: 'A', title: 'T', text: TRICKY, source: 'fulltext' }],
      builtFromVersion: 3,
    });
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    await migrateJsonIndexToSqlite({ jsonPath: path, dbPath: join(dir, 'search-index.sqlite') });
    const after = createHash('sha256').update(readFileSync(path)).digest('hex');
    // Reversibility is the whole safety net: ZOTEUS_SEARCH_BACKEND=json must still work.
    expect(after).toBe(before);
  });
});

describe('multi-byte characters split across stream chunks', () => {
  it('reassembles a character straddling the 64 KiB stream boundary', async () => {
    const dir = tmpDir();
    // Placed, not hoped for. The first 'é' is put at byte 65535 so its second byte lands
    // at 65536 — exactly the default highWaterMark, i.e. the first boundary the stream
    // hands over. A per-chunk `buffer.toString('utf8')` yields two replacement characters
    // here and the assertion below fails.
    const head = '{"chunks":[{"id":"A#0","itemKey":"A","title":"T","text":"';
    const filler = 'x'.repeat(65535 - Buffer.byteLength(head));
    const accented = 'éèü♩𝄞'.repeat(2000);
    const text = filler + accented;
    const path = writeRaw(
      dir,
      `${head}${text}"}],"vectors":[],"builtFromVersion":0}`,
    );
    expect(statSync(path).size).toBeGreaterThan(64 * 1024);

    const { records } = await migrateToMemory(path);
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toBe(text);
    expect(records[0]!.text).not.toContain('�');
  });
});

describe('the scanner streams rather than reading the file into a string', () => {
  it('migrates a file hundreds of times larger than the window it is allowed to buffer', async () => {
    const dir = tmpDir();
    const chunks = Array.from({ length: 4000 }, (_, i) => ({
      id: `K${i}#0`,
      itemKey: `K${i}`,
      title: `Item ${i}`,
      // ~600 bytes each, so the file lands around 2.5 MB: dozens of stream chunks.
      text: `passage ${i} ${'lorem ipsum dolor sit amet '.repeat(22)}`,
    }));
    const path = writeIndex(dir, { chunks, builtFromVersion: 4000 });
    expect(statSync(path).size).toBeGreaterThan(2_000_000);

    // The bound, asserted rather than asserted-about: 8 KiB is smaller than one stream
    // chunk and ~300x smaller than the file. Anything that accumulated the document — or
    // even a single stream chunk's worth of records — trips the guard and throws.
    const { report, store } = await migrateToMemory(path, { maxObjectBytes: 8 * 1024, batchSize: 500 });
    expect(report.chunks).toBe(4000);
    expect(store.size).toBe(4000);
    expect(report.builtFromVersion).toBe(4000);
  });

  it('aborts on a runaway element instead of buffering the rest of the file', async () => {
    const dir = tmpDir();
    // A chunk whose text string is never closed: a scanner with no cap would swallow every
    // remaining byte into one buffer, which is the out-of-memory failure being escaped.
    const path = writeRaw(
      dir,
      `{"chunks":[{"id":"A#0","itemKey":"A","title":"T","text":"${'y'.repeat(200_000)}}],"vectors":[]}`,
    );
    await expect(migrateToMemory(path, { maxObjectBytes: 4096 })).rejects.toThrow(/exceeded 4096 bytes/);
  });
});

describe('a malformed index fails loudly and leaves nothing behind', () => {
  it('names the cause and the byte offset, and writes no database', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'search-index.sqlite');
    const whole = JSON.stringify({
      chunks: Array.from({ length: 50 }, (_, i) => ({
        id: `K${i}#0`,
        itemKey: `K${i}`,
        title: 'T',
        text: `passage number ${i}`,
      })),
      vectors: [],
      builtFromVersion: 5,
    });
    // Truncated the way an interrupted saveIndex truncates: mid-file, no closing bracket.
    // Byte 900 lands inside a passage's text, which is where a real truncation lands.
    const path = writeRaw(dir, whole.slice(0, 900));

    const err = await migrateJsonIndexToSqlite({ jsonPath: path, dbPath }).catch((e) => e);
    expect(err).toBeInstanceOf(JsonIndexScanError);
    expect((err as JsonIndexScanError).byteOffset).toBe(900);
    expect((err as Error).message).toMatch(/unterminated string at byte offset 900/);

    // Never a half-populated database that answers queries with most of the library gone.
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('migrating'))).toEqual([]);
  });

  it('names the other truncation, the one that lands between records', async () => {
    const dir = tmpDir();
    const path = writeRaw(dir, '{"chunks":[{"id":"A#0","itemKey":"A","title":"T","text":"one"},');
    const err = await migrateToMemory(path).catch((e) => e);
    expect(err).toBeInstanceOf(JsonIndexScanError);
    expect((err as Error).message).toMatch(/unexpected end of file inside a JSON value/);
    // The offset is the end of what was readable, which for this cut is the whole file.
    expect((err as JsonIndexScanError).byteOffset).toBe(statSync(path).size);
  });

  it('rejects a file that is valid JSON but not a search index', async () => {
    const dir = tmpDir();
    const path = writeRaw(dir, '{"builtFromVersion":0,"vectors":[]}');
    await expect(migrateToMemory(path)).rejects.toThrow(/no "chunks" array/);
  });

  it('refuses to fall back to an empty index when the JSON is unreadable', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'search-index.sqlite');
    const jsonPath = writeRaw(dir, '{"chunks":[{"id":"A#0",');
    // The failure mode this guards: a caught error would present as an empty library and
    // send the user into the multi-hour rebuild they were escaping.
    await expect(maybeMigrateJsonIndex({ jsonPath, dbPath })).rejects.toThrow(
      /Could not migrate .*ZOTEUS_SEARCH_BACKEND=json/s,
    );
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(jsonPath)).toBe(true);
  });
});

describe('the migrated database is complete once it is renamed into place', () => {
  it('survives a fresh connection in a separate process, with no WAL left behind', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'search-index.sqlite');
    const path = writeIndex(dir, {
      chunks: Array.from({ length: 300 }, (_, i) => ({
        id: `K${i}#0`,
        itemKey: `K${i}`,
        title: `Item ${i}`,
        text: `photosynthesis passage number ${i}`,
      })),
      builtFromVersion: 300,
    });

    const report = await migrateJsonIndexToSqlite({ jsonPath: path, dbPath, batchSize: 50 });
    expect(report.chunks).toBe(300);

    // The WAL check is the point: rows committed under WAL can still live in the sidecar
    // when the writing connection goes away, and renaming the main file alone would land a
    // database whose data stayed behind under the temporary name.
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    // A separate process, so nothing about this one's page cache or open handles can make
    // an incomplete file look complete.
    const count = execFileSync(
      process.execPath,
      [
        '-e',
        'const {DatabaseSync}=require("node:sqlite");' +
          'const db=new DatabaseSync(process.argv[1]);' +
          'process.stdout.write(String(db.prepare("SELECT count(*) AS n FROM passage_meta").get().n));',
        dbPath,
      ],
      { encoding: 'utf8' },
    );
    expect(count).toBe('300');
  });

  it('hands the migrated index straight to SqliteSearchIndex, builtFromVersion included', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'search-index.sqlite');
    const jsonPath = writeIndex(dir, {
      chunks: [
        { id: 'A#0', itemKey: 'A', title: 'Deep learning', text: 'convolutional neural networks' },
        { id: 'B#f0', itemKey: 'B', title: 'Gardening', text: TRICKY, source: 'fulltext' },
      ],
      builtFromVersion: 42,
    });

    expect(await maybeMigrateJsonIndex({ jsonPath, dbPath })).not.toBeNull();

    const idx = new SqliteSearchIndex({ embedder: null, dbPath });
    expect(idx.status().documents).toBe(2);
    expect(idx.status().builtFromVersion).toBe(42);
    const hits = await idx.query('convolutional', { limit: 2 });
    expect(hits[0]!.itemKey).toBe('A');
    // The tricky passage is searchable and intact through FTS5, not just through the JSON.
    const store = new Fts5PassageStore(dbPath);
    try {
      expect(store.get('B#f0')!.text).toBe(TRICKY);
      expect(store.get('B#f0')!.source).toBe('fulltext');
    } finally {
      store.close();
    }
  });
});

describe('the startup trigger', () => {
  it('does nothing when there is no JSON index', async () => {
    const dir = tmpDir();
    expect(
      await maybeMigrateJsonIndex({ jsonPath: join(dir, 'absent.json'), dbPath: join(dir, 'db.sqlite') }),
    ).toBeNull();
    expect(existsSync(join(dir, 'db.sqlite'))).toBe(false);
  });

  it('migrates into an existing but empty database', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'search-index.sqlite');
    new Fts5PassageStore(dbPath).close(); // schema, no rows — what a first startup leaves
    const jsonPath = writeIndex(dir, { chunks: [{ id: 'A#0', itemKey: 'A', title: 'T', text: 'one' }] });

    const report = await maybeMigrateJsonIndex({ jsonPath, dbPath });
    expect(report?.chunks).toBe(1);
  });

  it('leaves a populated database alone', async () => {
    const dir = tmpDir();
    const dbPath = join(dir, 'search-index.sqlite');
    const store = new Fts5PassageStore(dbPath);
    store.add({ id: 'Z#0', itemKey: 'Z', title: 'Existing', text: 'already indexed' });
    store.close();
    const jsonPath = writeIndex(dir, { chunks: [{ id: 'A#0', itemKey: 'A', title: 'T', text: 'one' }] });

    expect(await maybeMigrateJsonIndex({ jsonPath, dbPath })).toBeNull();
    const reopened = new Fts5PassageStore(dbPath);
    try {
      expect(reopened.size).toBe(1);
      expect(reopened.get('Z#0')).toBeDefined();
    } finally {
      reopened.close();
    }
  });
});
