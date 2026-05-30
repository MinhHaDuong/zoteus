import { describe, it, expect, vi } from 'vitest';
import listTags from '../../src/tools/list-tags.js';

function ctx(listTagsImpl: any) {
  return {
    web: { listTags: listTagsImpl },
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
  } as any;
}

describe('zotero_list_tags', () => {
  it('lists tags with usage counts and auto flag, visible in text content', async () => {
    const impl = vi.fn(async () => ({
      data: [
        { tag: 'ml', meta: { type: 1, numItems: 12 } },
        { tag: 'to-read', meta: { numItems: 3 } },
      ],
      totalResults: 2,
      lastModifiedVersion: 1,
    }));
    const res = await listTags.handler({}, ctx(impl));
    const tags = res.structuredContent?.tags as any[];
    expect(tags[0]).toEqual({ name: 'ml', numItems: 12, auto: true });
    expect(tags[1]).toEqual({ name: 'to-read', numItems: 3, auto: false });
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('to-read');
  });

  it('is annotated read-only', () => {
    expect(listTags.annotations?.readOnlyHint).toBe(true);
  });
});
