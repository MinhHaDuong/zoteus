import { describe, it, expect, vi } from 'vitest';
import { WebApiClient } from '../../src/api/web-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeClient(fetchImpl: any) {
  return new WebApiClient({ apiKey: 'KEY', fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) });
}

const lib = { type: 'user', id: 19552201 } as const;

describe('WebApiClient writes', () => {
  it('create batch sends a Zotero-Write-Token and parses successful', async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toHaveLength(1);
      return new Response(
        JSON.stringify({ successful: { '0': { key: 'NEW1', version: 5 } }, success: { '0': 'NEW1' } }),
        { status: 200, headers: { 'Last-Modified-Version': '5' } },
      );
    });
    const r = await makeClient(fetchImpl).writeItems(lib, [{ itemType: 'book', title: 'T' }]);
    expect(sentHeaders['Zotero-Write-Token']).toMatch(/^[0-9a-f]{32}$/);
    expect(sentHeaders['If-Unmodified-Since-Version']).toBeUndefined();
    expect(r.successful[0]).toEqual({ index: 0, key: 'NEW1', version: 5 });
    expect(r.newLibraryVersion).toBe(5);
  });

  it('all-update batch relies on per-object version (no token, no precondition header)', async () => {
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ failed: { '0': { key: 'K1', code: 412, message: 'conflict' } } }), {
        status: 200,
        headers: { 'Last-Modified-Version': '9' },
      });
    });
    const r = await makeClient(fetchImpl).writeItems(lib, [{ key: 'K1', version: 3, deleted: 1 }]);
    expect(sentHeaders['Zotero-Write-Token']).toBeUndefined();
    expect(sentHeaders['If-Unmodified-Since-Version']).toBeUndefined();
    expect(r.failed[0]).toMatchObject({ index: 0, code: 412 });
  });

  it('auto-chunks more than 50 objects into multiple POSTs with merged indices', async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      posts++;
      const body = JSON.parse(init.body as string) as any[];
      const successful: Record<string, any> = {};
      body.forEach((_, i) => (successful[String(i)] = { key: `K${posts}_${i}`, version: 1 }));
      return new Response(JSON.stringify({ successful }), {
        status: 200,
        headers: { 'Last-Modified-Version': '1' },
      });
    });
    const objects = Array.from({ length: 60 }, (_, i) => ({ itemType: 'book', title: `t${i}` }));
    const r = await makeClient(fetchImpl).writeItems(lib, objects);
    expect(posts).toBe(2);
    expect(r.successful).toHaveLength(60);
    expect(r.successful.map((s) => s.index)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('patchItem sends If-Unmodified-Since-Version and returns the new version', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('PATCH');
      expect(url).toContain('/users/19552201/items/ABCD');
      expect((init.headers as Record<string, string>)['If-Unmodified-Since-Version']).toBe('3');
      return new Response(null, { status: 204, headers: { 'Last-Modified-Version': '4' } });
    });
    const v = await makeClient(fetchImpl).patchItem(lib, 'ABCD', { title: 'New' }, 3);
    expect(v).toBe(4);
  });

  it('patchItem throws an actionable 412 on stale version', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('conflict', { status: 412, headers: { 'Last-Modified-Version': '9' } }),
    );
    await expect(makeClient(fetchImpl).patchItem(lib, 'ABCD', { title: 'x' }, 3)).rejects.toThrow(
      /changed on the server/i,
    );
  });

  it('deleteItems sends a comma itemKey list and the precondition header', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('DELETE');
      expect(url).toContain('itemKey=AAA,BBB');
      expect((init.headers as Record<string, string>)['If-Unmodified-Since-Version']).toBe('100');
      return new Response(null, { status: 204 });
    });
    await makeClient(fetchImpl).deleteItems(lib, ['AAA', 'BBB'], 100);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  // The router listens here so that reads of a library stop going to a desktop app that has
  // not synced the write yet. Reporting from the client rather than from each write tool is
  // the point: a tool that forgot would put the staleness back with nothing to catch it.
  it('reports every write to onWrite, with the keys it actually wrote', async () => {
    const seen: any[] = [];
    const client = makeClient(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ successful: { '0': { key: 'NEW1', version: 5 } } }), {
            status: 200,
            headers: { 'Last-Modified-Version': '5' },
          }),
      ),
    );
    client.onWrite = (l, type, keys, removed) => seen.push({ l, type, keys, removed });
    await client.writeItems(lib, [{ itemType: 'book', title: 'T' }]);
    await client.writeCollections(lib, [{ name: 'C' }]);
    await client.writeSearches(lib, [{ name: 'S', conditions: [] }]);
    expect(seen).toEqual([
      { l: lib, type: 'items', keys: ['NEW1'], removed: false },
      { l: lib, type: 'collections', keys: ['NEW1'], removed: false },
      { l: lib, type: 'searches', keys: ['NEW1'], removed: false },
    ]);
  });

  it('reports a patch, and reports a delete as a removal', async () => {
    const seen: any[] = [];
    const client = makeClient(vi.fn(async () => new Response(null, { status: 204, headers: { 'Last-Modified-Version': '4' } })));
    client.onWrite = (_l, type, keys, removed) => seen.push({ type, keys, removed });
    await client.patchItem(lib, 'ABCD', { title: 'New' }, 3);
    await client.deleteItems(lib, ['AAA', 'BBB'], 100);
    expect(seen).toEqual([
      { type: 'items', keys: ['ABCD'], removed: false },
      // A delete inverts what catching up means: the desktop is level once it has LOST them.
      { type: 'items', keys: ['AAA', 'BBB'], removed: true },
    ]);
  });

  it('reports nothing for a batch where every object failed', async () => {
    const seen: any[] = [];
    const client = makeClient(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ failed: { '0': { key: 'K1', code: 412, message: 'conflict' } } }), {
            status: 200,
            headers: { 'Last-Modified-Version': '9' },
          }),
      ),
    );
    client.onWrite = (...args) => seen.push(args);
    await client.writeItems(lib, [{ key: 'K1', version: 3, title: 'x' }]);
    expect(seen).toEqual([]);
  });

  it('does not fail a write because the observer threw', async () => {
    const client = makeClient(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ successful: { '0': { key: 'NEW1', version: 5 } } }), {
            status: 200,
            headers: { 'Last-Modified-Version': '5' },
          }),
      ),
    );
    client.onWrite = () => {
      throw new Error('bookkeeping blew up');
    };
    const r = await client.writeItems(lib, [{ itemType: 'book', title: 'T' }]);
    expect(r.successful[0].key).toBe('NEW1');
  });
});
