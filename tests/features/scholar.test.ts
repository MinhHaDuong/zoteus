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

describe('OpenAlexClient', () => {
  it('normalizes a work and strips DOI/id prefixes', () => {
    const c = new OpenAlexClient(fetcher(vi.fn()), 'me@example.com');
    const n = c.normalize(work);
    expect(n.title).toBe('Deep Learning');
    expect(n.doi).toBe('10.1038/NATURE14539');
    expect(n.openalexId).toBe('W123');
    expect(n.authors).toContain('Yann LeCun');
    expect(n.venue).toBe('Nature');
  });

  it('resolves works by id with the OR filter and mailto', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('filter=openalex_id:W1|W2');
      expect(url).toContain('mailto=');
      return new Response(JSON.stringify({ results: [work] }), { status: 200 });
    });
    const out = await new OpenAlexClient(fetcher(fetchImpl), 'me@example.com').worksByIds([
      'https://openalex.org/W1',
      'W2',
    ]);
    expect(out[0].title).toBe('Deep Learning');
  });
});

describe('ScholarGraph', () => {
  it('returns references resolved from referenced_works', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/works/doi:')) return new Response(JSON.stringify(work), { status: 200 });
      return new Response(JSON.stringify({ results: [work] }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    const refs = await g.references('10.1038/nature14539', 10);
    expect(refs.length).toBeGreaterThan(0);
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
