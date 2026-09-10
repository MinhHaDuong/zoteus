import { describe, it, expect, vi } from 'vitest';
import scholar from '../../src/tools/scholar.js';
import { OpenAlexError } from '../../src/features/scholar/openalex.js';

function ctx(overrides: Record<string, unknown> = {}) {
  const work = {
    doi: '10.1109/ICRA.2019.8794293',
    title: 'Sample Work',
    citationCount: 12,
  };
  return {
    scholar: {
      lookup: vi.fn(async () => work),
      references: vi.fn(async () => ({ works: [], total: 0 })),
      citations: vi.fn(async () => ({ works: [], total: 0 })),
      related: vi.fn(async () => ({ works: [work], total: 1 })),
    },
    capabilities: { cloud: { userID: 19552201 }, localApi: false },
    router: {
      // Counts how many pages the handler pulls from the library.
      searchItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
    ...overrides,
  } as any;
}

describe('zotero_scholar', () => {
  it('does not scan the library by default (include_in_library is opt-in)', async () => {
    const c = ctx();
    const res = await scholar.handler({ action: 'related', doi: '10.1109/ICRA.2019.8794293' }, c);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as any).inLibrary).toBeUndefined();
    // The full-library pagination must NOT have been touched.
    expect(c.router.searchItems).not.toHaveBeenCalled();
  });

  it('scans the library and flags results only when include_in_library is true', async () => {
    const c = ctx();
    const res = await scholar.handler(
      { action: 'related', doi: '10.1109/ICRA.2019.8794293', include_in_library: true },
      c,
    );
    expect(res.isError).toBeFalsy();
    expect(c.router.searchItems).toHaveBeenCalled();
    expect((res.structuredContent as any).inLibrary).toBe(0);
  });

  it('reports no scholarly record as an error for lookup', async () => {
    const c = ctx({
      scholar: { lookup: vi.fn(async () => null), references: vi.fn(), citations: vi.fn(), related: vi.fn() },
    });
    const res = await scholar.handler({ action: 'lookup', doi: '10.9999/nonexistent' }, c);
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any)?.text).toMatch(/No scholarly record/);
  });
});

// A review with 150 references used to come back as twenty works and nothing else (#76).
describe('zotero_scholar says when a list was cut', () => {
  const work = { doi: '10.1/ref', title: 'One reference', authors: [] };

  it('carries total and truncated, and the summary says N of M', async () => {
    const c = ctx({
      scholar: {
        lookup: vi.fn(),
        references: vi.fn(async () => ({ works: [work], total: 150 })),
        citations: vi.fn(),
        related: vi.fn(),
      },
    });
    const res = await scholar.handler({ action: 'references', doi: '10.1038/nature14539', limit: 1 }, c);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.count).toBe(1);
    expect(sc.total).toBe(150);
    expect(sc.truncated).toBe(true);
    expect((res.content?.[0] as any)?.text).toMatch(/1 of 150 references/);
  });

  it('is not truncated when the whole list fits, and says so plainly', async () => {
    const c = ctx({
      scholar: {
        lookup: vi.fn(),
        references: vi.fn(),
        citations: vi.fn(async () => ({ works: [work, work], total: 2 })),
        related: vi.fn(),
      },
    });
    const res = await scholar.handler({ action: 'citations', doi: '10.1038/nature14539' }, c);
    const sc = res.structuredContent as any;
    expect(sc.total).toBe(2);
    expect(sc.truncated).toBe(false);
    expect((res.content?.[0] as any)?.text).toMatch(/^2 citations for/);
  });
});

// An empty DOI used to reach the providers, where OpenAlex 404s on `works/` and Crossref
// answers its works-LIST route 200; the list envelope then read as a found paper with no
// title, no authors and no citations.
describe('zotero_scholar refuses an empty DOI instead of inventing a result', () => {
  for (const doi of ['', '   ', '\t\n']) {
    it(`refuses ${JSON.stringify(doi)} without asking any provider`, async () => {
      const c = ctx();
      const res = await scholar.handler({ action: 'lookup', doi }, c);
      expect(res.isError).toBe(true);
      expect((res.content?.[0] as any)?.text).toMatch(/DOI is required/i);
      expect(c.scholar.lookup).not.toHaveBeenCalled();
    });
  }

  it('refuses an empty DOI for the list actions too', async () => {
    const c = ctx();
    const res = await scholar.handler({ action: 'references', doi: '' }, c);
    expect(res.isError).toBe(true);
    expect(c.scholar.references).not.toHaveBeenCalled();
  });

  it('trims a padded DOI rather than refusing it', async () => {
    const c = ctx();
    const res = await scholar.handler({ action: 'lookup', doi: '  10.1109/ICRA.2019.8794293 ' }, c);
    expect(res.isError).toBeFalsy();
    expect(c.scholar.lookup).toHaveBeenCalledWith('10.1109/ICRA.2019.8794293');
  });
});

// references/citations/related reach OpenAlex directly, and used to answer with the raw
// "OpenAlex 404 for https://api.openalex.org/works/doi:..." where lookup says "No
// scholarly record found for DOI ...".
describe('zotero_scholar reports an upstream failure in one clean voice', () => {
  function failing(e: unknown) {
    return ctx({
      scholar: {
        lookup: vi.fn(),
        references: vi.fn(async () => {
          throw e;
        }),
        citations: vi.fn(),
        related: vi.fn(),
      },
    });
  }

  it('turns a 404 into the same sentence lookup gives, with no URL', async () => {
    const e = new OpenAlexError(404, 'OpenAlex 404 for https://api.openalex.org/works/doi:10.9/zzz');
    const res = await scholar.handler({ action: 'references', doi: '10.9/zzz' }, failing(e));
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as any)?.text as string;
    expect(text).toBe('No scholarly record found for DOI 10.9/zzz.');
    expect(text).not.toContain('http');
  });

  // A throttled or broken provider is not evidence that the paper does not exist.
  it('does not report a 429 as an absent record', async () => {
    const e = new OpenAlexError(429, 'OpenAlex 429 for https://api.openalex.org/works/doi:10.9/zzz');
    const res = await scholar.handler({ action: 'references', doi: '10.9/zzz' }, failing(e));
    expect(res.isError).toBe(true);
    const text = (res.content?.[0] as any)?.text as string;
    expect(text).toMatch(/429/);
    expect(text).not.toMatch(/No scholarly record/);
    expect(text).not.toContain('http');
  });

  it('lets anything that is not an OpenAlex status through unchanged', async () => {
    const c = failing(new Error('Zotero took longer than the 25s budget'));
    await expect(scholar.handler({ action: 'references', doi: '10.9/zzz' }, c)).rejects.toThrow(/budget/);
  });
});
