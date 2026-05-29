import { describe, it, expect, vi } from 'vitest';
import { WebApiClient } from '../../src/api/web-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeClient(fetchImpl: any) {
  return new WebApiClient({ apiKey: 'KEY', fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) });
}
const lib = { type: 'user', id: 19552201 } as const;

describe('WebApiClient files/sync/groups/export', () => {
  it('lists groups', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/groups');
      return new Response(JSON.stringify([{ id: 5, data: { name: 'Lab' } }]), {
        status: 200,
        headers: { 'Total-Results': '1' },
      });
    });
    const r = await makeClient(fetchImpl).listGroups(19552201);
    expect(r.data[0].data.name).toBe('Lab');
  });

  it('exportItems sends format + limit and returns raw text', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('format=bibtex');
      expect(url).toContain('limit=10');
      return new Response('@article{key, title={X}}', { status: 200 });
    });
    const text = await makeClient(fetchImpl).exportItems(lib, { format: 'bibtex', limit: 10 });
    expect(text).toContain('@article');
  });

  it('getFullText returns null on 404', async () => {
    const fetchImpl = vi.fn(async () => new Response('none', { status: 404 }));
    expect(await makeClient(fetchImpl).getFullText(lib, 'ABCD')).toBeNull();
  });

  it('getFullText returns content when present', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ content: 'hello', indexedChars: 5, totalChars: 5 }), { status: 200 }));
    const ft = await makeClient(fetchImpl).getFullText(lib, 'ABCD');
    expect(ft.content).toBe('hello');
  });

  it('versions sends format=versions and since', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/items');
      expect(url).toContain('format=versions');
      expect(url).toContain('since=2000');
      return new Response(JSON.stringify({ AAA: 2114, BBB: 2113 }), { status: 200 });
    });
    const map = await makeClient(fetchImpl).versions(lib, 'items', 2000);
    expect(Object.keys(map)).toHaveLength(2);
  });

  it('deleted hits /deleted with since', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/deleted');
      expect(url).toContain('since=10');
      return new Response(JSON.stringify({ items: ['X'], collections: [] }), { status: 200 });
    });
    const d = await makeClient(fetchImpl).deleted(lib, 10);
    expect(d.items).toEqual(['X']);
  });
});
