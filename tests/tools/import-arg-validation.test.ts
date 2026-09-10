import { describe, it, expect, vi } from 'vitest';
import importTool from '../../src/tools/import.js';

/**
 * A context whose only job is to record whether the translation-server was probed. The
 * probe is the point: an argument the handler can judge on its own must be judged before
 * the environment is blamed for it.
 */
function ctx(up = false) {
  const isUp = vi.fn(async () => up);
  return {
    ctx: {
      config: { translationServerUrl: 'http://127.0.0.1:1969' },
      translation: { isUp, search: vi.fn(async () => []), web: vi.fn(async () => ({ items: [] })) },
    } as any,
    isUp,
  };
}

describe('zotero_import validates its arguments before blaming the translation-server', () => {
  it('names the empty identifier instead of reporting an unreachable server', async () => {
    // Measured: `identifier: ""` came back as "No Zotero translation-server reachable at
    // http://127.0.0.1:1969 ... start it with `docker run ...`". Nothing about the
    // translation-server was wrong, and installing Docker would not have helped (#79).
    const { ctx: c, isUp } = ctx(false);
    const res = await importTool.handler({ action: 'by_identifier', identifier: '' }, c);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/`identifier` is empty/);
    expect(res.content[0]!.text).not.toMatch(/translation-server/);
    expect(res.content[0]!.text).not.toMatch(/docker/i);
    expect(isUp).not.toHaveBeenCalled();
  });

  it('treats whitespace as empty, and says so the same way when the server IS up', async () => {
    const { ctx: c } = ctx(true);
    const res = await importTool.handler({ action: 'by_identifier', identifier: '   ' }, c);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/`identifier` is empty/);
  });

  it('names an empty url, and points at the other action', async () => {
    const { ctx: c, isUp } = ctx(false);
    const res = await importTool.handler({ action: 'by_url', url: '' }, c);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/`url` is empty/);
    expect(res.content[0]!.text).toMatch(/by_identifier/);
    expect(isUp).not.toHaveBeenCalled();
  });

  it('still reports the missing server for a real URL, which has no built-in fallback', async () => {
    const { ctx: c, isUp } = ctx(false);
    const res = await importTool.handler({ action: 'by_url', url: 'https://example.com/paper' }, c);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/No Zotero translation-server reachable/);
    expect(isUp).toHaveBeenCalled();
  });

  it('leaves a real identifier on the built-in path when the server is down', async () => {
    // The guard must not swallow the case it sits in front of: a DOI resolves through the
    // scholar providers with no translation-server at all.
    const { ctx: c } = ctx(false);
    (c as any).scholar = { lookup: vi.fn(async () => ({ title: 'Resolved', type: 'article' })) };
    const res = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1109/ICRA48891.2023.10161177' },
      c,
    );
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as any).source).toBe('scholar');
  });
});
