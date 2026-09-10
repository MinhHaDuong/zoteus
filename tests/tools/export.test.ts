import { describe, it, expect, vi } from 'vitest';
import exportTool from '../../src/tools/export.js';

function baseCtx(over: any = {}) {
  return {
    config: { localPort: 23119 },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      exportItems: vi.fn(async () => '@article{builtin, title={X}}'),
      // Cloud-served by default: api.zotero.org 404s an unknown collection itself, so the
      // collection guard asks nothing there.
      servesLocally: () => false,
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

// The desktop local API answers /collections/<unknown>/items with the WHOLE library
// (measured: 723 items for a key that does not exist, 14 for one that does), so an export
// scoped to a mistyped key used to return the entire library as if it were the collection.
describe('zotero_export refuses a collection key the library does not have', () => {
  function localCtx(exists: boolean, over: any = {}) {
    const c = baseCtx(over);
    c.router.servesLocally = () => true;
    c.local = { collectionExists: vi.fn(async () => exists) };
    return c;
  }

  it('refuses, names the key, and exports nothing', async () => {
    const c = localCtx(false);
    const res = await exportTool.handler({ format: 'ris', collection_key: 'ZZZZZZZZ' }, c);
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any)?.text).toContain('ZZZZZZZZ');
    expect(c.router.exportItems).not.toHaveBeenCalled();
  });

  it('exports normally when the collection is real', async () => {
    const c = localCtx(true);
    const res = await exportTool.handler({ format: 'ris', collection_key: 'DDMMTKDW' }, c);
    expect(res.isError).toBeFalsy();
    expect(c.router.exportItems).toHaveBeenCalledWith(
      expect.objectContaining({ collectionKey: 'DDMMTKDW' }),
    );
  });

  it('costs no round trip when no collection was named', async () => {
    const c = localCtx(false);
    const res = await exportTool.handler({ format: 'ris', q: 'turing' }, c);
    expect(res.isError).toBeFalsy();
    expect(c.local.collectionExists).not.toHaveBeenCalled();
  });

  it('costs no round trip on the cloud path, which 404s the sub-route itself', async () => {
    const c = baseCtx();
    c.local = { collectionExists: vi.fn(async () => false) };
    await exportTool.handler({ format: 'ris', collection_key: 'ZZZZZZZZ' }, c);
    expect(c.local.collectionExists).not.toHaveBeenCalled();
    expect(c.router.exportItems).toHaveBeenCalled();
  });
});

// An export of a key Zotero does not have came back as "\n\n" with no summary, no notice
// and no error, so an empty export was indistinguishable from a failed one.
describe('zotero_export never passes an empty body off as a rendering', () => {
  function emptyCtx(over: any = {}) {
    return baseCtx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        exportItems: vi.fn(async () => '\n\n'),
        servesLocally: () => false,
      },
      ...over,
    });
  }

  it('refuses when named item_keys render not one entry, and names them', async () => {
    const res = await exportTool.handler({ format: 'bibtex', item_keys: ['ZZZZZZZZ'] }, emptyCtx());
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toContain('ZZZZZZZZ');
  });

  it('reports a selection that legitimately matched nothing as an empty export, not an error', async () => {
    const res = await exportTool.handler({ format: 'ris', q: 'nothing matches this' }, emptyCtx());
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.empty).toBe(true);
    expect(sc.notice).toContain('nothing matches this');
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toMatch(/empty export/i);
  });

  it('leaves a real rendering exactly as it was, with no empty flag', async () => {
    const res = await exportTool.handler({ format: 'bibtex', item_keys: ['K1'] }, baseCtx());
    const sc = res.structuredContent as any;
    expect(sc.empty).toBeUndefined();
    expect(sc.text).toBe('@article{builtin, title={X}}');
    expect((res.content?.[0] as any)?.text).toBe('@article{builtin, title={X}}');
  });

  it('refuses an empty degraded biblatex export too, keys named', async () => {
    const c = emptyCtx({ local: undefined });
    const res = await exportTool.handler({ format: 'better-biblatex', item_keys: ['ZZZZZZZZ'] }, c);
    expect(res.isError).toBe(true);
    expect((res.content?.[0] as any)?.text).toContain('ZZZZZZZZ');
  });
});
