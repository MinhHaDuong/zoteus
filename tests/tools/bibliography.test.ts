import { describe, it, expect, vi } from 'vitest';
import bibliography from '../../src/tools/bibliography.js';

function baseCtx(over: any = {}) {
  return {
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      getBibliography: vi.fn(async () => '<div class="csl-entry">Devos, O. (2026).</div>'),
    },
    styles: { resolveId: (s: string) => s.toLowerCase() },
    web: { getBibliography: vi.fn(async () => '<div class="csl-entry">CLOUD</div>') },
    ...over,
  } as any;
}

describe('zotero_bibliography reads through the router (#64)', () => {
  it('hands the resolved library, style, locale and linkwrap to the routed read, never ctx.web', async () => {
    // Going to ctx.web directly meant key-free local mode rendered nothing: the default
    // library there is users/0, which only the desktop app knows how to answer.
    const c = baseCtx();
    await bibliography.handler(
      { item_keys: ['K1', 'K2'], style: 'APA', locale: 'fr-FR', linkwrap: true },
      c,
    );
    expect(c.router.getBibliography).toHaveBeenCalledWith(['K1', 'K2'], {
      library: { type: 'user', id: 19552201 },
      style: 'apa',
      locale: 'fr-FR',
      linkwrap: true,
    });
    await bibliography.handler({ item_keys: ['K1'], library_type: 'group', library_id: 42 }, c);
    expect(c.router.getBibliography).toHaveBeenLastCalledWith(['K1'], {
      library: { type: 'group', id: 42 },
      style: undefined,
      locale: undefined,
      linkwrap: undefined,
    });
    expect(c.web.getBibliography).not.toHaveBeenCalled();
  });
});

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
