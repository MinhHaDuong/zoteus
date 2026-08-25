import { describe, it, expect, vi } from 'vitest';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeLocal(fetchImpl: any, port = 23119) {
  return new LocalApiClient({ port, fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) });
}

describe('LocalApiClient', () => {
  it('ping returns true when the local API responds', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('http://127.0.0.1:23119/api/users/0/items');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0' } });
    });
    expect(await makeLocal(fetchImpl).ping()).toBe(true);
  });

  it('ping returns false on connection error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await makeLocal(fetchImpl).ping()).toBe(false);
  });

  it('lists items against users/0', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items');
      expect(url).toContain('limit=5');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '10' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ limit: 5 });
    expect(r.data).toHaveLength(1);
    expect(r.totalResults).toBe(1);
  });

  it('requests top-level items from /items/top for index builds', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items/top');
      expect(url).toContain('limit=100');
      expect(url).toContain('start=100');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '250', 'Last-Modified-Version': '13' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ top: true, limit: 100, start: 100 });
    expect(r.totalResults).toBe(250); // pagers need the library-wide total, not the page size
  });

  it('falls back to the page length when Total-Results is missing (never 0)', async () => {
    // Number(null) is 0 and finite — a naive parse would report totalResults: 0 and stop
    // a paging caller (the search-index build) dead after its first page.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ key: 'A' }, { key: 'B' }]), { status: 200 }));
    const r = await makeLocal(fetchImpl).listItems({ limit: 2 });
    expect(r.totalResults).toBe(2);
    expect(r.lastModifiedVersion).toBe(0);
  });

  it('scopes listItems by collection via the path segment, not a query param', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/collections/ABC/items');
      expect(url).not.toContain('collectionKey=');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '10' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ collectionKey: 'ABC' });
    expect(r.data).toHaveLength(1);
  });

  it('fetches children via /items/<key>/children, never a parentItem filter', async () => {
    // The desktop local API ignores ?parentItem= and answers with the whole library.
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items/ABCD1234/children');
      expect(url).not.toContain('parentItem');
      return new Response(JSON.stringify([{ key: 'CHILD' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '7' },
      });
    });
    const r = await makeLocal(fetchImpl).getItemChildren('ABCD1234');
    expect(r.data).toEqual([{ key: 'CHILD' }]);
    expect(r.totalResults).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes item filters through to the children endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items/ABCD1234/children');
      expect(url).toContain('itemType=annotation');
      expect(url).toContain('limit=100');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0' } });
    });
    await makeLocal(fetchImpl).getItemChildren('ABCD1234', { itemType: 'annotation', limit: 100 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads an attachment full text from the local /fulltext endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:23119/api/users/0/items/ATT01/fulltext');
      return new Response(JSON.stringify({ content: 'body text', indexedPages: 7, totalPages: 7 }), { status: 200 });
    });
    const ft = await makeLocal(fetchImpl).getFullText('ATT01');
    expect(ft.content).toBe('body text');
    expect(ft.totalPages).toBe(7);
  });

  it('returns null (not an error) for an attachment the app has no text for', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not found', { status: 404 }));
    expect(await makeLocal(fetchImpl).getFullText('ATT01')).toBeNull();
  });

  it('still throws when the local API is unreachable, so a build reports it', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(makeLocal(fetchImpl).getFullText('ATT01')).rejects.toThrow(/500/);
  });

  it('lists full-text changes since a version', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/fulltext');
      expect(url).toContain('since=0');
      return new Response(JSON.stringify({ ATT01: 676, ATT02: 705 }), { status: 200 });
    });
    expect(await makeLocal(fetchImpl).fullTextSince(0)).toEqual({ ATT01: 676, ATT02: 705 });
  });

  it('reads a group library from /groups/<id>, never users/0', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/groups/4321/items');
      expect(url).not.toContain('/users/0');
      expect(url).toContain('limit=5');
      return new Response(JSON.stringify([{ key: 'G1' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '3' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ limit: 5 }, { type: 'group', id: 4321 });
    expect(r.data).toEqual([{ key: 'G1' }]);
  });

  it('addresses every other group read under the same /groups/<id> prefix', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      const body = url.includes('/items/ATT01/fulltext') ? { content: 'group text' } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Total-Results': '0' } });
    });
    const c = makeLocal(fetchImpl);
    const lib = { type: 'group' as const, id: 4321 };
    await c.getItemChildren('ABCD1234', {}, lib);
    const ft = await c.getFullText('ATT01', lib);
    await c.fullTextSince(7, lib);
    await c.listCollections({}, lib);
    expect(ft.content).toBe('group text');
    expect(seen).toEqual([
      'http://127.0.0.1:23119/api/groups/4321/items/ABCD1234/children',
      'http://127.0.0.1:23119/api/groups/4321/items/ATT01/fulltext',
      'http://127.0.0.1:23119/api/groups/4321/fulltext?since=7',
      'http://127.0.0.1:23119/api/groups/4321/collections',
    ]);
  });
});

