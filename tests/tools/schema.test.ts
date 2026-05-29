import { describe, it, expect, vi } from 'vitest';
import schemaTool from '../../src/tools/schema.js';

function ctx() {
  return {
    schema: {
      getSchema: vi.fn(async () => ({
        version: 39,
        itemTypes: [
          {
            itemType: 'book',
            fields: [{ field: 'title' }],
            creatorTypes: [{ creatorType: 'author', primary: true }],
          },
        ],
      })),
      itemTypeNames: vi.fn(async () => ['book']),
    },
  } as any;
}

describe('zotero_schema', () => {
  it('lists item types when no itemType is given', async () => {
    const res = await schemaTool.handler({}, ctx());
    expect(res.structuredContent?.version).toBe(39);
    expect(res.structuredContent?.itemTypes).toEqual(['book']);
  });

  it('returns fields and creator types for a specific itemType', async () => {
    const res = await schemaTool.handler({ item_type: 'book' }, ctx());
    expect(res.structuredContent?.fields as string[]).toContain('title');
    expect(res.structuredContent?.creatorTypes as string[]).toContain('author');
  });
});
