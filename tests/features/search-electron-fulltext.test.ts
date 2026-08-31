import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import {
  ELECTRON_FULLTEXT_OVERRIDE,
  electronFulltextRefusal,
  electronVersion,
} from '../../src/features/search/electron.js';
import { startIndexBuild, startIndexUpdate, PAGE_SIZE } from '../../src/features/search/build.js';
import indexTool from '../../src/tools/index-tool.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Electron's marker on this process, for the duration of one test. `process.versions` is a
 * writable object on every Node this suite runs on, and the gate reads the marker straight
 * off it, so this is what makes the refusal reachable from a runtime that is not Electron.
 */
function pretendElectron(version = '42.10.0'): void {
  (process.versions as Record<string, string | undefined>).electron = version;
}

afterEach(() => {
  delete (process.versions as Record<string, string | undefined>).electron;
});

function makeCtx(env: Record<string, string> = {}) {
  const items = Array.from({ length: 3 }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));
  const fullTextSince = vi.fn(async () => ({ ATT1: 7 }));
  const getFullText = vi.fn(async () => ({ content: 'body text' }));
  const searchItems = vi.fn(async (q: any) => {
    const start = q.start ?? 0;
    const source = q.top ? items : [{ key: 'ATT1', data: { key: 'ATT1', itemType: 'attachment', parentItem: 'K1' } }];
    return { data: source.slice(start, start + (q.limit ?? PAGE_SIZE)), totalResults: source.length, lastModifiedVersion: 4 };
  });
  const ctx: any = {
    config: loadConfig(env as any),
    router: {
      fullTextSince,
      getFullText,
      searchItems,
      itemVersions: vi.fn(async () => ({ versions: { K0: 1, K1: 1, K2: 1 }, totalResults: 3 })),
      servesLocally: () => false,
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    search: new MemorySearchIndex({ embedder: null, logger: silentLogger }),
    logger: silentLogger,
    searchIndexPath: '',
  };
  return { ctx, fullTextSince, getFullText, searchItems };
}

async function finished(search: MemorySearchIndex): Promise<void> {
  for (let i = 0; i < 1000 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('electronFulltextRefusal', () => {
  const allowed = { allowElectronFulltext: true };
  const blocked = { allowElectronFulltext: false };

  it('permits the full-text pass on a standalone Node', () => {
    expect(electronVersion({})).toBeUndefined();
    expect(electronFulltextRefusal(blocked, {})).toBeUndefined();
    // An empty marker is not a version: a host that substitutes a blank string must not be
    // read as "this is Electron".
    expect(electronFulltextRefusal(blocked, { electron: '  ' })).toBeUndefined();
  });

  it('refuses under Electron, naming the version, the workaround and the override', () => {
    const reason = electronFulltextRefusal(blocked, { electron: '42.10.0' })!;
    expect(reason).toContain('42.10.0');
    expect(reason).toContain(ELECTRON_FULLTEXT_OVERRIDE);
    // The two things a desktop user has to be told: the index is untouched, and an update
    // is the call that still works from in here.
    expect(reason).toMatch(/action:"update"/);
    expect(reason).toMatch(/exactly as it was/);
  });

  it('stands aside when the user has opted in', () => {
    expect(electronFulltextRefusal(allowed, { electron: '42.10.0' })).toBeUndefined();
  });
});

describe('startIndexBuild under Electron', () => {
  it('refuses a full-text build before it touches the index', () => {
    pretendElectron();
    const { ctx, fullTextSince, searchItems } = makeCtx();
    expect(() => startIndexBuild(ctx, undefined, undefined, { fulltext: true })).toThrow(/Electron 42\.10\.0/);
    // Nothing started: no crawl, no state change, and the store is as it was. A refusal
    // that had already cleared the index would be worse than the crash it replaces.
    expect(searchItems).not.toHaveBeenCalled();
    expect(fullTextSince).not.toHaveBeenCalled();
    expect(ctx.search.buildStatus().state).toBe('idle');
    expect(ctx.search.isBuilding).toBe(false);
  });

  it('refuses when ZOTEUS_INDEX_FULLTEXT is what asked for the pass', () => {
    pretendElectron();
    const { ctx } = makeCtx({ ZOTEUS_INDEX_FULLTEXT: 'true' });
    expect(() => startIndexBuild(ctx)).toThrow(new RegExp(ELECTRON_FULLTEXT_OVERRIDE));
  });

  it('still builds the metadata index, which is the pass that works there', async () => {
    pretendElectron();
    const { ctx, fullTextSince } = makeCtx();
    startIndexBuild(ctx, undefined, undefined, { fulltext: false });
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(3);
    expect(s.fulltextEnabled).toBe(false);
    expect(fullTextSince).not.toHaveBeenCalled();
  });

  it('runs the full-text pass anyway once the override is set', async () => {
    pretendElectron();
    const { ctx, fullTextSince } = makeCtx({ ZOTEUS_ALLOW_ELECTRON_FULLTEXT: 'true' });
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextEnabled).toBe(true);
    expect(fullTextSince).toHaveBeenCalled();
  });

  it('refuses the rebuild an update falls back to, rather than crashing inside it', () => {
    pretendElectron();
    const { ctx } = makeCtx();
    // No version stamp on a fresh index, so an update cannot run a delta and would
    // otherwise start exactly the full-text build this gate exists to stop.
    expect(() => startIndexUpdate(ctx, undefined, undefined, { fulltext: true })).toThrow(/Electron/);
    expect(ctx.search.buildStatus().state).toBe('idle');
  });

  it('leaves an update itself alone: it never enters the long full-text pass', async () => {
    pretendElectron();
    const { ctx } = makeCtx();
    // Give the index a stamp so the update runs as a delta rather than falling back.
    startIndexBuild(ctx, undefined, undefined, { fulltext: false });
    await finished(ctx.search);
    expect(ctx.search.buildStatus().libraryVersion).toBe(4);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await finished(ctx.search);
    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.operation).toBe('update');
  });
});

describe('zotero_index under Electron', () => {
  it('hands the refusal back through the tool, having started nothing', async () => {
    pretendElectron();
    const { ctx, searchItems } = makeCtx();
    // The handler throws, and the registry turns a thrown handler into an isError result
    // carrying the message (see registerTools); the same route assertLibrary's refusal takes.
    await expect(indexTool.handler({ action: 'build', fulltext: true }, ctx)).rejects.toThrow(
      new RegExp(ELECTRON_FULLTEXT_OVERRIDE),
    );
    expect(searchItems).not.toHaveBeenCalled();
    expect(ctx.search.buildStatus().state).toBe('idle');
  });

  it('leaves a metadata build through the tool untouched', async () => {
    pretendElectron();
    const { ctx } = makeCtx();
    const res: any = await indexTool.handler({ action: 'build', fulltext: false }, ctx);
    expect(res.isError).toBeUndefined();
    await finished(ctx.search);
    expect(ctx.search.buildStatus().items).toBe(3);
  });
});
