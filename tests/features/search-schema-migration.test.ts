import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { repairSearchIndex } from '../../src/features/search/repair.js';
import type { ToolContext } from '../../src/registry/registry.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { SchemaMigration } from '../../src/features/search/sqlite-index.js';

/**
 * The upgrade path a SCHEMA_VERSION bump takes (#34).
 *
 * Until this existed the stamp had exactly two accepted states — no tables, or this
 * build's own version — and everything else was moved aside and rebuilt from zero,
 * re-embedding included. The ladder was built before the first bump, which is the entire
 * point: without it, that bump would have cost a 255k-passage library five and a half
 * hours of local embedding (or a hosted provider's bill). The first real rung has now
 * shipped — the keep-diacritics re-tokenization, stamped 2 and pinned by the cases at
 * the end of this file; the ADD_COLUMN-style rungs above them are generic machinery
 * fixtures, not shipped migrations.
 *
 * These cases play the part of the build that makes that bump, through the schemaVersion /
 * migrations options, and pin both halves of the answer: a database at an older version of
 * OUR schema is upgraded in place with nothing re-read and nothing re-embedded, and one
 * nothing on the ladder reaches is still moved aside — but hands its vectors to the
 * rebuild that replaces it, since an embedding is a function of the text and the model and
 * a schema change touches neither.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

const sqliteModule = nodeSqliteAvailable()
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

const ITEMS = [
  { key: 'AAAAAAAA', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks at scale' } },
  { key: 'BBBBBBBB', data: { itemType: 'book', title: 'Shallow water', abstractNote: 'tidal models of estuaries' } },
];

/** Counts every text it is asked to embed, which is the cost the salvage exists to avoid. */
class CountingEmbedder implements EmbeddingProvider {
  readonly name = 'counting-fake';
  calls = 0;
  texts = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts += texts.length;
    return texts.map((t) => {
      let s = 2166136261;
      for (let i = 0; i < t.length; i++) s = (Math.imul(s ^ t.charCodeAt(i), 16777619) >>> 0) || 1;
      return Array.from({ length: 16 }, () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296 - 0.5;
      });
    });
  }
}

