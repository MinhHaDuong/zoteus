import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Ledger, LEDGER_SCHEMA_VERSION } from '../../src/features/search/conductor/ledger.js';
import { conductorLedgerPath, openConductorLedger } from '../../src/features/search/conductor/store.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * SPEC.md §5.2.2's content half — `entries`, `slabs`, `passages`, the per-field FTS5
 * table — in the same file, the same `createSchema()` and the same stamp as tranches 1-2's
 * bookkeeping half.
 *
 * Three things are being pinned, and only the first is ordinary schema-shape testing:
 *
 * 1. **The columns and CHECKs exist**, so tranche 4 dispatches against something real.
 * 2. **`auto_vacuum=INCREMENTAL` actually took**, in both directions. §5.2.2 states the
 *    trap ("set any later it is a no-op") and the measured behaviour is worse than the
 *    sentence: `journal_mode=WAL` voids it too, with no table in the file yet. A test that
 *    only asserted the good case would pass against an implementation that copied v1's
 *    `openHandle()` pragma order and lost incremental vacuum forever.
 * 3. **v1 is untouched**: `search-index.sqlite` and `search-index-v2.sqlite` open, and are
 *    written, side by side in one data directory.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const sqliteModule = hasSqlite ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')) : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `zoteus-${name}-`));
}

/** A ledger on a real file: the pragma assertions below are meaningless on `:memory:`. */
function openOnDisk(dir: string): Ledger {
  return Ledger.open(join(dir, 'search-index-v2.sqlite'), new ManualClock(1_700_000_000_000));
}

/** A seeded in-memory ledger with one library, which every content row must reference. */
function seeded(): { ledger: Ledger; lib: number } {
  const ledger = Ledger.open(':memory:', new ManualClock(1_700_000_000_000));
  const oid = ledger.registerOrigin('server-aaa');
  const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
  return { ledger, lib };
}

