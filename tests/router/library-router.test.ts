import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };
/** What the router resolves an omitted library to; localLibraryPrefix maps it to /users/0. */
const defaultUserLib = { type: 'user' as const, id: cloudInfo.userID };

function makeRouter(opts: {
  local: 'auto' | 'on' | 'off';
  localApi: boolean;
  /** Groups this desktop app holds. Empty = pre-Zotero-10, or a group it does not have. */
  localGroupIds?: number[];
}) {
  const web = {
    listItems: vi.fn(async () => ({ data: [{ key: 'CLOUD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'CLOUD' })),
    getItemChildren: vi.fn(async () => ({ data: [{ key: 'CLOUDCHILD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getFullText: vi.fn(async () => ({ content: 'CLOUD TEXT' })),
    fullTextSince: vi.fn(async () => ({ CLOUDATT: 9 })),
  };
  const local = {
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'LOCAL' })),
    getItemChildren: vi.fn(async () => ({ data: [{ key: 'LOCALCHILD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getFullText: vi.fn(async () => ({ content: 'LOCAL TEXT' })),
    fullTextSince: vi.fn(async () => ({ LOCALATT: 4 })),
  };
  const cfg = loadConfig({ ZOTEUS_LOCAL: opts.local } as any);
  const router = new LibraryRouter({
    config: cfg,
    capabilities: {
      cloud: cloudInfo as any,
      localApi: opts.localApi,
      localGroupIds: opts.localGroupIds ?? [],
    },
    web: web as any,
    local: local as any,
  });
  return { router, web, local };
}

describe('LibraryRouter', () => {
  it('reads from the local API when available and not disabled', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    const r = await router.searchItems({ q: 'x' });
    expect(r.data[0].key).toBe('LOCAL');
    expect(local.listItems).toHaveBeenCalled();
    expect(web.listItems).not.toHaveBeenCalled();
  });

  it('falls back to the cloud when local is unavailable', async () => {
    const { router, web } = makeRouter({ local: 'auto', localApi: false });
    const r = await router.searchItems({ q: 'x' });
    expect(r.data[0].key).toBe('CLOUD');
    expect(web.listItems).toHaveBeenCalled();
  });

  it('always uses the cloud for an explicit group library', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    await router.searchItems({ q: 'x', library: { type: 'group', id: 999 } });
    expect(web.listItems).toHaveBeenCalled();
    expect(local.listItems).not.toHaveBeenCalled();
  });

  it('gets children from the local /children endpoint, not a parentItem-filtered list', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    const r = await router.getItemChildren('ABCD1234', { limit: 25 });
    expect(r.data[0].key).toBe('LOCALCHILD');
    expect(local.getItemChildren).toHaveBeenCalledWith('ABCD1234', { limit: 25 }, defaultUserLib);
    // The desktop local API ignores ?parentItem= and would return the whole library.
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.getItemChildren).not.toHaveBeenCalled();
  });

  it('gets children from the cloud for a group this desktop does not hold', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    const r = await router.getItemChildren('ABCD1234', { library: { type: 'group', id: 999 } });
    expect(r.data[0].key).toBe('CLOUDCHILD');
    expect(web.getItemChildren).toHaveBeenCalledWith({ type: 'group', id: 999 }, 'ABCD1234', {});
    expect(local.getItemChildren).not.toHaveBeenCalled();
  });

  it('gets children from the desktop for a group it does hold', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const lib = { type: 'group' as const, id: 999 };
    const r = await router.getItemChildren('ABCD1234', { library: lib });
    expect(r.data[0].key).toBe('LOCALCHILD');
    expect(local.getItemChildren).toHaveBeenCalledWith('ABCD1234', {}, lib);
    expect(web.getItemChildren).not.toHaveBeenCalled();
  });

  it('reads full text from the desktop app when it is running (no cloud key needed)', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    expect((await router.getFullText('ATT01'))?.content).toBe('LOCAL TEXT');
    expect(local.getFullText).toHaveBeenCalledWith('ATT01', defaultUserLib);
    expect(web.getFullText).not.toHaveBeenCalled();

    expect(await router.fullTextSince(0)).toEqual({ LOCALATT: 4 });
    expect(local.fullTextSince).toHaveBeenCalledWith(0, defaultUserLib);
  });

  it('falls back to the cloud for full text when the desktop app is closed', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: false });
    expect((await router.getFullText('ATT01'))?.content).toBe('CLOUD TEXT');
    expect(web.getFullText).toHaveBeenCalledWith({ type: 'user', id: cloudInfo.userID }, 'ATT01');
    expect(local.getFullText).not.toHaveBeenCalled();
  });

  it('keeps group full text on the cloud when this desktop does not hold the group', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    const lib = { type: 'group' as const, id: 999 };
    await router.getFullText('ATT01', { library: lib });
    await router.fullTextSince(12, { library: lib });
    expect(web.getFullText).toHaveBeenCalledWith(lib, 'ATT01');
    expect(web.fullTextSince).toHaveBeenCalledWith(lib, 12);
    expect(local.getFullText).not.toHaveBeenCalled();
    expect(local.fullTextSince).not.toHaveBeenCalled();
  });

  it('reads group full text from the desktop when it does hold the group', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const lib = { type: 'group' as const, id: 999 };
    expect((await router.getFullText('ATT01', { library: lib }))?.content).toBe('LOCAL TEXT');
    expect(await router.fullTextSince(12, { library: lib })).toEqual({ LOCALATT: 4 });
    expect(local.getFullText).toHaveBeenCalledWith('ATT01', lib);
    expect(local.fullTextSince).toHaveBeenCalledWith(12, lib);
    expect(web.getFullText).not.toHaveBeenCalled();
  });

  it('defaultLibrary uses the resolved cloud userID', () => {
    const { router } = makeRouter({ local: 'auto', localApi: true });
    expect(router.defaultLibrary()).toEqual({ type: 'user', id: 19552201 });
  });
});
