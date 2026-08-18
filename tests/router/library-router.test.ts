import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

function makeRouter(opts: { local: 'auto' | 'on' | 'off'; localApi: boolean }) {
  const web = {
    listItems: vi.fn(async () => ({ data: [{ key: 'CLOUD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'CLOUD' })),
    getItemChildren: vi.fn(async () => ({ data: [{ key: 'CLOUDCHILD' }], totalResults: 1, lastModifiedVersion: 1 })),
  };
  const local = {
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'LOCAL' })),
    getItemChildren: vi.fn(async () => ({ data: [{ key: 'LOCALCHILD' }], totalResults: 1, lastModifiedVersion: 1 })),
  };
  const cfg = loadConfig({ ZOTEUS_LOCAL: opts.local } as any);
  const router = new LibraryRouter({
    config: cfg,
    capabilities: { cloud: cloudInfo as any, localApi: opts.localApi },
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
    expect(local.getItemChildren).toHaveBeenCalledWith('ABCD1234', { limit: 25 });
    // The desktop local API ignores ?parentItem= and would return the whole library.
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.getItemChildren).not.toHaveBeenCalled();
  });

  it('gets children from the cloud children endpoint for a group library', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    const r = await router.getItemChildren('ABCD1234', { library: { type: 'group', id: 999 } });
    expect(r.data[0].key).toBe('CLOUDCHILD');
    expect(web.getItemChildren).toHaveBeenCalledWith({ type: 'group', id: 999 }, 'ABCD1234', {});
    expect(local.getItemChildren).not.toHaveBeenCalled();
  });

  it('defaultLibrary uses the resolved cloud userID', () => {
    const { router } = makeRouter({ local: 'auto', localApi: true });
    expect(router.defaultLibrary()).toEqual({ type: 'user', id: 19552201 });
  });
});
