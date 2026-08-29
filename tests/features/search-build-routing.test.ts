import { describe, it, expect, vi } from 'vitest';
import { startIndexBuild, PAGE_SIZE } from '../../src/features/search/build.js';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

/** `n` items whose keys are prefixed so a hit tells us which backend served the build. */
function makeLibrary(n: number, prefix: string): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract body ${i}` },
  }));
}

/** Cloud Web API mock: listItems(library, query). */
function webClient(library: any[]) {
  return {
    listItems: vi.fn(async (_lib: any, q: { limit?: number; start?: number }) => ({
      data: library.slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
      totalResults: library.length,
      lastModifiedVersion: 2114,
    })),
  };
}

/** Desktop local API mock: listItems(query, lib). The router passes whichever library it
 * resolved: a user lib is addressed users/0 on the wire, a group lib groups/<id>. */
function localClient(library: any[]) {
  return {
    listItems: vi.fn(async (q: { limit?: number; start?: number }) => ({
      data: library.slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
      totalResults: library.length,
      // The desktop app keeps its own version sequence, far behind the cloud's.
      lastModifiedVersion: 13,
    })),
  };
}

function makeCtx(opts: {
  localApi: boolean;
  cloudKey?: boolean;
  items?: number;
  /** Groups this desktop app holds. Empty = pre-Zotero-10, or a group it does not have. */
  localGroupIds?: number[];
}) {
  const items = opts.items ?? 250;
  const web = webClient(makeLibrary(items, 'W'));
  const local = localClient(makeLibrary(items, 'L'));
  const config = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
  const capabilities = {
    cloud: opts.cloudKey === false ? null : (cloudInfo as any),
    localApi: opts.localApi,
    localGroupIds: opts.localGroupIds ?? [],
  };
  const router = new LibraryRouter({ config, capabilities, web: web as any, local: local as any });
  const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
  // Empty path = no persistence: these tests care about routing, not the index file.
  const ctx: any = { config, capabilities, router, web, local, search, searchIndexPath: '', logger: silentLogger };
  return { ctx, web, local, search };
}

async function finished(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 500 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('index build routing (local-first)', () => {
  it('builds from the desktop local API when it is available — no cloud key needed', async () => {
    // The issue-#5 case: no cloud key at all, Zotero desktop running.
    const { ctx, web, local, search } = makeCtx({ localApi: true, cloudKey: false });
    startIndexBuild(ctx);
    await finished(search);
    expect(web.listItems).not.toHaveBeenCalled();
    expect(local.listItems).toHaveBeenCalled();
    expect(local.listItems.mock.calls[0]![0]).toMatchObject({ limit: PAGE_SIZE, start: 0, top: true });
    const status = search.buildStatus();
    expect(status.state).toBe('done');
    expect(status.items).toBe(250);
    const hits = await search.query('abstract body', { limit: 1 });
    expect(hits[0]!.itemKey).toMatch(/^L/); // served by the desktop app
  });

  it('pages the local API to the end (parity with the Web API pager)', async () => {
    const { ctx, local, search } = makeCtx({ localApi: true, cloudKey: false });
    startIndexBuild(ctx);
    await finished(search);
    // 250 items over 100-item pages: start=0, 100, 200 — then the total stops the loop.
    // The own-words census pages the same endpoint for notes and annotations, so the item
    // crawl is read off the calls that asked for top-level items.
    const itemPages = local.listItems.mock.calls.filter((c: any[]) => c[0].top);
    expect(itemPages.map((c: any[]) => c[0].start)).toEqual([0, 100, 200]);
    expect(search.buildStatus().itemsFetched).toBe(250);
    expect(search.buildStatus().itemsTotal).toBe(250);
  });

  it('builds from the cloud Web API when the desktop app is not running', async () => {
    const { ctx, web, local, search } = makeCtx({ localApi: false });
    startIndexBuild(ctx);
    await finished(search);
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.listItems).toHaveBeenCalled();
    expect(web.listItems.mock.calls[0]![0]).toEqual({ type: 'user', id: cloudInfo.userID });
    expect(web.listItems.mock.calls[0]![1]).toMatchObject({ limit: PAGE_SIZE, start: 0, top: true });
    expect(search.buildStatus().items).toBe(250);
    const hits = await search.query('abstract body', { limit: 1 });
    expect(hits[0]!.itemKey).toMatch(/^W/); // served by the cloud
  });

  it('builds a group the desktop does not hold from the cloud', async () => {
    const { ctx, web, local, search } = makeCtx({ localApi: true, localGroupIds: [] });
    startIndexBuild(ctx, { type: 'group', id: 999 });
    await finished(search);
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.listItems.mock.calls[0]![0]).toEqual({ type: 'group', id: 999 });
    expect(search.buildStatus().items).toBe(250);
  });

  it('builds a group the desktop does hold from the desktop, with no cloud key', async () => {
    const { ctx, web, local, search } = makeCtx({
      localApi: true,
      cloudKey: false,
      localGroupIds: [999],
    });
    startIndexBuild(ctx, { type: 'group', id: 999 });
    await finished(search);
    expect(web.listItems).not.toHaveBeenCalled();
    expect(local.listItems).toHaveBeenCalled();
    expect(local.listItems.mock.calls[0]![1]).toEqual({ type: 'group', id: 999 });
    expect(search.buildStatus().items).toBe(250);
  });

  it('honours the item cap regardless of the backend', async () => {
    const { ctx, local, search } = makeCtx({ localApi: true, cloudKey: false });
    startIndexBuild(ctx, undefined, 5);
    await finished(search);
    expect(search.buildStatus().items).toBe(5);
    // Counted over the top-level crawl alone: the own-words census pages the library's
    // notes and annotations beside it, and it is not what the cap governs.
    const itemPages = local.listItems.mock.calls.filter((c) => (c[0] as { top?: boolean })?.top);
    expect(itemPages).toHaveLength(1);
  });
});