function columns(ledger: Ledger, table: string): Set<string> {
  const rows = ledger.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describeSqlite('v2 content schema: the tables §5.2.2 names', () => {
  it('creates entries, slabs and passages with the columns the spec lists', () => {
    const { ledger } = seeded();

    expect(columns(ledger, 'entries')).toEqual(
      new Set([
        'eid',
        'lib',
        'item_key',
        'attachment_key',
        'ordinal',
        'heading',
        'path',
        'kind',
        'char_start',
        'char_end',
        'page_est',
        'page_est_kind',
      ]),
    );
    expect(columns(ledger, 'slabs')).toEqual(
      new Set(['sid', 'lib', 'source', 'source_key', 'char_start', 'char_end', 'bytes', 'content_hash']),
    );
    expect(columns(ledger, 'passages')).toEqual(
      new Set(['pid', 'eid', 'lib', 'item_key', 'sid', 'off_start', 'off_end', 'fp']),
    );

    ledger.close();
  });

  it('gives the FTS table one column per field, not v1s two joined ones', () => {
    const { ledger } = seeded();
    // The whole reason §5.2.2 replaces v1's joined columns: a tag match must not score
    // like a title match, and a quoted phrase must not match across a field seam.
    expect(columns(ledger, 'fts')).toEqual(
      new Set(['title', 'abstract', 'creators', 'tags', 'pub', 'ctx', 'own', 'body']),
    );
    ledger.close();
  });

  it('keeps one stamp for both halves of the file', () => {
    const { ledger } = seeded();
    const stamps = ledger.db.prepare("SELECT value FROM ledger_meta WHERE key = 'schemaVersion'").all() as Array<{
      value: string;
    }>;
    expect(stamps).toHaveLength(1);
    expect(Number(stamps[0]!.value)).toBe(LEDGER_SCHEMA_VERSION);
    // The content half is not a second schema: bookkeeping tables are still here. Queried
    // rather than read from `table_info`, which omits generated columns entirely.
    expect(() => ledger.db.prepare('SELECT class_rank FROM stage_queue').all()).not.toThrow();
    ledger.close();
  });
});

describeSqlite('v2 content schema: the CHECKs make the traps unrepresentable', () => {
  it('refuses an entry kind outside the five §5.2.2 lists', () => {
    const { ledger, lib } = seeded();
    // Distinct ordinals: two entries at one ordinal in the same stream are refused by the
    // uniqueness index, which would mask the CHECK this case is about.
    const insert = (kind: string, ordinal: number) =>
      ledger.db
        .prepare(
          `INSERT INTO entries(lib, item_key, ordinal, kind, char_start, char_end)
             VALUES (?, 'REC001', ?, ?, 0, 10)`,
        )
        .run(lib, ordinal, kind);
    ['record', 'note', 'annotation', 'body', 'synthetic'].forEach((kind, i) => {
      expect(() => insert(kind, i)).not.toThrow();
    });
    expect(() => insert('chunk', 99)).toThrow();
    ledger.close();
  });

  it('refuses a slab source outside the four §5.2.2 lists', () => {
    const { ledger, lib } = seeded();
    const insert = (source: string) =>
      ledger.db
        .prepare(
          `INSERT INTO slabs(lib, source, source_key, char_start, char_end, bytes, content_hash)
             VALUES (?, ?, 'K', 0, 10, X'00', 'h')`,
        )
        .run(lib, source);
    for (const source of ['attachment', 'record', 'note', 'annotation']) {
      expect(() => insert(source)).not.toThrow();
    }
    expect(() => insert('body')).toThrow();
    ledger.close();
  });

  it('refuses a slab over the 1 MiB ceiling', () => {
    const { ledger, lib } = seeded();
    const put = (bytes: Buffer) =>
      ledger.db
        .prepare(
          `INSERT INTO slabs(lib, source, source_key, char_start, char_end, bytes, content_hash)
             VALUES (?, 'attachment', 'K', 0, 10, ?, 'h')`,
        )
        .run(lib, bytes);
    expect(() => put(Buffer.alloc(1024 * 1024))).not.toThrow();
    expect(() => put(Buffer.alloc(1024 * 1024 + 1))).toThrow();
    ledger.close();
  });

  it('refuses a backwards char range on an entry, a slab and a passage', () => {
    const { ledger, lib } = seeded();
    expect(() =>
      ledger.db
        .prepare(
          `INSERT INTO entries(lib, item_key, ordinal, kind, char_start, char_end)
             VALUES (?, 'REC001', 0, 'body', 90, 10)`,
        )
        .run(lib),
    ).toThrow();
    expect(() =>
      ledger.db
        .prepare(
          `INSERT INTO slabs(lib, source, source_key, char_start, char_end, bytes, content_hash)
             VALUES (?, 'attachment', 'K', 90, 10, X'00', 'h')`,
        )
        .run(lib),
    ).toThrow();
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'body', charStart: 0, charEnd: 100 });
    const sid = ledger.putSlab({ lib, source: 'attachment', sourceKey: 'ATT1', charStart: 0, charEnd: 100, text: 'x'.repeat(100) });
    expect(() =>
      ledger.db
        .prepare('INSERT INTO passages(eid, lib, item_key, sid, off_start, off_end, fp) VALUES (?, ?, ?, ?, 90, 10, ?)')
        .run(eid, lib, 'REC001', sid, 'fp'),
    ).toThrow();
    ledger.close();
  });

  it('keys every content row to a library, so R15s delete cannot become an R12 violation', () => {
    const { ledger, lib } = seeded();
    // C1's partition is only worth anything if it is enforced: an entry under a library
    // that does not exist is a row no `WHERE lib = ?` delete would ever reach.
    expect(() =>
      ledger.db
        .prepare(
          `INSERT INTO entries(lib, item_key, ordinal, kind, char_start, char_end)
             VALUES (9999, 'REC001', 0, 'body', 0, 10)`,
        )
        .run(),
    ).toThrow();
    expect(columns(ledger, 'entries').has('lib')).toBe(true);
    expect(columns(ledger, 'slabs').has('lib')).toBe(true);
    expect(columns(ledger, 'passages').has('lib')).toBe(true);
    expect(lib).toBeGreaterThan(0);
    ledger.close();
  });

  it('refuses two entries at the same ordinal in one source stream, attachment or not', () => {
    const { ledger, lib } = seeded();
    const put = (attachmentKey: string | null, ordinal: number) =>
      ledger.putEntry({
        lib,
        itemKey: 'REC001',
        ...(attachmentKey === null ? {} : { attachmentKey }),
        ordinal,
        kind: 'body',
        charStart: 0,
        charEnd: 10,
      });
    put('ATT1', 0);
    expect(() => put('ATT1', 0)).toThrow();
    // The NULL case is the one a plain UNIQUE would miss: SQLite treats NULLs as distinct,
    // so a record stream would silently accept a second entry at the same ordinal.
    put(null, 0);
    expect(() => put(null, 0)).toThrow();
    // Different streams under the same item stay independent.
    expect(() => put('ATT2', 0)).not.toThrow();
    ledger.close();
  });
});

