import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PAGE_SIZE } from '../../src/features/search/build.js';
import { nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

/**
 * Which library a salvaged vector is allowed to come from (#44).
 *
 * The vector salvage (#34) matches a rebuilt passage against a sidelined index on passage
 * id and byte-identical text. A passage id is an item key and a chunk number, and an item
 * key is unique within a library rather than across libraries, so that match is an
 * identity only once both sides are the same library's rows. Nothing in the salvage path
 * establishes that on its own: it is armed inside `sideline()` at file open, before any
 * build has said which library it is crawling, and the fresh index that replaces the
 * moved-aside one is deliberately unstamped, which is exactly the state `assertLibrary`
 * exempts. Two gates, and only one of them knew about libraries.
 *
 * Reaching a wrong vector took a conjunction (a schema-triggered sideline of one library's
 * file, a build for a different library against the fresh file that replaced it, the same
 * embedder, an item-key collision across the two, and byte-identical text), which is
 * remote, and was untested rather than known-safe. These cases build that conjunction
 * deliberately and pin both answers: a foreign library's vectors are refused and the
 * passages are embedded again, and a file that names no library still salvages.
 */

const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

const sqliteModule = nodeSqliteAvailable()
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

/**
 * The collision itself: the same item keys carrying the same words, which is what two
 * libraries holding the same paper look like to a passage id. Nothing about the second
 * library's build can tell these rows from the first library's.
 */
const ITEMS = [
  { key: 'AAAAAAAA', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks at scale' } },
  { key: 'BBBBBBBB', data: { itemType: 'book', title: 'Shallow water', abstractNote: 'tidal models of estuaries' } },
];

/** Counts every text it is asked to embed, which is the cost the salvage exists to avoid. */
class CountingEmbedder implements EmbeddingProvider {
  readonly name = 'counting-fake';
  texts = 0;
  async embed(texts: string[]): Promise<number[][]> {
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

/** Keeps what the server said, so the refusal can be read as the user would see it. */
function recordingLogger() {
  const info: string[] = [];
  return { info: (m: string) => info.push(m), debug() {}, warn() {}, error() {}, lines: info };
}

function tmpDbPath(name: string): string {
  return sqliteIndexPath(join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json'));
}

/** One-page fetcher over a fixed item list, the shape buildIncremental crawls. */
function pageFetcher(items: any[], version = 42) {
  return async (start: number) => ({
    items: items.slice(start, start + PAGE_SIZE),
    totalResults: items.length,
    lastModifiedVersion: version,
  });
}

async function openIndex(path: string, embedder: EmbeddingProvider, logger: any) {
  const { SqliteSearchIndex } = await import('../../src/features/search/sqlite-index.js');
  const index = new SqliteSearchIndex({ embedder, logger, path });
  await index.open();
  return index;
}

/** Make the file unreadable to this build, which is what arms a sideline. */
function stampSchemaVersion(dbPath: string, value: string): void {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(value);
  db.close();
}

function sidelined(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const name = basename(dbPath);
  return readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.incompatible-`) && !/-(wal|shm|journal)$/.test(f))
    .map((f) => join(dir, f));
}

/**
 * Build one library's index, then make its file unreadable to the next build, which is
 * what arms the sideline. Returns the vector count the sidelined file holds.
 */
async function buildThenSideline(
  path: string,
  embedder: EmbeddingProvider,
  logger: any,
  library: string | undefined,
): Promise<number> {
  const first = await openIndex(path, embedder, logger);
  await first.buildIncremental(pageFetcher(ITEMS), library === undefined ? {} : { library });
  await first.save();
  const vectors = first.status().vectors;
  await first.close();
  expect(vectors).toBeGreaterThan(0);
  stampSchemaVersion(path, '99');
  return vectors;
}

describe('the vector salvage only serves the library that wrote the sidelined index', () => {
  sqliteIt('refuses a group library\'s vectors to a build of the personal library', async () => {
    const path = tmpDbPath('salvage-cross-library');
    const embedder = new CountingEmbedder();
    const logger = recordingLogger();
    const vectors = await buildThenSideline(path, embedder, logger, 'group:4523');

    const embedded = embedder.texts;
    const second = await openIndex(path, embedder, logger);
    try {
      expect(sidelined(path)).toHaveLength(1);
      // Same keys, same text, same embedder, fresh unstamped file: every other condition
      // the salvage matches on holds, and the library is the only thing separating these
      // rows from the ones in the moved-aside file.
      await second.buildIncremental(pageFetcher(ITEMS), { library: 'user' });
      await second.save();

      expect(second.status().vectors).toBe(vectors);
      // Every passage was bought from the embedder: nothing was taken from the other
      // library's file, and the rebuild is correct because it simply re-embedded.
      expect(embedder.texts - embedded).toBe(vectors);
      expect(second.buildStatus().storageNotice ?? '').not.toMatch(/have been reused/);
      expect(logger.lines.join('\n')).toMatch(/were not reused[\s\S]*group 4523[\s\S]*the personal library/);
    } finally {
      await second.close();
    }
  });

  sqliteIt('refuses one group\'s vectors to another group, since a group is not a bucket', async () => {
    const path = tmpDbPath('salvage-cross-group');
    const embedder = new CountingEmbedder();
    const logger = recordingLogger();
    const vectors = await buildThenSideline(path, embedder, logger, 'group:12');

    const embedded = embedder.texts;
    const second = await openIndex(path, embedder, logger);
    try {
      await second.buildIncremental(pageFetcher(ITEMS), { library: 'group:4523' });
      expect(second.status().vectors).toBe(vectors);
      expect(embedder.texts - embedded).toBe(vectors);
    } finally {
      await second.close();
    }
  });

  sqliteIt('still hands them to a rebuild of the same library, which is what #34 is for', async () => {
    const path = tmpDbPath('salvage-same-library');
    const embedder = new CountingEmbedder();
    const logger = recordingLogger();
    const vectors = await buildThenSideline(path, embedder, logger, 'group:4523');

    const embedded = embedder.texts;
    const second = await openIndex(path, embedder, logger);
    try {
      await second.buildIncremental(pageFetcher(ITEMS), { library: 'group:4523' });
      await second.save();
      expect(second.status().vectors).toBe(vectors);
      // Nothing was re-embedded: the whole rebuild was paid for out of the moved-aside file.
      expect(embedder.texts).toBe(embedded);
      expect(second.buildStatus().storageNotice ?? '').toMatch(/vector\(s\) have been reused/);
    } finally {
      await second.close();
    }
  });

  sqliteIt('salvages from a sidelined index that carries no library stamp, which guards nothing', async () => {
    // The deliberate exemption, and the same one `assertLibrary` makes: an index written
    // before the stamp existed says nothing about whose rows it holds, and refusing on
    // that unknown would charge every pre-stamp index a full re-embed to protect against a
    // collision nobody can show.
    const path = tmpDbPath('salvage-unstamped');
    const embedder = new CountingEmbedder();
    const logger = recordingLogger();
    const vectors = await buildThenSideline(path, embedder, logger, undefined);

    const embedded = embedder.texts;
    const second = await openIndex(path, embedder, logger);
    try {
      await second.buildIncremental(pageFetcher(ITEMS), { library: 'user' });
      expect(second.status().vectors).toBe(vectors);
      expect(embedder.texts).toBe(embedded);
    } finally {
      await second.close();
    }
  });

  sqliteIt('refuses across a restart too, before a single passage is looked up', async () => {
    // The pointer path (#34): the process that sidelines is rarely the one that rebuilds,
    // so the sideline's destination is recorded in the fresh index's meta and re-armed on a
    // later open. Once that index is stamped, the mismatch is answered at the arming site.
    const path = tmpDbPath('salvage-cross-restart');
    const embedder = new CountingEmbedder();
    const logger = recordingLogger();
    const vectors = await buildThenSideline(path, embedder, logger, 'group:4523');

    const sidelining = await openIndex(path, embedder, logger);
    await sidelining.buildIncremental(pageFetcher(ITEMS), { library: 'user' });
    await sidelining.save();
    await sidelining.close();

    const embedded = embedder.texts;
    const restarted = await openIndex(path, embedder, logger);
    try {
      expect(restarted.buildStatus().library).toBe('user');
      expect(logger.lines.filter((l) => /were not reused/.test(l)).length).toBeGreaterThanOrEqual(2);
      // And an update over the same rows still buys its own vectors rather than the
      // group's, because the salvage was dropped rather than merely skipped once.
      await restarted.buildIncremental(pageFetcher(ITEMS), { library: 'user', fresh: true });
      expect(restarted.status().vectors).toBe(vectors);
      expect(embedder.texts - embedded).toBe(vectors);
    } finally {
      await restarted.close();
    }
  });
});
