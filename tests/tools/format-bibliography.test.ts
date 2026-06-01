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
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
    styles: {
      resolveId: (s: string) => s.toLowerCase(),
      fetchStyle: vi.fn(async () => '<style/>'),
      fetchLocale: vi.fn(async () => '<locale/>'),
    },
    web: { exportItems: vi.fn(async () => JSON.stringify({ items: [{ id: 'X' }] })) },
    ...over,
  } as any;
}

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
