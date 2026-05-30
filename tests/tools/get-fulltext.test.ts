import { describe, it, expect, vi } from 'vitest';
import getFulltext from '../../src/tools/get-fulltext.js';

const FT = {
  content:
    'Background on optimization. '.repeat(20) +
    'The Hessian is decomposed into a Gauss-Newton term plus a remainder. '.repeat(3) +
    'Unrelated appendix material. '.repeat(20),
  indexedChars: 2000,
  totalChars: 2000,
  indexedPages: 8,
  totalPages: 8,
};

function ctx(over: any = {}) {
  return {
    config: { dataDir: '/tmp' },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'journalArticle', title: 'Grandia et al.' } })),
      getItemChildren: vi.fn(async () => ({
        data: [{ key: 'ATT01', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf' } }],
        totalResults: 1,
        lastModifiedVersion: 1,
      })),
    },
    web: {
      getFullText: vi.fn(async () => FT),
      downloadFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([1]), contentType: 'application/pdf' })),
    },
    search: { hasEmbedder: false, embed: async () => [] },
    ...over,
  } as any;
}

describe('zotero_get_fulltext', () => {
  it('is annotated read-only', () => {
    expect(getFulltext.annotations?.readOnlyHint).toBe(true);
  });

  it('resolves a parent item to its PDF child and returns query passages with approx pages', async () => {
    const c = ctx();
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'Hessian decomposed' }, c);
    expect(c.router.getItemChildren).toHaveBeenCalled();
    expect(c.web.getFullText).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, 'ATT01');
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('passages');
    expect(sc.attachmentKey).toBe('ATT01');
    expect(sc.pageSource).toBe('approximate');
    expect(sc.passages[0].text.toLowerCase()).toContain('hessian');
    expect(sc.passages[0].pageApprox).toBeGreaterThanOrEqual(1);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toContain('ATT01');
    expect(text.toLowerCase()).toContain('hessian');
  });

  it('returns a truncated document head with a notice when no query/page_range', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', max_chars: 500 }, ctx());
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('document');
    expect(sc.truncated).toBe(true);
    expect((sc.text as string).length).toBeLessThanOrEqual(500);
    expect(sc.notice).toMatch(/query|page_range|max_chars/);
  });

  it('errors clearly when the attachment has no extracted full text', async () => {
    const c = ctx({ web: { getFullText: vi.fn(async () => null) } });
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'x' }, c);
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text.toLowerCase()).toMatch(/no extracted full text|not.*indexed/);
  });

  it('degrades precise_pages to approximate when extraction yields nothing', async () => {
    // pdfjs-dist is not installed in tests → extractPdfPages returns null → approximate.
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'Hessian', precise_pages: true }, ctx());
    const sc = res.structuredContent as any;
    expect(sc.pageSource).toBe('approximate');
    expect(sc.notice).toMatch(/precise|exact|approx/i);
  });
});
