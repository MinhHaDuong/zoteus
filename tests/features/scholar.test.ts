import { describe, it, expect, vi } from 'vitest';
import { OpenAlexClient } from '../../src/features/scholar/openalex.js';
import { ScholarGraph, markInLibrary } from '../../src/features/scholar/graph.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function fetcher(fetchImpl: any) {
  return new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
}

const work = {
  id: 'https://openalex.org/W123',
  display_name: 'Deep Learning',
  doi: 'https://doi.org/10.1038/NATURE14539',
  publication_year: 2015,
  cited_by_count: 80000,
  authorships: [{ author: { display_name: 'Yann LeCun' } }],
  referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
  related_works: ['https://openalex.org/W9'],
  primary_location: { source: { display_name: 'Nature' } },
};

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('OpenAlexClient', () => {
  it('normalizes a work and strips DOI/id prefixes', () => {
    const c = new OpenAlexClient(fetcher(vi.fn()));
    const n = c.normalize(work);
    expect(n.title).toBe('Deep Learning');
    expect(n.doi).toBe('10.1038/NATURE14539');
    expect(n.openalexId).toBe('W123');
    expect(n.authors).toContain('Yann LeCun');
    expect(n.venue).toBe('Nature');
  });

  it('resolves works by id with the OR filter', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('filter=openalex_id:W1|W2');
      return new Response(JSON.stringify({ results: [work] }), { status: 200 });
    });
    const out = await new OpenAlexClient(fetcher(fetchImpl)).worksByIds(['https://openalex.org/W1', 'W2']);
    expect(out[0].title).toBe('Deep Learning');
  });

  // OpenAlex replaced the polite pool with API keys before February 2026 and ignores
  // `mailto=` (#76). The key travels as a bearer header, never in a URL an error would quote.
  it('sends the API key as a bearer header and keeps both key and mailto out of the URL', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain('mailto=');
      expect(url).not.toContain('api_key');
      expect(url).not.toContain('sekret');
      expect(headerOf(init, 'authorization')).toBe('Bearer sekret');
      expect(headerOf(init, 'user-agent')).toBe('zoteus (mailto:me@example.com)');
      return new Response(JSON.stringify(work), { status: 200 });
    });
    const c = new OpenAlexClient(fetcher(fetchImpl), { apiKey: 'sekret', contact: 'me@example.com' });
    await c.work('10.1038/nature14539');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends no Authorization header without a key, and still works', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(headerOf(init, 'authorization')).toBeNull();
      expect(headerOf(init, 'user-agent')).toBe('zoteus');
      return new Response(JSON.stringify(work), { status: 200 });
    });
    await new OpenAlexClient(fetcher(fetchImpl)).work('W123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not leak the key when a request fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 429 }));
    const c = new OpenAlexClient(fetcher(fetchImpl), { apiKey: 'sekret' });
    await expect(c.work('W123')).rejects.toThrow(/OpenAlex 429/);
    await expect(c.work('W123')).rejects.not.toThrow(/sekret/);
  });
});

describe('ScholarGraph', () => {
  const okFetch = vi.fn(async (url: string) => {
    if (url.includes('/works/doi:')) return new Response(JSON.stringify(work), { status: 200 });
    return new Response(JSON.stringify({ results: [work] }), { status: 200 });
  });

  it('returns references resolved from referenced_works with the full count', async () => {
    const g = new ScholarGraph({ fetcher: fetcher(okFetch) });
    const refs = await g.references('10.1038/nature14539', 10);
    expect(refs.works.length).toBeGreaterThan(0);
    expect(refs.total).toBe(2);
  });

  // A review with 150 references answered `limit` works and nothing else; the count the
  // list was cut from now rides along (#76).
  it('reports the untruncated total when limit cuts the list', async () => {
    const g = new ScholarGraph({ fetcher: fetcher(okFetch) });
    const refs = await g.references('10.1038/nature14539', 1);
    expect(refs.total).toBe(2);
    const rel = await g.related('10.1038/nature14539', 5);
    expect(rel.total).toBe(1);
  });

  it('uses cited_by_count as the total for citations', async () => {
    const g = new ScholarGraph({ fetcher: fetcher(okFetch) });
    const cites = await g.citations('10.1038/nature14539', 5);
    expect(cites.works.length).toBe(1);
    expect(cites.total).toBe(80000);
  });

  it('passes the OpenAlex key through and keeps mailto for Crossref only', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: headerOf(init, 'authorization') });
      if (url.includes('openalex.org')) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ message: { title: ['Crossref Title'], DOI: '10.1/x', author: [] } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl), mailto: 'me@example.com', openalexApiKey: 'sekret' });
    const r = await g.lookup('10.1/x');
    expect(r?.title).toBe('Crossref Title');
    const openalex = seen.find((s) => s.url.includes('openalex.org'))!;
    const crossref = seen.find((s) => s.url.includes('crossref.org'))!;
    expect(openalex.auth).toBe('Bearer sekret');
    expect(openalex.url).not.toContain('mailto=');
    expect(crossref.auth).toBeNull();
    expect(crossref.url).toContain('mailto=me%40example.com');
  });

  it('falls back to Crossref when OpenAlex lookup throws', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('openalex.org')) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ message: { title: ['Crossref Title'], DOI: '10.1/x', author: [] } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    const r = await g.lookup('10.1/x');
    expect(r?.title).toBe('Crossref Title');
  });
});

describe('markInLibrary', () => {
  it('flags works whose DOI is in the library set (case-insensitive)', () => {
    const set = new Set(['10.1038/nature14539']);
    const marked = markInLibrary([{ doi: '10.1038/NATURE14539', authors: [] }, { doi: '10.9/zzz', authors: [] }], set);
    expect(marked[0].inLibrary).toBe(true);
    expect(marked[1].inLibrary).toBe(false);
  });
});
