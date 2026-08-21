import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fts5PassageStore } from '../../src/features/search/fts5-store.js';
import { SqliteSearchIndex } from '../../src/features/search/sqlite-index.js';
import {
  CorruptSearchIndex,
  SearchIndexCorruptError,
  isCorruptionError,
} from '../../src/features/search/corruption.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'zoteus-corrupt-'));
}

/**
 * A real database, then shredded — not a file of random bytes.
 *
 * The distinction is the test's whole value. Random bytes fail at the very first header
 * read, which any error path catches; a database whose HEADER IS INTACT and whose pages
 * are not is what power loss mid-WAL and a copy-without-its-sidecar actually produce, and
 * it is the case that reaches further into the open path before failing. Writing garbage
 * over everything would let a guard that only checks byte 0 pass while the realistic case
 * still escaped.
 */
function corruptInPlace(dbPath: string): void {
  const buf = readFileSync(dbPath);
  // Leave SQLite's 100-byte header alone; overwrite the b-tree pages behind it.
  for (let i = 100; i < buf.length; i++) buf[i] = 0x5a;
  writeFileSync(dbPath, buf);
}

/** A store with something in it, closed and left on disk. */
function seededDb(dir: string): string {
  const dbPath = join(dir, 'search-index.sqlite');
  const store = new Fts5PassageStore(dbPath);
  store.beginBatch();
  for (let i = 0; i < 200; i++) {
    store.add({ id: `K${i}#0`, itemKey: `K${i}`, title: `Paper ${i}`, text: `thermohaline circulation number ${i}` });
  }
  store.commitBatch();
  store.setMeta('builtFromVersion', '410');
  store.setMeta('indexBackend', 'local');
  store.close?.();
  return dbPath;
}

describe('a corrupt search index refuses and reports (ticket 0010)', () => {
  it('recognises SQLite\'s corruption vocabulary and nothing else', () => {
    expect(isCorruptionError(new Error('database disk image is malformed'))).toBe(true);
    expect(isCorruptionError(new Error('file is not a database'))).toBe(true);
    // The narrowness is the point: these are failures, none of them is corruption, and
    // telling a user to delete their index over a locked file would be its own defect.
    expect(isCorruptionError(new Error('database is locked'))).toBe(false);
    expect(isCorruptionError(new Error('attempt to write a readonly database'))).toBe(false);
    expect(isCorruptionError(new Error('no such table: passages'))).toBe(false);
    expect(isCorruptionError(new Error('SQLITE_BUSY'))).toBe(false);
  });

  it('turns an unopenable database into an error naming the file and the command', () => {
    const dir = scratch();
    const dbPath = seededDb(dir);
    corruptInPlace(dbPath);

    // THE GATE MUST BITE. Against the code before this ticket, this throws SQLite's own
    // sentence out of a constructor — no path, no remedy, and nothing typed to catch.
    let caught: unknown;
    try {
      new Fts5PassageStore(dbPath);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SearchIndexCorruptError);
    const err = caught as SearchIndexCorruptError;
    expect(err.dbPath).toBe(dbPath);
    // Cause.
    expect(err.message).toMatch(/malformed|not a database|encrypted/i);
    // Command: the exact file, its two sidecars, and the tool that refills the index.
    expect(err.message).toContain(dbPath);
    expect(err.message).toContain(dbPath + '-wal');
    expect(err.message).toContain(dbPath + '-shm');
    expect(err.message).toContain('zotero_index');
    // And the position, stated where the user reads it rather than only in a ticket.
    expect(err.message).toMatch(/will not be rebuilt automatically/i);
  });

  it('keeps the server alive with an index that refuses, never one that answers emptily', async () => {
    const dir = scratch();
    const dbPath = seededDb(dir);
    corruptInPlace(dbPath);

    let failure: SearchIndexCorruptError | undefined;
    try {
      new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath });
    } catch (e) {
      failure = e as SearchIndexCorruptError;
    }
    expect(failure).toBeInstanceOf(SearchIndexCorruptError);

    const index = new CorruptSearchIndex({ embedder: null, logger: silentLogger }, failure!);

    // Refusing, not answering. An empty answer is the failure 0010 calls worse than the
    // corruption: to an agent it is indistinguishable from an empty library.
    await expect(index.query('thermohaline')).rejects.toThrow(SearchIndexCorruptError);

    // No rebuild is attempted, by the tool or by anything else. This is the decision — a
    // rebuild re-crawls the library for minutes, and the caller is mid-task.
    await expect(index.buildIncremental(async () => ({ items: [], totalResults: 0 }))).rejects.toThrow(
      SearchIndexCorruptError,
    );

    // `isEmpty` is false so semantic-search's auto-build does not helpfully start one.
    expect(index.isEmpty).toBe(false);
    // No deltas either: a delta against a database we never opened is meaningless.
    expect(index.supportsDelta).toBe(false);

    const status = index.buildStatus();
    expect(status.state).toBe('error');
    expect(status.lastError).toContain(dbPath);
  });

  it('a corrupt page met on a QUERY reports the same way as one met at open', () => {
    const dir = scratch();
    const dbPath = seededDb(dir);
    const store = new Fts5PassageStore(dbPath);

    // Driven through the statement rather than by shredding the file, and deliberately so.
    // Corrupting on disk under an open handle is not a test: SQLite may serve the whole
    // result from its own page cache, nothing is read, nothing fails, and the assertion
    // passes without having looked at anything. A check whose all-clear is
    // indistinguishable from "I could not look" is not a check. What IS under test here is
    // the wrapping on the read path — that a corruption error surfacing on a query is
    // typed and carries the path, exactly as one surfacing at open is.
    const sqliteSays = new Error('database disk image is malformed');
    (store as unknown as { stmtSearch: { all: () => unknown } }).stmtSearch = {
      all: () => {
        throw sqliteSays;
      },
    };

    let caught: unknown;
    try {
      store.search('thermohaline', 10);
    } catch (e) {
      caught = e;
    } finally {
      store.close?.();
    }
    expect(caught).toBeInstanceOf(SearchIndexCorruptError);
    expect((caught as SearchIndexCorruptError).dbPath).toBe(dbPath);
    expect((caught as SearchIndexCorruptError).detail).toBe('database disk image is malformed');
  });

  it('the documented recovery leaves no watermark behind', () => {
    const dir = scratch();
    const dbPath = seededDb(dir);

    // The watermark lives in `index_meta`, inside the database. That is the trap a rebuild
    // IN PLACE walks into: drop the passage tables, leave index_meta standing, and the
    // freshness check compares equal against an empty index and serves nothing, forever.
    const before = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath });
    expect(before.watermark.version).toBe(410);
    expect(before.watermark.backend).toBe('local');

    // The command the message gives. Deleting the file takes the watermark with it — which
    // is why refuse-and-report sidesteps the trap rather than having to guard against it.
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) if (existsSync(f)) rmSync(f);

    const rebuilt = new SqliteSearchIndex({ embedder: null, logger: silentLogger, dbPath });
    expect(rebuilt.watermark.version).toBe(0);
    expect(rebuilt.watermark.backend).toBeUndefined();
    expect(rebuilt.fulltextWatermark).toBe(0);
    // An index at version 0 with no label is one the freshness check refuses to compute a
    // delta against: it rebuilds. That is the assertion the original exit criterion asked
    // for, reached by deletion rather than by an in-place recovery that no longer exists.
    expect(rebuilt.isEmpty).toBe(true);
  });
});