describe('LocalApiClient.listLocalGroupIds', () => {
  it('parses the flat group shape', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/groups');
      expect(url).toContain('limit=100');
      return new Response(JSON.stringify([{ id: 4321 }, { id: 8765 }]), {
        status: 200,
        headers: { 'Total-Results': '2' },
      });
    });
    const ids = await makeLocal(fetchImpl).listLocalGroupIds();
    expect(ids).toEqual([4321, 8765]);
    expect(ids.every((n) => typeof n === 'number')).toBe(true);
  });

  it('parses the data-wrapped group shape, whose ids would otherwise all be NaN', async () => {
    // Zotero group JSON is commonly `{ data: { id } }`; reading only `g.id` there yields
    // NaN for every group, so nothing is ever recognised as locally held.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ data: { id: 4321, name: 'Lab' } }, { data: { id: 8765 } }]), {
          status: 200,
          headers: { 'Total-Results': '2' },
        }),
    );
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toEqual([4321, 8765]);
  });

  it('coerces ids to numbers and drops entries that carry none', async () => {
    // The router compares against LibraryRef.id, a number, so '4321' must not stay a string.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: '4321' }, { data: { id: '8765' } }, { name: 'no id' }]), {
          status: 200,
          headers: { 'Total-Results': '3' },
        }),
    );
    const ids = await makeLocal(fetchImpl).listLocalGroupIds();
    expect(ids).toEqual([4321, 8765]);
    expect(ids.every((n) => typeof n === 'number')).toBe(true);
  });

  it('returns [] when the app is unreachable, so group reads stay on the cloud', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toEqual([]);
  });

  it('returns [] when the endpoint is absent (pre-Zotero-10)', async () => {
    const fetchImpl = vi.fn(async () => new Response('No endpoint found', { status: 404 }));
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toEqual([]);
  });

  it('pages past the first 100 groups instead of truncating', async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({ data: { id: 1000 + i } }));
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const start = Number(new URL(url).searchParams.get('start'));
      starts.push(start);
      return new Response(JSON.stringify(all.slice(start, start + 100)), {
        status: 200,
        headers: { 'Total-Results': '150' },
      });
    });
    const ids = await makeLocal(fetchImpl).listLocalGroupIds();
    expect(starts).toEqual([0, 100]);
    expect(ids).toHaveLength(150);
    expect(ids[149]).toBe(1149);
  });

  it('reads the item key census from the desktop app, per library', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('http://127.0.0.1:23119/api/groups/999/items/top');
      expect(url).toContain('format=versions');
      expect(url).toContain('since=13');
      return new Response(JSON.stringify({ AAAA: 13 }), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '14' },
      });
    });
    const r = await makeLocal(fetchImpl).itemVersions({ top: true, since: 13 }, { type: 'group', id: 999 });
    expect(r.versions).toEqual({ AAAA: 13 });
    // The desktop keeps its own sequence, far behind the cloud's; nothing here compares them.
    expect(r.lastModifiedVersion).toBe(14);
  });

  it('keeps the pages it already read when a later one fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('start=100')) throw new Error('ECONNRESET');
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))), {
        status: 200,
        headers: { 'Total-Results': '150' },
      });
    });
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toHaveLength(100);
  });
});
