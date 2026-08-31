import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIndexBuild, PAGE_SIZE } from '../../src/features/search/build.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { canonicalLibraryToken } from '../../src/features/search/backend.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const hasSqlite = nodeSqliteAvailable();
const sqliteIt = hasSqlite ? it : it.skip;

function makeItems(n: number, prefix: string): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    data: { itemType: 'journalArticle', title: `${prefix} item ${i}`, abstractNote: `abstract body ${i}` },
  }));
}

/** One-page fetcher over a fixed item list, the shape buildIncremental crawls. */
function pageFetcher(items: any[], version = 42) {
  return async (start: number) => ({
    items: items.slice(start, start + PAGE_SIZE),
    totalResults: items.length,
    lastModifiedVersion: version,
  });
}

async function finished(index: { buildStatus(): { state: string } }): Promise<void> {
  for (let i = 0; i < 500 && index.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('canonicalLibraryToken', () => {
  it('normalizes the personal library to one token, however it is addressed', () => {
    // The desktop app serves the personal library as users/0; the cloud names the real
    // user id. Same library, so same token — otherwise the guard would refuse the
    // legitimate rebuild that crosses the local/cloud seam.
    expect(canonicalLibraryToken(undefined)).toBe('user');
    expect(canonicalLibraryToken({ type: 'user', id: 0 })).toBe('user');
    expect(canonicalLibraryToken({ type: 'user', id: 19552201 })).toBe('user');
  });

  it('keys each group by its id', () => {
    expect(canonicalLibraryToken({ type: 'group', id: 4523 })).toBe('group:4523');
    expect(canonicalLibraryToken({ type: 'group', id: 7 })).toBe('group:7');
  });
});

describe('the cross-library wipe guard (engine)', () => {
  it('refuses a build for a different library instead of erasing the index', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await index.buildIncremental(pageFetcher(makeItems(5, 'U')), { library: 'user' });
    expect(index.buildStatus().items).toBe(5);

    // The repro: on a tree without the guard this second build reaches clearStore(),
    // silently replaces the personal library's index with the group's, and "succeeds".
    await expect(
      index.buildIncremental(pageFetcher(makeItems(2, 'G')), { library: 'group:4523' }),
    ).rejects.toThrow(/personal library[\s\S]*group 4523/);

    // Refused means untouched: the first library's rows are all still there and queryable.
    const status = index.buildStatus();
    expect(status.items).toBe(5);
    expect(status.library).toBe('user');
    expect(await index.query('abstract body', { mode: 'keyword' })).not.toHaveLength(0);
  });

  it('lets the same library rebuild, and a legacy unstamped index build for anyone', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await index.buildIncremental(pageFetcher(makeItems(3, 'U')), { library: 'user' });
    // A rebuild of the library the index already holds is the ordinary retry path.
    await index.buildIncremental(pageFetcher(makeItems(4, 'U')), { library: 'user' });
    expect(index.buildStatus().items).toBe(4);

    // An index persisted before the stamp existed carries no library. It guards nothing:
    // there is no way to know whose rows these are, and refusing would strand every
    // existing index behind an error no rebuild could clear.
    const legacy = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const snapshot = index.toJSON();
    delete (snapshot as any).library;
    legacy.loadFromJSON(snapshot);
    await legacy.buildIncremental(pageFetcher(makeItems(2, 'G')), { library: 'group:9' });
    expect(legacy.buildStatus().items).toBe(2);
    expect(legacy.buildStatus().library).toBe('group:9');
  });

  it('guards the update path with the same stamp', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await index.buildIncremental(pageFetcher(makeItems(3, 'U')), { library: 'user', versionBackend: 'local' });

    await expect(
      index.updateIncremental({
        library: 'group:4523',
        backend: 'local',
        fetchChanged: pageFetcher([], 43),
        liveKeys: async () => new Set<string>(),
      }),
    ).rejects.toThrow(/group 4523/);
    expect(index.buildStatus().items).toBe(3);
  });

  it('survives the JSON save/load roundtrip', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await index.buildIncremental(pageFetcher(makeItems(3, 'U')), { library: 'user' });

    const reloaded = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    reloaded.loadFromJSON(index.toJSON());
    expect(reloaded.buildStatus().library).toBe('user');
    await expect(
      reloaded.buildIncremental(pageFetcher(makeItems(2, 'G')), { library: 'group:12' }),
    ).rejects.toThrow(/would erase/);
  });

  sqliteIt('survives an SQLite close and reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-libguard-'));
    const jsonPath = join(dir, 'search-index.json');
    const open = () =>
      createSearchIndex({ backend: 'sqlite', jsonPath, embedder: null, logger: silentLogger });

    const first = await open();
    await first.buildIncremental(pageFetcher(makeItems(3, 'U')), { library: 'user' });
    await first.save();
    await first.close();

    const second = await open();
    expect(second.buildStatus().library).toBe('user');
    await expect(
      second.buildIncremental(pageFetcher(makeItems(2, 'G')), { library: 'group:4523' }),
    ).rejects.toThrow(/would erase/);
    expect(second.buildStatus().items).toBe(3);
    await second.close();
  });
});

