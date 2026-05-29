import { describe, it, expect, vi } from 'vitest';
import getItem from '../../src/tools/get-item.js';

function ctx(getImpl: any, childrenImpl?: any) {
  return {
    router: {
      getItem: getImpl,
      getItemChildren:
        childrenImpl ?? vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
  } as any;
}

describe('zotero_get_item', () => {
  it('returns the full item record', async () => {
    const getImpl = vi.fn(async () => ({ key: 'ABCD', version: 5, data: { itemType: 'book', title: 'T' } }));
    const res = await getItem.handler({ item_key: 'ABCD' }, ctx(getImpl));
    expect(getImpl).toHaveBeenCalledWith('ABCD', expect.any(Object));
    expect((res.structuredContent?.item as any).data.title).toBe('T');
  });

  it('includes children when requested', async () => {
    const getImpl = vi.fn(async () => ({ key: 'ABCD', data: { itemType: 'book' } }));
    const childrenImpl = vi.fn(async () => ({
      data: [{ key: 'NOTE1', data: { itemType: 'note' } }],
      totalResults: 1,
      lastModifiedVersion: 5,
    }));
    const res = await getItem.handler({ item_key: 'ABCD', include_children: true }, ctx(getImpl, childrenImpl));
    expect(childrenImpl).toHaveBeenCalled();
    expect((res.structuredContent?.children as any[])[0].key).toBe('NOTE1');
  });
});
