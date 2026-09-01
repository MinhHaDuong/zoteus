import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';

/**
 * The schema stamp used to be written and never read: `createSchema` ran `INSERT OR
 * REPLACE INTO meta('schemaVersion', ...)` before anything looked at what the file already
 * said, so a database written by a newer build was silently re-stamped and misread — the
 * one moment the stamp exists for is the moment it was destroyed. These tests pin the
 * repaired contract: the stamp is read before any DDL or write, and a file this build does
 * not understand is moved aside (`.incompatible-<ts>`, never deleted) with one notice,
 * then a fresh index is created in its place.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;
const ITEM = { key: 'A', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks' } };

function tmpJsonPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json');
}

const openIndex = (jsonPath: string) =>
  createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });

/** Raw node:sqlite access, to stamp and inspect fixture databases without the index code. */
const sqliteModule = nodeSqliteAvailable()
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
// Every call site is inside a sqliteIt case, so Node 20 loads this suite and skips those
// cases without ever touching the unavailable constructor.
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

function stampSchemaVersion(dbPath: string, value: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(value);
  db.close();
}

function readSchemaVersion(dbPath: string): string | undefined {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
    | { value: string }
    | undefined;
  db.close();
  return row?.value;
}

function passageCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT count(*) AS n FROM passages').get() as { n: number };
  db.close();
  return row.n;
}

function journalMode(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
  db.close();
  return row.journal_mode;
}

function setJournalMode(dbPath: string, mode: 'delete' | 'wal'): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = ${mode}`);
  db.close();
}

/** A real index built and closed, so the database on disk is complete and stamped. */
async function builtIndexPath(name: string): Promise<{ jsonPath: string; dbPath: string }> {
  const jsonPath = tmpJsonPath(name);
  const index = await openIndex(jsonPath);
  await index.build([ITEM]);
  await index.save();
  await index.close();
  return { jsonPath, dbPath: sqliteIndexPath(jsonPath) };
}

/** The `.incompatible-<ts>` databases beside dbPath (sidecars excluded). */
function sidelined(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const name = basename(dbPath);
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.incompatible-`) && !/-(wal|shm|journal)$/.test(f))
    .map((f) => join(dir, f));
}

describe('schema version is read before anything is written', () => {
  sqliteIt('sidelines a database stamped with a newer schema version instead of re-stamping it', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('schema-newer');
    stampSchemaVersion(dbPath, '99');
    // The schema must be inspected before even the normal connection setup. In
    // particular, journal_mode=WAL is a write: it changes the database header.
    setJournalMode(dbPath, 'delete');

    const index = await openIndex(jsonPath);
    try {
      // The incompatible file was moved aside, not deleted, and keeps its stamp and its
      // rows: the evidence of the skew survives for whichever build understands it.
      const aside = sidelined(dbPath);
      expect(aside).toHaveLength(1);
      expect(readSchemaVersion(aside[0])).toBe('99');
      expect(passageCount(aside[0])).toBeGreaterThan(0);
      expect(journalMode(aside[0])).toBe('delete');

      // The file at the original path is a fresh, empty index stamped with THIS build's
      // version — not the old database re-stamped.
      expect(readSchemaVersion(dbPath)).toBe('2');
      expect(passageCount(dbPath)).toBe(0);

      // One notice, through the channel status already reports storage decisions on.
      const notice = index.buildStatus().storageNotice ?? '';
      expect(notice).toContain('99');
      expect(notice).toContain('.incompatible-');
    } finally {
      await index.close();
    }
  });

  sqliteIt('the sidelined database still works as an index for the build that understands it', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('schema-usable');
    stampSchemaVersion(dbPath, '99');
    const index = await openIndex(jsonPath);
    await index.close();

    // Version 99 does not exist, but version 1 pretending to be it is the closest
    // available stand-in: the moved file must be a complete database, not a husk.
    const aside = sidelined(dbPath);
    stampSchemaVersion(aside[0], '1');
    const db = new DatabaseSync(aside[0]);
    const row = db.prepare("SELECT count(*) AS n FROM passages WHERE title = 'Deep learning'").get() as {
      n: number;
    };
    db.close();
    expect(row.n).toBeGreaterThan(0);
  });

  sqliteIt('a stale write-ahead log at the original name cannot poison the fresh index', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('schema-sidecars');
    stampSchemaVersion(dbPath, '99');
    // The poison case sidecar handling exists for: a leftover log at the name the fresh
    // database will be created under. Whether SQLite consumes it (it belongs to the
    // incompatible database, whose handle opens first) or the sideline moves it, it must
    // not sit at the original name once the fresh database lives there.
    writeFileSync(`${dbPath}-wal`, 'stale write-ahead log');

    const index = await openIndex(jsonPath);
    await index.close();

    const staleWalAtOriginalName =
      existsSync(`${dbPath}-wal`) && readFileSync(`${dbPath}-wal`, 'utf8').includes('stale write-ahead log');
    expect(staleWalAtOriginalName).toBe(false);

    // Neither database was hurt in the process: the fresh one is intact, and the
    // moved-aside one still opens and still says what it always said.
    const fresh = new DatabaseSync(dbPath);
    expect((fresh.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    fresh.close();
    expect(readSchemaVersion(sidelined(dbPath)[0])).toBe('99');
  });

  sqliteIt('sidelines a database whose stamp is not a version at all', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('schema-garbled');
    stampSchemaVersion(dbPath, 'banana');

    const index = await openIndex(jsonPath);
    try {
      expect(sidelined(dbPath)).toHaveLength(1);
      expect(readSchemaVersion(dbPath)).toBe('2');
    } finally {
      await index.close();
    }
  });

  sqliteIt('sidelines a non-empty database that carries no stamp: an interrupted creation or a foreign file', async () => {
    const jsonPath = tmpJsonPath('schema-unstamped');
    const dbPath = sqliteIndexPath(jsonPath);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE somebody_elses (x TEXT)');
    db.close();

    const index = await openIndex(jsonPath);
    try {
      expect(sidelined(dbPath)).toHaveLength(1);
      expect(readSchemaVersion(dbPath)).toBe('2');
    } finally {
      await index.close();
    }
  });

  sqliteIt('leaves a database at the current version exactly where it is, with its data', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('schema-current');

    const index = await openIndex(jsonPath);
    try {
      expect(sidelined(dbPath)).toHaveLength(0);
      expect(passageCount(dbPath)).toBeGreaterThan(0);
      expect(index.buildStatus().storageNotice).toBeUndefined();
      const hits = await index.query('learning', { mode: 'keyword' });
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      await index.close();
    }
  });

  sqliteIt('an empty file is a first open, not an incompatibility', async () => {
    const jsonPath = tmpJsonPath('schema-empty');
    const dbPath = sqliteIndexPath(jsonPath);
    // `new DatabaseSync(path)` on a previous run that died before any DDL leaves exactly
    // this: a zero-byte file, which SQLite treats as a valid empty database.
    new DatabaseSync(dbPath).close();

    const index = await openIndex(jsonPath);
    try {
      expect(sidelined(dbPath)).toHaveLength(0);
      expect(readSchemaVersion(dbPath)).toBe('2');
    } finally {
      await index.close();
    }
  });
});
