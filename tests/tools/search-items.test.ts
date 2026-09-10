import { describe, it, expect, vi } from 'vitest';
import searchItems from '../../src/tools/search-items.js';

function ctx(searchImpl: any) {
  return {
    router: { searchItems: searchImpl, defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
  } as any;
}

const sampleItem = {
  key: 'ABCD1234',
  version: 2114,
  data: {
    itemType: 'journalArticle',
    title: 'Deep Learning',
    date: '2021',
    creators: [{ creatorType: 'author', lastName: 'Hinton', firstName: 'G.' }],
  },
};

describe('zotero_search_items', () => {
  it('returns concise projections by default', async () => {
    const router = vi.fn(async () => ({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 2114 }));
    const res = await searchItems.handler({ q: 'deep learning' }, ctx(router));
    expect(router).toHaveBeenCalled();
    const items = res.structuredContent?.items as any[];
    expect(items[0].title).toBe('Deep Learning');
    expect(items[0].key).toBe('ABCD1234');
    expect(items[0].creatorSummary).toMatch(/Hinton/);
    expect(items[0].version).toBeUndefined();
  });

  it('includes technical fields when response_format=detailed', async () => {
    const router = vi.fn(async () => ({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 2114 }));
    const res = await searchItems.handler({ q: 'x', response_format: 'detailed' }, ctx(router));
    const items = res.structuredContent?.items as any[];
    expect(items[0].version).toBe(2114);
  });

  it('exposes item fields in the TEXT content the model sees, not only structuredContent', async () => {
    const router = vi.fn(async () => ({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 2114 }));
    const res = await searchItems.handler({ q: 'deep learning' }, ctx(router));
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('ABCD1234'); // item key — needed to chain into get_item/bibliography
    expect(text).toContain('Deep Learning'); // title
  });

  it('passes boolean tag/itemType filters through to the router', async () => {
    const router = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 }));
    await searchItems.handler({ itemType: 'journalArticle || book', tag: 'to-read' }, ctx(router));
    expect(router).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'journalArticle || book', tag: 'to-read' }),
    );
  });

  it('auto-broadens to everything mode when the default search is empty', async () => {
    const router = vi
      .fn()
      .mockResolvedValueOnce({ data: [], totalResults: 0, lastModifiedVersion: 10 })
      .mockResolvedValueOnce({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 10 });
    const res = await searchItems.handler({ q: 'acados' }, ctx(router));
    expect(router).toHaveBeenCalledTimes(2);
    expect(router).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'acados', qmode: 'everything' }),
    );
    const items = res.structuredContent?.items as any[];
    expect(items).toHaveLength(1);
    expect(res.structuredContent?.broadened).toBe(true);
    expect(res.structuredContent?.qmode).toBe('everything');
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toMatch(/full-text match/i);
  });

  it('does not broaden when the caller pinned a qmode', async () => {
    const router = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 }));
    await searchItems.handler({ q: 'acados', qmode: 'titleCreatorYear' }, ctx(router));
    expect(router).toHaveBeenCalledTimes(1);
  });

  it('does not broaden when the default search already has hits', async () => {
    const router = vi.fn(async () => ({ data: [sampleItem], totalResults: 1, lastModifiedVersion: 1 }));
    await searchItems.handler({ q: 'deep learning' }, ctx(router));
    expect(router).toHaveBeenCalledTimes(1);
  });

  it('does not broaden when paging past the first page', async () => {
    const router = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 }));
    await searchItems.handler({ q: 'acados', start: 25 }, ctx(router));
    expect(router).toHaveBeenCalledTimes(1);
  });

  it('reports a not-conclusive note when an explicit everything-mode search is empty', async () => {
    const router = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 }));
    const res = await searchItems.handler({ q: 'enrico', qmode: 'everything' }, ctx(router));
    expect(router).toHaveBeenCalledTimes(1);
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toMatch(/not conclusive evidence of absence/i);
    expect(text.toLowerCase()).toMatch(/scanned|un-synced|not-yet-synced/);
  });

  it('broadens then reports not-conclusive when full text is also empty', async () => {
    const router = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 }));
    const res = await searchItems.handler({ q: 'enrico' }, ctx(router));
    expect(router).toHaveBeenCalledTimes(2);
    expect(res.structuredContent?.broadened).toBe(true);
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toMatch(/not conclusive evidence of absence/i);
  });
});

// The desktop local API answers /collections/<unknown>/items with the WHOLE library
// (measured: 723 items for a key that does not exist, 14 for one that does), so a scoped
// search used to be byte-for-byte indistinguishable from an unscoped one.
describe('zotero_search_items refuses a collection key the library does not have', () => {
  function localCtx(exists: boolean) {
    const searchImpl = vi.fn(async () => ({ data: [sampleItem], totalResults: 723, lastModifiedVersion: 666 }));
    return {
      router: {
        searchItems: searchImpl,
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        servesLocally: () => true,
      },
      local: { collectionExists: vi.fn(async () => exists) },
    } as any;
  }

  it('refuses, names the key, and searches nothing', async () => {
    const c = localCtx(false);
    const res = await searchItems.handler({ collectionKey: 'ZZZZZZZZ', limit: 3 }, c);
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any)?.text).toContain('ZZZZZZZZ');
    expect(c.router.searchItems).not.toHaveBeenCalled();
  });

  it('searches normally when the collection is real', async () => {
    const c = localCtx(true);
    const res = await searchItems.handler({ collectionKey: 'DDMMTKDW', limit: 3 }, c);
    expect(res.isError).toBeFalsy();
    expect(c.router.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({ collectionKey: 'DDMMTKDW' }),
    );
  });

  it('asks nothing extra of an unscoped search', async () => {
    const c = localCtx(false);
    const res = await searchItems.handler({ q: 'attention' }, c);
    expect(res.isError).toBeFalsy();
    expect(c.local.collectionExists).not.toHaveBeenCalled();
  });

  it('answers the search anyway when the existence check itself fails', async () => {
    const c = localCtx(true);
    c.local.collectionExists = vi.fn(async () => {
      throw new Error('desktop went away');
    });
    const res = await searchItems.handler({ collectionKey: 'DDMMTKDW' }, c);
    expect(res.isError).toBeFalsy();
    expect(c.router.searchItems).toHaveBeenCalled();
  });
});
