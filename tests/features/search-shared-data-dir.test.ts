import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** node:sqlite arrived in Node 22.13; where it is missing those cases skip, as elsewhere. */
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];
const sqliteIt = hasSqlite ? it : it.skip;

const LIBRARY = 'user:1';

function open(backend: 'memory' | 'sqlite', dir: string): Promise<SearchIndex> {
  return createSearchIndex({
    embedder: null,
    logger: silentLogger,
    backend,
    jsonPath: join(dir, 'search-index.json'),
  });
}

function item(key: string) {
  return {
    key,
    data: {
      key,
      itemType: 'journalArticle',
      title: `Paper ${key}`,
      abstractNote: 'convolutional networks classify images',
    },
  };
}

/** A complete little build: one page, stamped at `version`, like the headless one a user runs. */
async function indexOne(index: SearchIndex, key: string, version: number): Promise<void> {
  await index.buildIncremental(
    async (start) => ({
      items: start === 0 ? [item(key)] : [],
      totalResults: 1,
      lastModifiedVersion: version,
    }),
    { versionBackend: 'cloud', library: LIBRARY },
  );
}

/** The shutdown path every context takes (server.flushIndexes): save, then close. */
async function shutdown(index: SearchIndex): Promise<void> {
  await index.save().catch(() => {});
  await index.close().catch(() => {});
}

describe.each(backends)('two handles on one data dir (%s backend)', (backend) => {
  it('keeps the stamp another process wrote when an idle handle shuts down', async () => {
    const dir = await mkdtemp(join(tmpdir(), `zoteus-shared-${backend}-`));
    // Open first and then touch nothing: the desktop app's index handle across a headless
    // build, whose in-memory meta is whatever the file said when it opened.
    const idle = await open(backend, dir);
    const builder = await open(backend, dir);
    await indexOne(builder, 'A', 42);
    await shutdown(builder);

    await shutdown(idle);

    const reopened = await open(backend, dir);
    expect(reopened.buildStatus().libraryVersion).toBe(42);
    expect(reopened.buildStatus().libraryBackend).toBe('cloud');
    expect(reopened.isEmpty).toBe(false);
    expect(reopened.updateBlocker('cloud')).toBeUndefined();
    await reopened.close();
  });

  it('does not clear a durable pause another process set', async () => {
    const dir = await mkdtemp(join(tmpdir(), `zoteus-shared-pause-${backend}-`));
    const idle = await open(backend, dir);
    const other = await open(backend, dir);
    await indexOne(other, 'A', 7);
    await other.setPaused(true);
    await shutdown(other);

    await shutdown(idle);

    const reopened = await open(backend, dir);
    expect(reopened.isPaused).toBe(true);
    await reopened.close();
  });

  it('still persists what a handle did change', async () => {
    const dir = await mkdtemp(join(tmpdir(), `zoteus-shared-own-${backend}-`));
    const search = await open(backend, dir);
    await indexOne(search, 'A', 5);
    await shutdown(search);

    const reopened = await open(backend, dir);
    expect(reopened.buildStatus().libraryVersion).toBe(5);
    expect(reopened.isEmpty).toBe(false);
    expect((await reopened.query('convolutional', { limit: 5 }))[0]?.itemKey).toBe('A');
    await reopened.close();
  });
});

describe('a handle held open across another process build', () => {
  sqliteIt('re-reads the store before deciding an update is impossible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-shared-stale-'));
    const idle = await open('sqlite', dir);
    const builder = await open('sqlite', dir);
    await indexOne(builder, 'A', 42);
    await shutdown(builder);

    // No reopen: this is the handle that was already open when the build ran, and it is
    // the one the user's next action:"update" would go through. Its own memory says the
    // index is empty and unstamped, and every such refusal ends in a full build that
    // clears the store.
    expect(idle.updateBlocker('cloud')).toBeUndefined();
    expect(idle.buildStatus().libraryVersion).toBe(42);
    expect(idle.isEmpty).toBe(false);
    await idle.close();
  });

  sqliteIt('says in the log which fields it did not write, and why', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-shared-log-'));
    const lines: string[] = [];
    const idle = await createSearchIndex({
      embedder: null,
      logger: { ...silentLogger, info: (m: string) => lines.push(m) },
      backend: 'sqlite',
      jsonPath: join(dir, 'search-index.json'),
    });
    const builder = await open('sqlite', dir);
    await indexOne(builder, 'A', 42);
    await shutdown(builder);
    await shutdown(idle);

    expect(lines.some((l) => /libraryVersion.*kept/s.test(l))).toBe(true);
    expect(lines.some((l) => /sharing this ZOTEUS_DATA_DIR/.test(l))).toBe(true);
  });
});

describe('a handle that emptied the store', () => {
  sqliteIt('writes its zeroed stamp even where another process had moved it on', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-shared-reset-'));
    const stale = await open('sqlite', dir);
    const builder = await open('sqlite', dir);
    await indexOne(builder, 'A', 42);
    await shutdown(builder);

    // `stale` never saw that stamp, and now runs a full build of its own. Its reset() has
    // already erased the rows the stamp described, so the stamp must go with them however
    // the merge decides what this handle changed: the build is stopped after its first
    // page, so nothing restamps it.
    await stale.buildIncremental(
      async (start) => {
        if (start > 0) stale.requestStop();
        return {
          items: Array.from({ length: 100 }, (_, i) => item(`K${start + i}`)),
          totalResults: 300,
          lastModifiedVersion: 99,
        };
      },
      { versionBackend: 'cloud', library: LIBRARY },
    );
    await shutdown(stale);

    const reopened = await open('sqlite', dir);
    // No stamp: an interrupted crawl covers an unknown prefix, and its checkpoint is what
    // the next build resumes from.
    expect(reopened.buildStatus().libraryVersion).toBe(0);
    expect(reopened.updateBlocker('cloud')).toMatch(/interrupted/);
    expect(reopened.isEmpty).toBe(false);
    await reopened.close();
  });
});
