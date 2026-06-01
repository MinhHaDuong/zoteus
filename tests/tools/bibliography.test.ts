import { describe, it, expect, vi } from 'vitest';
import bibliography from '../../src/tools/bibliography.js';

function baseCtx(over: any = {}) {
  return {
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
    styles: { resolveId: (s: string) => s.toLowerCase() },
    web: { getBibliography: vi.fn(async () => '<div class="csl-entry">Devos, O. (2026).</div>') },
    ...over,
  } as any;
}

// Regression: struct-only clients (e.g. the claude.ai connector) read
// structuredContent and ignore content. The rendered XHTML must live in the
// struct, not just in content — otherwise the caller sees only {style,itemCount}.
describe('zotero_bibliography structuredContent carries the payload', () => {
  it('mirrors the rendered bibliography into structuredContent', async () => {
    const c = baseCtx();
    const res = await bibliography.handler({ item_keys: ['K1'], style: 'IEEE' }, c);
    const struct = res.structuredContent as any;
    expect(struct.bibliography).toBe('<div class="csl-entry">Devos, O. (2026).</div>');
    expect(struct.itemCount).toBe(1);
    expect(struct.style).toBe('ieee');
  });
});