describeSqlite('v2 content schema: the auto_vacuum ordering trap, both directions', () => {
  const autoVacuum = (db: InstanceType<typeof DatabaseSync>): number =>
    (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;

  it('leaves a real ledger file at auto_vacuum=INCREMENTAL', () => {
    const dir = tmpDir('v2-av-good');
    const ledger = openOnDisk(dir);
    // 2 is INCREMENTAL. Read back from the file rather than trusted from the statement:
    // the pragma reports what the header says, which is the only thing §5.2.7's idle
    // `incremental_vacuum` can act on.
    expect(autoVacuum(ledger.db as InstanceType<typeof DatabaseSync>)).toBe(2);
    expect(ledger.autoVacuumIncremental).toBe(true);
    ledger.close();

    const reopened = new DatabaseSync(join(dir, 'search-index-v2.sqlite'));
    expect(autoVacuum(reopened)).toBe(2);
    reopened.close();
  });

  it('proves the same pragma is inert once a table exists — the no-op §5.2.2 names', () => {
    // The positive control for the case above. Without it, an assertion that auto_vacuum
    // is 2 cannot distinguish "we set it correctly" from "SQLite defaults to it here".
    const dir = tmpDir('v2-av-late');
    const db = new DatabaseSync(join(dir, 'late.sqlite'));
    db.exec('CREATE TABLE t(x)');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    expect(autoVacuum(db)).toBe(0);
    // And it cannot be repaired by setting it again on a later connection: the header is
    // written, and only a full VACUUM would move it.
    db.close();
    const again = new DatabaseSync(join(dir, 'late.sqlite'));
    again.exec('PRAGMA auto_vacuum = INCREMENTAL');
    expect(autoVacuum(again)).toBe(0);
    again.close();
  });

  it('proves journal_mode=WAL voids it too, with no table in the file yet', () => {
    // Measured, not inferred, and worse than §5.2.2's sentence: "before the first table"
    // is not sufficient guidance, because switching to WAL writes the header itself. An
    // implementation that copied v1's `openHandle()` order — busy_timeout, WAL,
    // synchronous — and appended auto_vacuum would lose incremental vacuum in silence.
    const dir = tmpDir('v2-av-wal');
    const db = new DatabaseSync(join(dir, 'wal-first.sqlite'));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('CREATE TABLE t(x)');
    expect(autoVacuum(db)).toBe(0);
    db.close();
  });

  it('reports honestly when it opened a file that cannot be fixed', () => {
    // A ledger written by a build that got the order wrong is not repairable in place. The
    // flag says what the header holds, not what `open()` asked for, so an operator and a
    // future migration can both see the difference.
    const dir = tmpDir('v2-av-legacy');
    const path = join(dir, 'search-index-v2.sqlite');
    const pre = new DatabaseSync(path);
    pre.exec('CREATE TABLE ledger_meta (key TEXT PRIMARY KEY, value TEXT)');
    pre.prepare('INSERT INTO ledger_meta(key, value) VALUES (?, ?)').run('schemaVersion', String(LEDGER_SCHEMA_VERSION));
    pre.close();

    const ledger = Ledger.open(path, new ManualClock(1_700_000_000_000));
    expect(ledger.autoVacuumIncremental).toBe(false);
    ledger.close();
  });
});

describeSqlite('v2 content schema: the connection §5.2.2 specifies', () => {
  it('opens a file ledger in WAL, synchronous NORMAL, with the 5 s wait', () => {
    const dir = tmpDir('v2-pragmas');
    const ledger = openOnDisk(dir);
    const read = (p: string): unknown => Object.values(ledger.db.prepare(`PRAGMA ${p}`).get() as object)[0];
    expect(read('journal_mode')).toBe('wal');
    expect(read('synchronous')).toBe(1); // NORMAL
    expect(read('busy_timeout')).toBe(5000);
    expect(read('foreign_keys')).toBe(1);
    ledger.close();
  });
});

describeSqlite('v2 content schema: the stamp is read before it is written', () => {
  it('refuses a file stamped by a build this one cannot understand', () => {
    const dir = tmpDir('v2-stamp-newer');
    const path = join(dir, 'search-index-v2.sqlite');
    const seed = Ledger.open(path, new ManualClock(1));
    seed.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE ledger_meta SET value = ? WHERE key = 'schemaVersion'").run(String(LEDGER_SCHEMA_VERSION + 1));
    raw.close();

    // Refused, not re-stamped. Re-stamping destroys the one piece of evidence the stamp
    // exists to carry, at exactly the moment it matters (v1's own lesson, sqlite-index.ts).
    expect(() => Ledger.open(path, new ManualClock(1))).toThrow(/newer/i);
    const after = new DatabaseSync(path);
    expect(
      (after.prepare("SELECT value FROM ledger_meta WHERE key = 'schemaVersion'").get() as { value: string }).value,
    ).toBe(String(LEDGER_SCHEMA_VERSION + 1));
    after.close();
  });

  it('opens its own file again without complaint', () => {
    const dir = tmpDir('v2-stamp-same');
    const first = openOnDisk(dir);
    const oid = first.registerOrigin('server-aaa');
    first.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    first.close();
    const second = openOnDisk(dir);
    expect(second.libraries()).toHaveLength(1);
    second.close();
  });
});

describeSqlite('v2 content schema: slabs, passages and the re-derived snippet', () => {
  it('round-trips a slab through gzip and slices a snippet out of it', () => {
    const { ledger, lib } = seeded();
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(4);
    const sid = ledger.putSlab({ lib, source: 'attachment', sourceKey: 'ATT1', charStart: 0, charEnd: text.length, text });

    // Stored compressed, per §5.2.2's "gzip bytes": the column holds bytes, not the text.
    const row = ledger.db.prepare('SELECT bytes FROM slabs WHERE sid = ?').get(sid) as { bytes: Uint8Array };
    expect(Buffer.from(row.bytes).byteLength).toBeLessThan(Buffer.byteLength(text));
    expect(ledger.slabText(sid)).toBe(text);

    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'body', charStart: 0, charEnd: text.length });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 4, offEnd: 9 });
    expect(ledger.snippet(pid)).toBe('quick');
  });

  it('returns null rather than wrong words when the fingerprint does not match', () => {
    // §5.2.2 states the behaviour outright, and it is the difference between a snippet
    // that is merely missing and one that quotes the wrong document back at the reader.
    const { ledger, lib } = seeded();
    const sid = ledger.putSlab({ lib, source: 'attachment', sourceKey: 'ATT1', charStart: 0, charEnd: 26, text: 'abcdefghijklmnopqrstuvwxyz' });
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'body', charStart: 0, charEnd: 26 });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 0, offEnd: 5 });
    expect(ledger.snippet(pid)).toBe('abcde');

    ledger.db.prepare('UPDATE passages SET fp = ? WHERE pid = ?').run('not-the-fingerprint', pid);
    expect(ledger.snippet(pid)).toBeNull();
    ledger.close();
  });

  it('re-derives from our own store, so a slab replaced under it is caught', () => {
    const { ledger, lib } = seeded();
    const sid = ledger.putSlab({ lib, source: 'attachment', sourceKey: 'ATT1', charStart: 0, charEnd: 26, text: 'abcdefghijklmnopqrstuvwxyz' });
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'body', charStart: 0, charEnd: 26 });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 0, offEnd: 5 });
    ledger.db.prepare('UPDATE slabs SET bytes = ? WHERE sid = ?').run(gzipSync(Buffer.from('ZZZZZZZZZZ')), sid);
    expect(ledger.snippet(pid)).toBeNull();
    ledger.close();
  });
});