function tmpDbPath(name: string): string {
  return sqliteIndexPath(join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json'));
}

async function openIndex(
  path: string,
  opts: { embedder?: EmbeddingProvider | null; schemaVersion?: number; migrations?: SchemaMigration[] } = {},
) {
  const { SqliteSearchIndex } = await import('../../src/features/search/sqlite-index.js');
  const index = new SqliteSearchIndex({
    embedder: opts.embedder ?? null,
    logger: silentLogger,
    path,
    ...(opts.schemaVersion === undefined ? {} : { schemaVersion: opts.schemaVersion }),
    ...(opts.migrations === undefined ? {} : { migrations: opts.migrations }),
  });
  await index.open();
  return index;
}

function stampSchemaVersion(dbPath: string, value: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(value);
  db.close();
}

function readColumn(dbPath: string, sql: string): any {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(sql).get();
  db.close();
  return row;
}

function sidelined(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const name = basename(dbPath);
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.incompatible-`) && !/-(wal|shm|journal)$/.test(f))
    .map((f) => join(dir, f));
}

/** The shape of a routine bump: a column nothing already stored has to be re-derived for. */
const ADD_COLUMN: SchemaMigration = {
  to: 4,
  what: 'added passages.language',
  up: (db) => db.exec('ALTER TABLE passages ADD COLUMN language TEXT'),
};

describe('a SCHEMA_VERSION bump migrates the index it finds', () => {
  sqliteIt('upgrades an older index in place, keeping every passage and every vector', async () => {
    const path = tmpDbPath('migrate-inplace');
    const embedder = new CountingEmbedder();
    const first = await openIndex(path, { embedder });
    await first.build(ITEMS);
    await first.save();
    const before = first.status();
    await first.close();
    expect(before.vectors).toBeGreaterThan(0);
    const embeddedByBuild = embedder.texts;

    // The next build: same file, one version further on, with the rung that gets there.
    const second = await openIndex(path, { embedder, schemaVersion: 4, migrations: [ADD_COLUMN] });
    try {
      expect(sidelined(path)).toHaveLength(0);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('4');
      // The rows themselves are untouched: same passages, same vectors, still searchable.
      const after = second.status();
      expect(after.documents).toBe(before.documents);
      expect(after.vectors).toBe(before.vectors);
      expect((await second.query('estuaries', { mode: 'keyword' })).length).toBeGreaterThan(0);
      // And the migration is what the column change was for.
      const columns = readColumn(path, "SELECT COUNT(*) AS n FROM pragma_table_info('passages') WHERE name = 'language'");
      expect(columns.n).toBe(1);
      // Nothing was re-embedded to get here.
      expect(embedder.texts).toBe(embeddedByBuild);
      expect(second.buildStatus().storageNotice).toMatch(/upgraded in place from schema version 3 to 4/);
    } finally {
      await second.close();
    }
  });

  sqliteIt('walks every rung when a database is more than one version behind', async () => {
    const path = tmpDbPath('migrate-ladder');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    await first.close();

    const ran: number[] = [];
    const ladder: SchemaMigration[] = [
      { to: 4, what: 'added passages.language', up: (db) => { ran.push(4); db.exec('ALTER TABLE passages ADD COLUMN language TEXT'); } },
      { to: 5, what: 'indexed passages.language', up: (db) => { ran.push(5); db.exec('CREATE INDEX passages_language ON passages(language)'); } },
    ];
    const second = await openIndex(path, { schemaVersion: 5, migrations: ladder });
    try {
      expect(ran).toEqual([4, 5]);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('5');
      expect(second.status().documents).toBeGreaterThan(0);
    } finally {
      await second.close();
    }
  });

  sqliteIt('sidelines rather than migrating when the ladder has a gap', async () => {
    const path = tmpDbPath('migrate-gap');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    await first.close();

    // Version 4 exists, version 3 does not: nothing accounts for what version 3's rows
    // were, so stepping over it would be a guess rather than a migration.
    const gapped: SchemaMigration[] = [{ to: 5, what: 'added a column', up: (db) => db.exec('ALTER TABLE passages ADD COLUMN language TEXT') }];
    const second = await openIndex(path, { schemaVersion: 5, migrations: gapped });
    try {
      expect(sidelined(path)).toHaveLength(1);
      expect(second.status().documents).toBe(0);
    } finally {
      await second.close();
    }
  });

  sqliteIt('refuses, and keeps the file, when a rung fails for a transient reason', async () => {
    // The failure this guards against was executed, not argued: a `ulimit -f`-induced
    // write error mid-ladder — same class as a full disk — used to be treated exactly
    // like a foreign schema, and a proven-intact 87 MB database was renamed away while a
    // fresh empty one silently took its place. A transient error is a database that
    // failed to upgrade TODAY; only corruption is evidence to move the file aside.
    const path = tmpDbPath('migrate-failure');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    const documents = first.status().documents;
    await first.close();

    const broken: SchemaMigration[] = [
      {
        to: 4,
        what: 'added passages.language',
        up: (db) => {
          db.exec('ALTER TABLE passages ADD COLUMN language TEXT');
          throw new Error('rung failed halfway');
        },
      },
    ];
    await expect(openIndex(path, { schemaVersion: 4, migrations: broken })).rejects.toThrow(
      /intact at schema version 3 but could not be upgraded to 4: rung failed halfway/,
    );
    // NOT sidelined: the original file sits untouched at its own path, at its old stamp,
    // holding every row and without the half-applied column — the rung and the stamp
    // share one transaction, and the refusal wrote nothing.
    expect(sidelined(path)).toHaveLength(0);
    expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('3');
    expect(readColumn(path, 'SELECT COUNT(*) AS n FROM passages').n).toBe(documents);
    expect(readColumn(path, "SELECT COUNT(*) AS n FROM pragma_table_info('passages') WHERE name = 'language'").n).toBe(0);
    // And the retry the refusal promised is real: the same database opens and migrates
    // once the condition clears.
    const repaired = await openIndex(path, {
      schemaVersion: 4,
      migrations: [{ to: 4, what: 'added passages.language', up: (db) => db.exec('ALTER TABLE passages ADD COLUMN language TEXT') }],
    });
    try {
      expect(repaired.status().documents).toBe(documents);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('4');
    } finally {
      await repaired.close();
    }
  });

  sqliteIt('gives that refusal nothing to delete, so a build cannot discard the intact file', async () => {
    // The refusal above ends with "a rebuild is NOT needed and would discard a usable
    // index", and the product has to mean it. `zotero_index action:"build"` repairs an
    // unreadable store by deleting exactly the files the fault names, and the fault this
    // refusal raises used to name the database itself — so the one call a user makes after
    // reading "search is unavailable" would have unlinked the intact, fully vectorized file
    // the sentence had just called intact, over a full disk. A fault whose remedy is a
    // restart names no file, and the repair refuses instead.
    const path = tmpDbPath('migrate-failure-repair');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    const documents = first.status().documents;
    await first.close();

    const broken: SchemaMigration[] = [
      {
        to: 4,
        what: 'added passages.language',
        up: (db) => {
          db.exec('ALTER TABLE passages ADD COLUMN language TEXT');
          throw new Error('database or disk is full');
        },
      },
    ];
    const refusal = await openIndex(path, { schemaVersion: 4, migrations: broken }).then(
      () => {
        throw new Error('the open was expected to refuse');
      },
      (e: Error & { files?: string[] }) => e,
    );
    expect(refusal.files).toEqual([]);

    // Through the repair itself, because that is where the deletion would have happened.
    // It never reaches the reopen: a fault naming no file is refused before anything is
    // unlinked, and the refusal repeats the advice that actually works.
    const ctx = {
      search: {
        storeFault: refusal,
        isBuilding: false,
        close: async () => {},
      },
      reopenSearchIndex: async () => {
        throw new Error('the repair must not get as far as reopening');
      },
    };
    await expect(repairSearchIndex(ctx as unknown as ToolContext)).rejects.toThrow(
      /could not be upgraded to 4/,
    );
    expect(existsSync(path)).toBe(true);
    expect(readColumn(path, 'SELECT COUNT(*) AS n FROM passages').n).toBe(documents);
    expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('3');
  });

  sqliteIt('still sidelines when the rung failure IS corruption', async () => {
    // The discriminating control for the refusal above: the same shape of failure, with a
    // corruption sentence in it, must still move the file aside — a database whose pages
    // are bad is evidence, not a retry candidate.
    const path = tmpDbPath('migrate-corrupt');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    await first.close();

    const corrupting: SchemaMigration[] = [
      { to: 4, what: 'added passages.language', up: () => { throw new Error('database disk image is malformed'); } },
    ];
    const second = await openIndex(path, { schemaVersion: 4, migrations: corrupting });
    try {
      expect(sidelined(path)).toHaveLength(1);
      expect(second.status().documents).toBe(0);
      expect(second.buildStatus().storageNotice).toMatch(/could not be upgraded \(database disk image is malformed\)/);
    } finally {
      await second.close();
    }
  });

  sqliteIt('never migrates downwards: a newer build\'s database is still moved aside', async () => {
    const path = tmpDbPath('migrate-newer');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    await first.close();
    stampSchemaVersion(path, '99');

    const second = await openIndex(path, { schemaVersion: 4, migrations: [ADD_COLUMN] });
    try {
      expect(sidelined(path)).toHaveLength(1);
      expect(readColumn(sidelined(path)[0], "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('99');
      expect(second.status().documents).toBe(0);
    } finally {
      await second.close();
    }
  });
});

describe('a sideline hands its vectors to the rebuild that replaces it', () => {
  sqliteIt('reuses a vector for a passage whose text is unchanged, and re-embeds one whose text moved', async () => {
    const path = tmpDbPath('salvage-reuse');
    const embedder = new CountingEmbedder();
    const first = await openIndex(path, { embedder });
    await first.build(ITEMS);
    await first.save();
    const built = first.status();
    await first.close();
    expect(built.vectors).toBeGreaterThan(0);

    // A stamp this build cannot reach: the sideline, and the full rebuild behind it.
    stampSchemaVersion(path, '99');
    const embedded = embedder.texts;
    const second = await openIndex(path, { embedder });
    try {
      expect(sidelined(path)).toHaveLength(1);
      expect(second.buildStatus().storageNotice).toMatch(/takes its vector from the moved-aside index/);

      // One item comes back unchanged and one comes back with a new abstract.
      const edited = [ITEMS[0], { key: 'BBBBBBBB', data: { itemType: 'book', title: 'Shallow water', abstractNote: 'a completely different subject' } }];
      await second.build(edited);
      await second.save();

      const after = second.status();
      expect(after.vectors).toBe(built.vectors);
      // Only the passages whose text actually changed were bought again.
      expect(embedder.texts).toBeGreaterThan(embedded);
      expect(embedder.texts - embedded).toBeLessThan(built.vectors);
      expect(after.storageNotice).toMatch(/vector\(s\) have been reused from .*incompatible-.* rather than re-embedded/);
      // The reused vectors are the same numbers, not merely the same count: a semantic
      // query still ranks the untouched item first for its own words.
      const hits = await second.query('neural networks at scale', { mode: 'semantic' });
      expect(hits[0]?.itemKey).toBe('AAAAAAAA');
    } finally {
      await second.close();
    }
  });

  sqliteIt('still reuses them when the server restarts between the sideline and the rebuild', async () => {
    const path = tmpDbPath('salvage-restart');
    const embedder = new CountingEmbedder();
    const first = await openIndex(path, { embedder });
    await first.build(ITEMS);
    await first.save();
    const built = first.status();
    await first.close();
    stampSchemaVersion(path, '99');

    // The process that sidelines is rarely the one that rebuilds: the notice reaches a
    // user through action:"status", and by the time they act the server may have restarted.
    const sidelining = await openIndex(path, { embedder });
    await sidelining.close();

    const embedded = embedder.texts;
    const rebuilding = await openIndex(path, { embedder });
    try {
      await rebuilding.build(ITEMS);
      expect(rebuilding.status().vectors).toBe(built.vectors);
      expect(embedder.texts).toBe(embedded);
    } finally {
      await rebuilding.close();
    }
  });

  sqliteIt('stops pointing at a moved-aside index the user has since deleted', async () => {
    const path = tmpDbPath('salvage-deleted');
    const first = await openIndex(path, { embedder: new CountingEmbedder() });
    await first.build(ITEMS);
    await first.save();
    await first.close();
    stampSchemaVersion(path, '99');

    const sidelining = await openIndex(path, { embedder: new CountingEmbedder() });
    await sidelining.close();
    // "nothing was deleted" is the promise; deleting it afterwards is the user's right.
    rmSync(sidelined(path)[0]);

    const embedder = new CountingEmbedder();
    const after = await openIndex(path, { embedder });
    try {
      await after.build(ITEMS);
      expect(after.status().vectors).toBe(2);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'salvageFrom'").v).toBe('');
    } finally {
      await after.close();
    }
  });

  sqliteIt('refuses to reuse vectors another embedder produced, and says the rebuild must pay', async () => {
    const path = tmpDbPath('salvage-embedder');
    const first = await openIndex(path, { embedder: new CountingEmbedder() });
    await first.build(ITEMS);
    await first.save();
    await first.close();
    stampSchemaVersion(path, '99');

    const other = new CountingEmbedder();
    (other as { name: string }).name = 'another-fake';
    const second = await openIndex(path, { embedder: other });
    try {
      const notice = second.buildStatus().storageNotice ?? '';
      expect(notice).toMatch(/cannot be reused/);
      expect(notice).toMatch(/Budget for a full re-embed/);
      const before = other.texts;
      await second.build(ITEMS);
      // Every passage was embedded by the new provider: nothing was taken from the old file.
      expect(other.texts - before).toBe(second.status().vectors);
    } finally {
      await second.close();
    }
  });

  sqliteIt('prices the rebuild it prescribes even when there is nothing to salvage', async () => {
    const path = tmpDbPath('salvage-priced');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    const documents = first.status().documents;
    await first.close();
    stampSchemaVersion(path, '99');

    const second = await openIndex(path);
    try {
      const notice = second.buildStatus().storageNotice ?? '';
      expect(notice).toMatch(new RegExp(`re-indexes ${documents} passage\\(s\\)`));
      expect(notice).toMatch(/no embedding/);
    } finally {
      await second.close();
    }
  });
});

describe('the rung that keeps diacritics re-indexes text and re-embeds nothing', () => {
  /**
   * Age a fresh index into what version 1 actually left on disk: the keyword index
   * declared with `remove_diacritics 2`, holding the raw passage text rather than the
   * augmented form. Everything else — rows, vectors, stamp — is what the build wrote.
   *
   * Built by hand rather than by checking out the old code, because what has to be
   * migrated is a FILE, and the only honest fixture for a file format is the file.
   */
  function ageToVersionOne(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec('DROP TABLE IF EXISTS passages_fts');
    db.exec(`
      CREATE VIRTUAL TABLE passages_fts USING fts5(
        text,
        content='passages',
        content_rowid='pid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    const insert = db.prepare('INSERT INTO passages_fts(rowid, text) VALUES (?, ?)');
    for (const row of db.prepare('SELECT pid, text FROM passages').all() as Array<{ pid: number; text: string }>) {
      insert.run(row.pid, row.text);
    }
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schemaVersion', '1')").run();
    db.close();
  }

  sqliteIt('migrates a version 1 index in place, without re-embedding a single passage', async () => {
    const path = tmpDbPath('migrate-diacritics');
    const embedder = new CountingEmbedder();
    const first = await openIndex(path, { embedder });
    await first.build(ITEMS);
    await first.save();
    const before = first.status();
    await first.close();
    const embeddedByBuild = embedder.texts;
    expect(before.vectors).toBeGreaterThan(0);

    ageToVersionOne(path);

    const second = await openIndex(path, { embedder });
    try {
      // Migrated, not sidelined: the whole point of a rung is that the file survives.
      expect(sidelined(path)).toHaveLength(0);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('3');
      const after = second.status();
      expect(after.documents).toBe(before.documents);
      expect(after.vectors).toBe(before.vectors);
      // The claim this rung exists to make, and the expensive one to get wrong.
      expect(embedder.texts).toBe(embeddedByBuild);
      expect(second.buildStatus().storageNotice).toMatch(/upgraded in place from schema version 1 to 3/);
    } finally {
      await second.close();
    }
  });

  sqliteIt('and the re-indexed text answers with the new tokenizer, not the old one', async () => {
    const path = tmpDbPath('migrate-diacritics-answers');
    const first = await openIndex(path, { embedder: new CountingEmbedder() });
    await first.build([
      // Two accented passages against one bare one, so the accented spelling dominates
      // and the unaccented query expands (the gate compares document frequencies).
      { key: 'V1', data: { itemType: 'book', title: 'Bao cao', abstractNote: 'năm 2020 phát triển bền vững' } },
      { key: 'V2', data: { itemType: 'book', title: 'Ke hoach', abstractNote: 'năm 2021 chính sách năng lượng' } },
      // The contrast, without which neither assertion below could fail: a document holding
      // the bare spelling. On a `remove_diacritics 2` index the two are one token and the
      // accented query returns both.
      { key: 'EN', data: { itemType: 'book', title: 'Nam river', abstractNote: 'nam river basin hydrology' } },
    ]);
    await first.save();
    await first.close();

    ageToVersionOne(path);

    const second = await openIndex(path, { embedder: new CountingEmbedder() });
    try {
      // Before the rung this query was answered by a `remove_diacritics 2` index, where the
      // accented and unaccented spellings are one token and this could not discriminate.
      // After it, the accented query is exact and the unaccented one still reaches the
      // documents through query expansion over the map the rung derived.
      const exact = await second.query('n\u0103m', { limit: 5, mode: 'keyword' });
      expect([...new Set(exact.map((h) => h.itemKey))].sort()).toEqual(['V1', 'V2']);
      const loose = await second.query('nam', { limit: 5, mode: 'keyword' });
      expect([...new Set(loose.map((h) => h.itemKey))].sort()).toEqual(['EN', 'V1', 'V2']);
    } finally {
      await second.close();
    }
  });
});
