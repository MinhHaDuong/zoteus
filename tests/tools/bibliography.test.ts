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
// struct, not just in content; otherwise the caller sees only {style,entryCount}.
describe('zotero_bibliography structuredContent carries the payload', () => {
  it('mirrors the rendered bibliography into structuredContent', async () => {
    const c = baseCtx();
    const res = await bibliography.handler({ item_keys: ['K1'], style: 'IEEE' }, c);
    const struct = res.structuredContent as any;
    expect(struct.bibliography).toBe('<div class="csl-entry">Devos, O. (2026).</div>');
    expect(struct.entryCount).toBe(1);
    expect(struct.requestedCount).toBe(1);
    expect(struct.style).toBe('ieee');
    // Everything asked for rendered, so there is nothing to warn about.
    expect(struct.note).toBeUndefined();
    expect(res.content).toHaveLength(1);
  });
});

// Zotero drops a key it cannot render and answers 200 with an empty csl-bib-body, so the
// count has to come from the rendering. `itemCount: item_keys.length` echoed the request
// instead: one bogus key was reported as `itemCount: 1` over an empty bibliography, a
// number no rendering could ever contradict (#79).
const EMPTY = '<div class="csl-bib-body" style="line-height: 1.35;">\n</div>';
const TWO =
  '<div class="csl-bib-body">\n  <div class="csl-entry" style="margin-bottom: 1em;">One.</div>\n' +
  '  <div class="csl-entry">Two.</div>\n</div>';

describe('zotero_bibliography counts what was rendered, not what was asked for', () => {
  it('reports 0 entries and says so when nothing came back for the keys', async () => {
    const c = baseCtx({
      router: { defaultLibrary: () => ({ type: 'user', id: 0 }), getBibliography: vi.fn(async () => EMPTY) },
    });
    const res = await bibliography.handler({ item_keys: ['ZZZZZZZZ'] }, c);
    const struct = res.structuredContent as any;
    expect(struct.entryCount).toBe(0);
    expect(struct.requestedCount).toBe(1);
    // The raw render is still carried, but the text channel leads with the sibling tool's
    // wording rather than an empty wrapper that reads like a result.
    expect(struct.bibliography).toBe(EMPTY);
    expect(res.content[0]!.text).toBe('(empty bibliography)');
    expect(res.content[1]!.text).toMatch(/rendered 0 of the 1 requested key\(s\) from users\/0/);
    expect(struct.note).toMatch(/attachment or a note/);
    // Not an error: an empty bibliography is a real answer, as in zotero_format_bibliography.
    expect(res.isError).toBeUndefined();
  });

  it('names the shortfall when only some keys rendered', async () => {
    const c = baseCtx({
      router: {
        defaultLibrary: () => ({ type: 'group', id: 6666644 }),
        getBibliography: vi.fn(async () => TWO),
      },
    });
    const res = await bibliography.handler({ item_keys: ['K1', 'K2', 'K3'] }, c);
    const struct = res.structuredContent as any;
    expect(struct.entryCount).toBe(2);
    expect(struct.requestedCount).toBe(3);
    expect(struct.note).toMatch(/rendered 2 of the 3 requested key\(s\) from groups\/6666644/);
    // The rendering is what a caller wants first; the warning follows it.
    expect(res.content[0]!.text).toBe(TWO);
    expect(res.content[1]!.text).toMatch(/1 produced no entry/);
  });
});