describeSqlite('v2 content schema: the FTS table earns its per-field columns', () => {
  it('scopes a match to the column it was indexed in', () => {
    const { ledger, lib } = seeded();
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'record', charStart: 0, charEnd: 4 });
    const sid = ledger.putSlab({ lib, source: 'record', sourceKey: 'REC001', charStart: 0, charEnd: 4, text: 'text' });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 0, offEnd: 4 });
    ledger.indexText(pid, { title: 'Brontë essays', tags: 'fiction', body: 'a study of climate' });

    expect(ledger.searchFts('Bronte')).toEqual([pid]); // remove_diacritics 2
    expect(ledger.searchFts('title:Bronte')).toEqual([pid]);
    // The record ruling's exact complaint: a tag match must not be a title match.
    expect(ledger.searchFts('title:fiction')).toEqual([]);
    expect(ledger.searchFts('tags:fiction')).toEqual([pid]);
    ledger.close();
  });

  it('does not let a phrase match run across a field seam', () => {
    // v1 joined its fields with '. ', and unicode61 treats '.' as a separator, so a quoted
    // phrase could match across the join. Per-field columns make that unrepresentable.
    const { ledger, lib } = seeded();
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'record', charStart: 0, charEnd: 4 });
    const sid = ledger.putSlab({ lib, source: 'record', sourceKey: 'REC001', charStart: 0, charEnd: 4, text: 'text' });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 0, offEnd: 4 });
    ledger.indexText(pid, { title: 'machine learning', abstract: 'applied to rainfall' });

    expect(ledger.searchFts('"machine learning"')).toEqual([pid]);
    expect(ledger.searchFts('"learning applied"')).toEqual([]);
    ledger.close();
  });

  it('retires a row on delete, whichever storage mode was probed', () => {
    const { ledger, lib } = seeded();
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'record', charStart: 0, charEnd: 4 });
    const sid = ledger.putSlab({ lib, source: 'record', sourceKey: 'REC001', charStart: 0, charEnd: 4, text: 'text' });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 0, offEnd: 4 });
    ledger.indexText(pid, { title: 'ephemeral' });
    expect(ledger.searchFts('ephemeral')).toEqual([pid]);
    ledger.unindexText(pid);
    expect(ledger.searchFts('ephemeral')).toEqual([]);
    ledger.close();
  });

  it('records which FTS layout was chosen, so the decision is read not re-guessed', () => {
    const { ledger } = seeded();
    const mode = ledger.db.prepare("SELECT value FROM ledger_meta WHERE key = 'ftsStorage'").get() as
      | { value: string }
      | undefined;
    // Every runtime this suite can reach is past SQLite 3.43, so the probe should take
    // the contentless layout here. Asserting the value rather than the shape is what makes
    // this a check: a probe that silently fell back would otherwise read as a pass.
    expect(mode?.value).toBe('contentless');
    expect(ledger.ftsStorage).toBe('contentless');
    ledger.close();
  });
});