describe('the cross-library wipe guard (tool path)', () => {
  function makeCtx(items: number) {
    const web = {
      listItems: vi.fn(async (_lib: any, q: { limit?: number; start?: number }) => ({
        data: makeItems(items, 'W').slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
        totalResults: items,
        lastModifiedVersion: 2114,
      })),
    };
    const local = {
      listItems: vi.fn(async (q: { limit?: number; start?: number }) => ({
        data: makeItems(items, 'L').slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
        totalResults: items,
        lastModifiedVersion: 13,
      })),
    };
    const config = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
    const capabilities = {
      cloud: { userID: 19552201, username: 'oscardvs', access: {} } as any,
      localApi: true,
      localGroupIds: [4523],
    };
    const router = new LibraryRouter({ config, capabilities, web: web as any, local: local as any });
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const ctx: any = { config, capabilities, router, web, local, search, searchIndexPath: '', logger: silentLogger };
    return { ctx, search };
  }

  it('refuses synchronously, so the refusal reaches the tool caller, and leaves the index intact', async () => {
    const { ctx, search } = makeCtx(6);
    startIndexBuild(ctx);
    await finished(search);
    expect(search.buildStatus().items).toBe(6);

    // On a tree without the guard this wipes the personal index and indexes the group
    // over it — the erase the refusal exists to prevent. The throw must be synchronous:
    // the build job is fire-and-forget, so a rejection there only reaches the log.
    expect(() => startIndexBuild(ctx, { type: 'group', id: 4523 })).toThrow(/personal library[\s\S]*group 4523/);
    expect(search.buildStatus().items).toBe(6);
    expect(search.buildStatus().library).toBe('user');
  });

  it('never refuses the personal library across the local/cloud seam', async () => {
    const { ctx, search } = makeCtx(4);
    // Built via the desktop app (users/0 addressing) ...
    startIndexBuild(ctx);
    await finished(search);
    expect(search.buildStatus().library).toBe('user');
    // ... rebuilt with the personal library named by its cloud user id: same library,
    // same token, no refusal — the seam the startIndexBuild doc-comment promises away.
    startIndexBuild(ctx, { type: 'user', id: 19552201 });
    await finished(search);
    expect(search.buildStatus().state).toBe('done');
    expect(search.buildStatus().library).toBe('user');
  });
});

describe("the wipe guard and a resumed build (the second shape, since 1.10.0)", () => {
  it("refuses a different library rather than resuming into the index it holds", async () => {
    // Resume (#24) made the hazard two-shaped. A build no longer always clears the store:
    // where an interrupted run left a checkpoint, it CARRIES ON from it, and resumeFrom()
    // gates on `fresh`, the checkpoint, a non-empty store and the embedder — never on the
    // library. So without the guard a build for another library skips reset() entirely and
    // appends its items to the rows already there: not the erase this PR started from, but
    // the same defect one turn worse, since the index then holds two libraries at once and
    // still reports `done`. offsetStillHolds() cannot catch it — it only ever invalidates
    // the crawl OFFSET, and keeps the committed rows either way.
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });

    // Interrupt a personal-library build, so a checkpoint is left with the rows.
    const items = makeItems(120, "U");
    await index.buildIncremental(async (start: number) => {
      if (start >= PAGE_SIZE) index.requestStop();
      return { items: items.slice(start, start + PAGE_SIZE), totalResults: items.length, lastModifiedVersion: 42 };
    }, { library: "user" });
    const indexed = index.buildStatus().items;
    expect(indexed).toBeGreaterThan(0);
    expect(indexed).toBeLessThan(items.length);

    // The same build again resumes — the path this case is about is live, not skipped.
    await expect(
      index.buildIncremental(pageFetcher(makeItems(2, "G")), { library: "group:4523" }),
    ).rejects.toThrow(/personal library[\s\S]*group 4523/);

    // Refused before resumeFrom(), so neither shape ran: nothing erased, nothing mixed.
    const status = index.buildStatus();
    expect(status.items).toBe(indexed);
    expect(status.library).toBe("user");
    const hits = await index.query("abstract body", { mode: "keyword", limit: 200 });
    expect(hits.every((h: any) => String(h.itemKey ?? h.key ?? "").startsWith("U"))).toBe(true);
  });
});
