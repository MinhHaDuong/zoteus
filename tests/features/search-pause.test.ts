import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { loadIndex } from '../../src/features/search/persistence.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

describe('durable index pause', () => {
  it('holds background work without disabling queries', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await index.build([
      { key: 'A', data: { itemType: 'journalArticle', title: 'Held index', abstractNote: 'still searchable' } },
    ]);
    await index.setPaused(true);

    expect((await index.query('searchable', { limit: 1 }))[0]?.itemKey).toBe('A');
    await expect(index.build([])).rejects.toThrow(/paused.*resume/i);
  });

  it('round-trips through the legacy JSON snapshot and defaults old snapshots to running', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-pause-json-'));
    const path = join(dir, 'search-index.json');
    const first = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    await first.setPaused(true);
    expect(JSON.parse(await readFile(path, 'utf8')).paused).toBe(true);

    const reopened = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    expect(await loadIndex(reopened, path)).toBe(true);
    expect(reopened.isPaused).toBe(true);
    await expect(reopened.buildIncremental(async () => ({ items: [] }))).rejects.toThrow(/paused.*resume/i);

    const old = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    old.loadFromJSON({ chunks: [], vectors: [], builtFromVersion: 0 });
    expect(old.isPaused).toBe(false);
  });

  sqliteIt('persists the hold in SQLite while idle and clears it without a schema bump', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-pause-sqlite-'));
    const jsonPath = join(dir, 'search-index.json');
    const first = await createSearchIndex({ backend: 'sqlite', jsonPath, embedder: null, logger: silentLogger });
    await first.setPaused(true);
    await first.close();

    const held = await createSearchIndex({ backend: 'sqlite', jsonPath, embedder: null, logger: silentLogger });
    expect(held.isPaused).toBe(true);
    expect(held.buildStatus().paused).toBe(true);
    await held.setPaused(false);
    await held.close();

    const cleared = await createSearchIndex({ backend: 'sqlite', jsonPath, embedder: null, logger: silentLogger });
    expect(cleared.isPaused).toBe(false);
    await cleared.close();
  });
});
