import { describe, it, expect, vi } from 'vitest';
import listTags from '../../src/tools/list-tags.js';

function ctx(listTagsImpl: any) {
  return {
    // No `web` at all: reading tags off ctx.web sent every key-free local install to
    // api.zotero.org as users/0, which answers "Invalid user ID".
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }), listTags: listTagsImpl },
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

  it('asks the router, so the desktop app can answer without a cloud key', async () => {
    const impl = vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 1 }));
    await listTags.handler({ q: 'mpc', limit: 10 }, ctx(impl));
    expect(impl).toHaveBeenCalledWith({
      library: { type: 'user', id: 19552201 },
      q: 'mpc',
      limit: 10,
    });
  });

  it('is annotated read-only', () => {
    expect(listTags.annotations?.readOnlyHint).toBe(true);
  });
});
