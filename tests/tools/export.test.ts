import { describe, it, expect, vi } from 'vitest';
import exportTool from '../../src/tools/export.js';

function baseCtx(over: any = {}) {
  return {
    config: { localPort: 23119 },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      exportItems: vi.fn(async () => '@article{builtin, title={X}}'),
    },
    // The unrouted cloud client must not be reached by an export any more (#75).
    web: { exportItems: vi.fn(async () => '@article{cloud, title={WRONG}}') },
    local: {}, // truthy = desktop mode present
    ...over,
  } as any;
}

describe('zotero_export routes stock formats through the library router (#75)', () => {
  it('exports the default library through the router, never ctx.web', async () => {
    const c = baseCtx();
    const res = await exportTool.handler({ format: 'bibtex', item_keys: ['K1'] }, c);
    expect(c.router.exportItems).toHaveBeenCalledWith({
      library: { type: 'user', id: 19552201 },
      format: 'bibtex',
      itemKey: ['K1'],
      collectionKey: undefined,
      q: undefined,
      itemType: undefined,
      limit: 50,
    });
    expect(c.web.exportItems).not.toHaveBeenCalled();
    expect((res.structuredContent as any).text).toBe('@article{builtin, title={X}}');
  });

  it('forwards an explicit library and every selector with the limit', async () => {
    const c = baseCtx();
    await exportTool.handler(
      {
        format: 'ris',
        collection_key: 'COLL',
        q: 'turing',
        item_type: 'book',
        limit: 7,
        library_type: 'group',
        library_id: 42,
      },
      c,
    );
    expect(c.router.exportItems).toHaveBeenCalledWith({
      library: { type: 'group', id: 42 },
      format: 'ris',
      itemKey: undefined,
      collectionKey: 'COLL',
      q: 'turing',
      itemType: 'book',
      limit: 7,
    });
    expect(c.web.exportItems).not.toHaveBeenCalled();
  });

  it('built-in biblatex takes the routed read too', async () => {
    const c = baseCtx();
    const res = await exportTool.handler({ format: 'biblatex', item_keys: ['K1'] }, c);
    expect(c.router.exportItems).toHaveBeenCalledWith(expect.objectContaining({ format: 'biblatex' }));
    expect(c.web.exportItems).not.toHaveBeenCalled();
    expect((res.structuredContent as any).format).toBe('biblatex');
  });
});

describe('zotero_export better-biblatex', () => {
  it('degrades to built-in biblatex through the router when BBT is unavailable and notes it', async () => {
    const c = baseCtx({ local: undefined }); // hosted / no local desktop
    const res = await exportTool.handler({ format: 'better-biblatex', item_keys: ['K1'] }, c);
    expect(c.router.exportItems).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'biblatex', itemKey: ['K1'] }),
    );
    expect(c.web.exportItems).not.toHaveBeenCalled();
    expect((res.structuredContent as any).degradedToBuiltIn).toBe(true);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text.toLowerCase()).toMatch(/better bibtex|desktop|degrad/);
  });
});

// Regression: struct-only clients (e.g. the claude.ai connector) read
// structuredContent and ignore content. The raw export must live in the struct,
// not just in content — otherwise the caller sees only {format,length}.
describe('zotero_export structuredContent carries the payload', () => {
  it('normal export mirrors the raw text into structuredContent', async () => {
    const c = baseCtx();
    const res = await exportTool.handler({ format: 'bibtex', item_keys: ['K1'] }, c);
    expect((res.structuredContent as any).text).toBe('@article{builtin, title={X}}');
  });

  it('degraded biblatex still mirrors the text into structuredContent', async () => {
    const c = baseCtx({ local: undefined });
    const res = await exportTool.handler({ format: 'better-biblatex', item_keys: ['K1'] }, c);
    expect((res.structuredContent as any).text).toBe('@article{builtin, title={X}}');
  });
});
