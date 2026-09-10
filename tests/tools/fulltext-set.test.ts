import { describe, it, expect, vi } from 'vitest';
import fulltext from '../../src/tools/fulltext.js';

/**
 * A key-free context: the desktop app is up, there is no cloud identity. `capabilities.cloud`
 * is what every write gate reads.
 */
function keyFreeCtx(defaultLibrary: { type: 'user' | 'group'; id: number } = { type: 'user', id: 0 }) {
  const setFullText = vi.fn(async () => undefined);
  return {
    ctx: {
      config: { libraryType: 'user', libraryId: undefined },
      capabilities: { cloud: null, localApi: true, localGroupIds: [6666644] },
      router: { defaultLibrary: () => defaultLibrary },
      web: { setFullText },
    } as any,
    setFullText,
  };
}

describe('zotero_fulltext action:"set" refuses in terms of the operation, not the library', () => {
  it('says storing full text is cloud-only, for a call that named the personal library', async () => {
    // Measured: this answered "This operation writes to a cloud/group library and requires a
    // cloud API key", on a personal-library call, on a machine running the desktop app. The
    // library was not the problem: `set` is the one operation with no desktop path at all,
    // since neither desktop write client has a full-text endpoint (#79).
    const { ctx, setFullText } = keyFreeCtx();
    const res = await fulltext.handler({ action: 'set', item_key: 'CKSETW3U', content: 'text' }, ctx);
    expect(res.isError).toBe(true);
    const msg = res.content[0]!.text;
    expect(msg).toMatch(/cloud-only/);
    expect(msg).toMatch(/users\/0/);
    expect(msg).toMatch(/neither has a full-text endpoint/);
    expect(msg).toMatch(/ZOTERO_API_KEY/);
    // What still works has to be named, or the caller cannot tell reads are unaffected.
    expect(msg).toMatch(/action:"get"/);
    expect(msg).not.toMatch(/cloud\/group/);
    expect(setFullText).not.toHaveBeenCalled();
  });

  it('leaves the group refusal to the shared cloud gate, which is already accurate', async () => {
    const { ctx, setFullText } = keyFreeCtx();
    const res = await fulltext.handler(
      { action: 'set', item_key: 'CKSETW3U', content: 'text', library_type: 'group', library_id: 6666644 },
      ctx,
    ).catch((e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/group library 6666644/);
    expect(setFullText).not.toHaveBeenCalled();
  });

  it('still requires item_key and content before anything else', async () => {
    const { ctx } = keyFreeCtx();
    const res = await fulltext.handler({ action: 'set', item_key: 'CKSETW3U' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/`item_key` and `content` are required/);
  });

  it('writes through the Web API when a cloud key can take it', async () => {
    const { ctx, setFullText } = keyFreeCtx();
    ctx.capabilities.cloud = { userID: 19552201, access: { user: { write: true } } };
    const res = await fulltext.handler(
      { action: 'set', item_key: 'CKSETW3U', content: 'text', indexed_pages: 2, total_pages: 3 },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    expect(setFullText).toHaveBeenCalledWith(
      { type: 'user', id: 0 },
      'CKSETW3U',
      expect.objectContaining({ content: 'text', indexedPages: 2, totalPages: 3 }),
    );
  });
});