describeSqlite('v2 content schema: the external-content fallback', () => {
  /**
   * §5.2.2 keeps v1's external-content layout as the probed fallback for a runtime below
   * SQLite 3.43. Every runtime this is developed on is above it, so without forcing the
   * layout the fallback would ship as the one path nothing has ever executed — and its
   * delete protocol is the half that fails silently, leaving the index pointing at a
   * rowid that no longer resolves.
   */
  function external(): { ledger: Ledger; lib: number; pid: number } {
    const ledger = Ledger.open(':memory:', new ManualClock(1), { ftsStorage: 'external' });
    const oid = ledger.registerOrigin('server-aaa');
    const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    const eid = ledger.putEntry({ lib, itemKey: 'REC001', ordinal: 0, kind: 'record', charStart: 0, charEnd: 4 });
    const sid = ledger.putSlab({ lib, source: 'record', sourceKey: 'REC001', charStart: 0, charEnd: 4, text: 'text' });
    const pid = ledger.putPassage({ eid, lib, itemKey: 'REC001', sid, offStart: 0, offEnd: 4 });
    return { ledger, lib, pid };
  }

  it('indexes, scopes and retires a row through the shadow table', () => {
    const { ledger, pid } = external();
    expect(ledger.ftsStorage).toBe('external');
    ledger.indexText(pid, { title: 'Brontë essays', tags: 'fiction' });
    expect(ledger.searchFts('Bronte')).toEqual([pid]);
    expect(ledger.searchFts('title:fiction')).toEqual([]);

    ledger.unindexText(pid);
    expect(ledger.searchFts('Bronte')).toEqual([]);
    // The shadow row goes with it: an external-content index whose backing row survives is
    // a row the next rebuild would index twice.
    expect((ledger.db.prepare('SELECT count(*) AS n FROM fts_content').get() as { n: number }).n).toBe(0);
    ledger.close();
  });

  it('re-indexing replaces rather than duplicates', () => {
    const { ledger, pid } = external();
    ledger.indexText(pid, { title: 'first' });
    ledger.indexText(pid, { title: 'second' });
    expect(ledger.searchFts('first')).toEqual([]);
    expect(ledger.searchFts('second')).toEqual([pid]);
    expect((ledger.db.prepare('SELECT count(*) AS n FROM fts_content').get() as { n: number }).n).toBe(1);
    ledger.close();
  });

  it('reopens a file in the layout its rows are in, not the one this runtime prefers', () => {
    // The trap the recorded value exists for: a runtime that gained contentless_delete
    // since the file was written must still speak the protocol the existing rows are in.
    const dir = tmpDir('v2-fts-recorded');
    const path = join(dir, 'search-index-v2.sqlite');
    const first = Ledger.open(path, new ManualClock(1), { ftsStorage: 'external' });
    first.close();
    const second = Ledger.open(path, new ManualClock(1));
    expect(second.ftsStorage).toBe('external');
    second.close();
  });
});

