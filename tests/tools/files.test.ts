import { describe, it, expect, vi } from 'vitest';
import groups from '../../src/tools/groups.js';
import exportTool from '../../src/tools/export.js';
import fulltext from '../../src/tools/fulltext.js';
import sync from '../../src/tools/sync.js';

function makeCtx(overrides: any = {}): any {
  const ctx: any = {
    config: { dataDir: '/tmp/zoteus' },
    capabilities: { cloud: { userID: 19552201 }, localApi: false },
    router: {
      whoami: () => ({ userID: 19552201 }),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
    web: {
      listGroups: vi.fn(async () => ({ data: [{ id: 7, data: { name: 'Lab', type: 'PublicOpen' }, meta: { numItems: 3 } }], totalResults: 1, lastModifiedVersion: 1 })),
      exportItems: vi.fn(async () => '@article{k, title={X}}'),
      getFullText: vi.fn(async () => ({ content: 'hello text', indexedChars: 10, totalChars: 10 })),
      fullTextSince: vi.fn(async () => ({ AAA: 5 })),
      versions: vi.fn(async (_lib: any, type: string) => (type === 'items' ? { I1: 2, I2: 3 } : {})),
      deleted: vi.fn(async () => ({ items: ['DEL1'] })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
  // Full-text reads are routed now (desktop app first, cloud otherwise). With no local API
  // in these doubles, that is the cloud path; resolve `web` at call time because tests
  // replace individual methods after construction.
  ctx.router.getFullText ??= (key: string, opts: any = {}) =>
    ctx.web.getFullText(opts.library ?? ctx.router.defaultLibrary(), key);
  ctx.router.fullTextSince ??= (version: number, opts: any = {}) =>
    ctx.web.fullTextSince(opts.library ?? ctx.router.defaultLibrary(), version);
  return ctx;
}

describe('zotero_groups', () => {
  it('lists groups', async () => {
    const res = await groups.handler({}, makeCtx());
    expect((res.structuredContent?.groups as any[])[0].name).toBe('Lab');
  });
  it('errors without a cloud key', async () => {
    const ctx = makeCtx();
    ctx.router.whoami = () => null;
    const res = await groups.handler({}, ctx);
    expect(res.isError).toBe(true);
  });
});

describe('zotero_export', () => {
  it('returns the exported text', async () => {
    const ctx = makeCtx();
    const res = await exportTool.handler({ format: 'bibtex', limit: 5 }, ctx);
    expect(ctx.web.exportItems).toHaveBeenCalledWith(
      { type: 'user', id: 19552201 },
      expect.objectContaining({ format: 'bibtex', limit: 5 }),
    );
    expect(res.content[0].text).toContain('@article');
  });
});

describe('zotero_fulltext', () => {
  it('get returns content', async () => {
    const res = await fulltext.handler({ action: 'get', item_key: 'A' }, makeCtx());
    expect(res.structuredContent?.found).toBe(true);
    expect(res.structuredContent?.content).toBe('hello text');
  });
  it('get returns found:false when none', async () => {
    const ctx = makeCtx();
    ctx.web.getFullText = vi.fn(async () => null);
    const res = await fulltext.handler({ action: 'get', item_key: 'A' }, ctx);
    expect(res.structuredContent?.found).toBe(false);
  });
  it('since returns the changed map', async () => {
    const res = await fulltext.handler({ action: 'since', since: 1 }, makeCtx());
    expect(res.structuredContent?.count).toBe(1);
  });
});

describe('zotero_sync', () => {
  it('returns changed maps and the deletion log', async () => {
    const res = await sync.handler({ since: 100 }, makeCtx());
    const changed = res.structuredContent?.changed as any;
    expect(changed.items.count).toBe(2);
    expect((res.structuredContent?.deleted as any).items).toEqual(['DEL1']);
  });
});
