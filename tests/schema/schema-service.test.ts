import { describe, it, expect, vi } from 'vitest';
import { SchemaService } from '../../src/schema/schema-service.js';

describe('SchemaService', () => {
  it('fetches once and caches subsequent calls', async () => {
    const getSchema = vi.fn(async () => ({ version: 39, itemTypes: [{ itemType: 'book' }] }));
    const svc = new SchemaService({ web: { getSchema } as any });
    const a = await svc.getSchema();
    const b = await svc.getSchema();
    expect(a.version).toBe(39);
    expect(b).toBe(a);
    expect(getSchema).toHaveBeenCalledTimes(1);
  });

  it('lists item type names', async () => {
    const getSchema = vi.fn(async () => ({
      version: 1,
      itemTypes: [{ itemType: 'book' }, { itemType: 'journalArticle' }],
    }));
    const svc = new SchemaService({ web: { getSchema } as any });
    expect(await svc.itemTypeNames()).toEqual(['book', 'journalArticle']);
  });
});