describeSqlite('v2 content schema: the production file path', () => {
  it('names search-index-v2.sqlite beside v1s artifacts in the data directory', () => {
    expect(conductorLedgerPath('/data')).toBe(join('/data', 'search-index-v2.sqlite'));
    // Multi-tenant mode keys per user exactly as v1 does, so two tenants never share one
    // file. Inside the file, C1's partition is `origins`/`libraries`, not the filename.
    expect(conductorLedgerPath('/data', 42)).toBe(join('/data', 'search-index-v2-42.sqlite'));
  });

  it('creates the file on disk when the conductor store is opened', () => {
    const dir = tmpDir('v2-prod-path');
    const ledger = openConductorLedger({ dataDir: dir });
    expect(existsSync(join(dir, 'search-index-v2.sqlite'))).toBe(true);
    expect(ledger.autoVacuumIncremental).toBe(true);
    ledger.close();
  });
});

describeSqlite('v2 content schema: v1 is untouched and both files coexist', () => {
  it('opens and writes search-index.sqlite and search-index-v2.sqlite in one data directory', async () => {
    const dir = tmpDir('v2-coexist');
    const v1 = await createSearchIndex({
      embedder: null,
      logger: silentLogger,
      backend: 'sqlite',
      jsonPath: join(dir, 'search-index.json'),
    });
    const v2 = openConductorLedger({ dataDir: dir });

    // Both live, both written, interleaved — the point is that neither open takes a lock
    // the other waits on, because they are separate files with separate WALs.
    await v1.build([{ key: 'A', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks' } }]);
    const oid = v2.registerOrigin('server-aaa');
    const lib = v2.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    v2.putSlab({ lib, source: 'record', sourceKey: 'A', charStart: 0, charEnd: 5, text: 'hello' });
    await v1.build([{ key: 'B', data: { itemType: 'book', title: 'Rainfall', abstractNote: 'climate' } }]);

    // v1 still answers over its own file, having been written either side of a v2 write.
    expect(await v1.query('rainfall')).not.toHaveLength(0);
    expect((v2.db.prepare('SELECT count(*) AS n FROM slabs').get() as { n: number }).n).toBe(1);

    const files = readdirSync(dir);
    expect(files).toContain('search-index.sqlite');
    expect(files).toContain('search-index-v2.sqlite');

    await v1.close();
    v2.close();
  });
});
