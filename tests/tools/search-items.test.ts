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
});
