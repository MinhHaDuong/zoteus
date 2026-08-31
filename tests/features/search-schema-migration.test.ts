import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { SchemaMigration } from '../../src/features/search/sqlite-index.js';

/**
 * The upgrade path a SCHEMA_VERSION bump takes (#34).
 *
 * Until this existed the stamp had exactly two accepted states — no tables, or this
 * build's own version — and everything else was moved aside and rebuilt from zero,
 * re-embedding included. That has never fired for anyone, because the stamp has been 1
 * since the SQLite backend landed, which is the entire point: the next bump is the
 * expensive one, and it costs a 255k-passage library five and a half hours of local
 * embedding (or a hosted provider's bill) for what is usually an added column.
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
  to: 2,
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
    const second = await openIndex(path, { embedder, schemaVersion: 2, migrations: [ADD_COLUMN] });
    try {
      expect(sidelined(path)).toHaveLength(0);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('2');
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
      expect(second.buildStatus().storageNotice).toMatch(/upgraded in place from schema version 1 to 2/);
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
      { to: 2, what: 'added passages.language', up: (db) => { ran.push(2); db.exec('ALTER TABLE passages ADD COLUMN language TEXT'); } },
      { to: 3, what: 'indexed passages.language', up: (db) => { ran.push(3); db.exec('CREATE INDEX passages_language ON passages(language)'); } },
    ];
    const second = await openIndex(path, { schemaVersion: 3, migrations: ladder });
    try {
      expect(ran).toEqual([2, 3]);
      expect(readColumn(path, "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('3');
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

    // Version 3 exists, version 2 does not: nothing accounts for what version 2's rows
    // were, so stepping over it would be a guess rather than a migration.
    const gapped: SchemaMigration[] = [{ to: 3, what: 'added a column', up: (db) => db.exec('ALTER TABLE passages ADD COLUMN language TEXT') }];
    const second = await openIndex(path, { schemaVersion: 3, migrations: gapped });
    try {
      expect(sidelined(path)).toHaveLength(1);
      expect(second.status().documents).toBe(0);
    } finally {
      await second.close();
    }
  });

  sqliteIt('leaves the database exactly as it was when a rung throws, then sidelines it', async () => {
    const path = tmpDbPath('migrate-failure');
    const first = await openIndex(path);
    await first.build(ITEMS);
    await first.save();
    const documents = first.status().documents;
    await first.close();

    const broken: SchemaMigration[] = [
      {
        to: 2,
        what: 'added passages.language',
        up: (db) => {
          db.exec('ALTER TABLE passages ADD COLUMN language TEXT');
          throw new Error('rung failed halfway');
        },
      },
    ];
    const second = await openIndex(path, { schemaVersion: 2, migrations: broken });
    try {
      // The moved-aside file is the ORIGINAL: still at version 1, still holding its rows,
      // and without the half-applied column — the rung and the stamp share one transaction.
      const aside = sidelined(path);
      expect(aside).toHaveLength(1);
      expect(readColumn(aside[0], "SELECT value AS v FROM meta WHERE key = 'schemaVersion'").v).toBe('1');
      expect(readColumn(aside[0], 'SELECT COUNT(*) AS n FROM passages').n).toBe(documents);
      expect(readColumn(aside[0], "SELECT COUNT(*) AS n FROM pragma_table_info('passages') WHERE name = 'language'").n).toBe(0);
      // And the fresh index at the original path says why it is empty.
      expect(second.status().documents).toBe(0);
      expect(second.buildStatus().storageNotice).toMatch(/could not be upgraded \(rung failed halfway\)/);
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

    const second = await openIndex(path, { schemaVersion: 2, migrations: [ADD_COLUMN] });
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
