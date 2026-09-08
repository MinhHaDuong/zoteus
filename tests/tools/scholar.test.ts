import { describe, it, expect, vi } from 'vitest';
import scholar from '../../src/tools/scholar.js';

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
