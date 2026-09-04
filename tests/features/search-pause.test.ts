import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { loadIndex } from '../../src/features/search/persistence.js';
import { saveIndex } from '../../src/features/search/persistence.js';
import type { IndexSnapshot } from '../../src/features/search/backend.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

class GatedMemorySearchIndex extends MemorySearchIndex {
  private writes = 0;
  private releaseFirst!: () => void;
  readonly firstWriteStarted = new Promise<void>((resolve) => {
    this.releaseFirst = resolve;
  });
  private unblockFirst!: () => void;
  private readonly firstWriteGate = new Promise<void>((resolve) => {
    this.unblockFirst = resolve;
  });

  constructor(
    private readonly testPath: string,
    private readonly failSecond = false,
  ) {
    super({ embedder: null, logger: silentLogger, path: testPath });
  }

  release(): void {
    this.unblockFirst();
  }

  protected override async writeSnapshot(snapshot: IndexSnapshot): Promise<void> {
    const write = ++this.writes;
    if (write === 1) {
      this.releaseFirst();
      await this.firstWriteGate;
    }
    if (write === 2 && this.failSecond) throw new Error('second write failed');
    await saveIndex({ toJSON: () => snapshot, loadFromJSON() {} }, this.testPath);
  }
}

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
    await expect(reopened.buildIncremental(async () => ({ items: [], totalResults: 0 }))).rejects.toThrow(
      /paused.*resume/i,
    );

    const old = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    old.loadFromJSON({ chunks: [], vectors: [], builtFromVersion: 0 });
    expect(old.isPaused).toBe(false);
  });

  it('orders an in-flight JSON save before a newer durable pause', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-pause-overlap-'));
    const path = join(dir, 'search-index.json');
    const index = new GatedMemorySearchIndex(path);
    const older = index.save();
    await index.firstWriteStarted;
    const pause = index.setPaused(true);
    index.release();
    await Promise.all([older, pause]);

    const reopened = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    expect(await loadIndex(reopened, path)).toBe(true);
    expect(reopened.isPaused).toBe(true);
  });

  it('does not publish a transient resume when its queued write fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zoteus-pause-rollback-'));
    const path = join(dir, 'search-index.json');
    const seed = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    await seed.setPaused(true);

    const index = new GatedMemorySearchIndex(path, true);
    expect(await loadIndex(index, path)).toBe(true);
    const older = index.save(); // captures paused:true, then waits before publishing it
    await index.firstWriteStarted;
    const failedResume = index.setPaused(false); // captures false, queues second, then fails
    index.release();
    await older;
    await expect(failedResume).rejects.toThrow(/second write failed/);
    expect(index.isPaused).toBe(true); // setter rolled memory back

    const reopened = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    expect(await loadIndex(reopened, path)).toBe(true);
    expect(reopened.isPaused).toBe(true); // disk agrees; the transient false never published
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
