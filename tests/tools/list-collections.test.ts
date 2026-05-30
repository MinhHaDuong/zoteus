import { describe, it, expect, vi } from 'vitest';
import listCollections from '../../src/tools/list-collections.js';

function ctx(listImpl: any) {
  return { router: { listCollections: listImpl, defaultLibrary: () => ({ type: 'user', id: 19552201 }) } } as any;
}

describe('zotero_list_collections', () => {
  it('lists collections with key/name/parent/numItems, visible in text content', async () => {
    const impl = vi.fn(async () => ({
      data: [{ key: 'C1', data: { name: 'Reading', parentCollection: false }, meta: { numItems: 4 } }],
      totalResults: 1,
      lastModifiedVersion: 1,
    }));
    const res = await listCollections.handler({}, ctx(impl));
    const cols = res.structuredContent?.collections as any[];
    expect(cols[0]).toEqual({ key: 'C1', name: 'Reading', parentCollection: false, numItems: 4 });
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('Reading');
  });

  it('is annotated read-only', () => {
    expect(listCollections.annotations?.readOnlyHint).toBe(true);
  });
});
