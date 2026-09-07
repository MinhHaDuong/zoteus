import { describe, it, expect, vi } from 'vitest';

// Mock the citeproc engine so we test the tool's result shape, not citeproc-js.
vi.mock('../../src/features/citation/citeproc-engine.js', () => ({
  formatBibliography: () => ({
    bibliography: '<div class="csl-bib-body"><div>Devos, O. (2026).</div></div>',
    entries: ['<div>Devos, O. (2026).</div>'],
  }),
}));

const { default: formatBib } = await import('../../src/tools/format-bibliography.js');

function baseCtx(over: any = {}) {
  return {
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      // The desktop app's csljson export is a bare array (the cloud wraps one in { items }).
      exportItems: vi.fn(async () => JSON.stringify([{ id: 'X' }])),
    },
    styles: {
      resolveId: (s: string) => s.toLowerCase(),
      fetchStyle: vi.fn(async () => '<style/>'),
      fetchLocale: vi.fn(async () => '<locale/>'),
    },
    web: { exportItems: vi.fn(async () => JSON.stringify({ items: [{ id: 'CLOUD' }] })) },
    ...over,
  } as any;
}

describe('zotero_format_bibliography exports item_keys through the router (#64)', () => {
  it('asks the routed read for CSL-JSON of the selected library, never ctx.web', async () => {
    const c = baseCtx();
    const res = await formatBib.handler(
      { item_keys: ['K1'], library_type: 'group', library_id: 42 },
      c,
    );
    expect(res.isError).toBeUndefined();
    expect(c.router.exportItems).toHaveBeenCalledWith({
      library: { type: 'group', id: 42 },
      format: 'csljson',
      itemKey: ['K1'],
      limit: 100,
    });
    expect(c.web.exportItems).not.toHaveBeenCalled();
    await formatBib.handler({ item_keys: ['K1'] }, c);
    expect(c.router.exportItems).toHaveBeenLastCalledWith(
      expect.objectContaining({ library: { type: 'user', id: 19552201 } }),
    );
  });
});

// Regression: struct-only clients read structuredContent. Both the per-entry
// array and the ready-to-use joined string must be present in the struct.
describe('zotero_format_bibliography structuredContent carries the payload', () => {
  it('includes both entries and the joined bibliography string', async () => {
    const c = baseCtx();
    const res = await formatBib.handler({ items: [{ id: 'X' }], style: 'apa' }, c);
    const struct = res.structuredContent as any;
    expect(struct.entries).toEqual(['<div>Devos, O. (2026).</div>']);
    expect(struct.bibliography).toBe('<div class="csl-bib-body"><div>Devos, O. (2026).</div></div>');
    expect(struct.entryCount).toBe(1);
  });
});
