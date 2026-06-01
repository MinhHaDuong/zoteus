import { describe, it, expect, vi } from 'vitest';
import exportTool from '../../src/tools/export.js';

function baseCtx(over: any = {}) {
  return {
    config: { localPort: 23119 },
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
    web: { exportItems: vi.fn(async () => '@article{builtin, title={X}}') },
    local: {}, // truthy = desktop mode present
    ...over,
  } as any;
}

describe('zotero_export better-biblatex', () => {
  it('built-in biblatex still goes to the cloud Web API', async () => {
    const c = baseCtx();
    const res = await exportTool.handler({ format: 'biblatex', item_keys: ['K1'] }, c);
    expect(c.web.exportItems).toHaveBeenCalled();
    expect((res.structuredContent as any).format).toBe('biblatex');
  });

  it('degrades to built-in biblatex when BBT is unavailable and notes it', async () => {
    const c = baseCtx({ local: undefined }); // hosted / no local desktop
    const res = await exportTool.handler({ format: 'better-biblatex', item_keys: ['K1'] }, c);
    expect(c.web.exportItems).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: 'biblatex' }),
    );
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
