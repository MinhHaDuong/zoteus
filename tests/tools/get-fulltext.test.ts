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
  const c = {
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
  // The real LibraryRouter serves full text from the desktop app when one is running and
  // from the cloud otherwise. These doubles have no local API, so mirror the cloud path
  // (resolved at call time, since individual tests swap `web` out).
  c.router.getFullText ??= (key: string, opts: any = {}) =>
    c.web.getFullText(opts.library ?? c.router.defaultLibrary(), key);
  return c;
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
    // the tiny garbage buffer fails to parse → extractPdfPages returns null → approximate
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'Hessian', precise_pages: true }, ctx());
    const sc = res.structuredContent as any;
    expect(sc.pageSource).toBe('approximate');
    expect(sc.notice).toMatch(/precise|exact|approx/i);
  });

  it('skips precise_pages re-extraction (no download) for an oversized PDF — OOM guard', async () => {
    const big = 50 * 1024 * 1024; // 50 MB > the 20 MB re-extraction cap
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'journalArticle', title: 'Big PDF' } })),
        getItemChildren: vi.fn(async () => ({
          data: [
            {
              key: 'ATT01',
              data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'big.pdf' },
              links: { enclosure: { length: big } },
            },
          ],
          totalResults: 1,
          lastModifiedVersion: 1,
        })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'Hessian', precise_pages: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.pageSource).toBe('approximate');
    expect(sc.notice).toMatch(/exceeds|limit|MB/i);
    // the 42 MB-class transfer is never made — the guard fired before download
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    // grounding still works: approximate passages are still returned
    expect(sc.passages[0].pageApprox).toBeGreaterThanOrEqual(1);
  });
});

// A tiny valid PDF with one text-bearing page — pdfjs extracts "Hello PDF" from it.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 41 >> stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
const PDF_BYTES = new TextEncoder().encode(MINIMAL_PDF);

describe('zotero_get_fulltext PDF fallback (unindexed attachments)', () => {
  function emptyIndexCtx(over: any = {}) {
    return ctx({
      web: {
        getFullText: vi.fn(async () => null), // Zotero has NOT indexed this PDF
        downloadFileBytes: vi.fn(async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf' })),
      },
      ...over,
    });
  }

  it('extracts text directly from the PDF when the Zotero index is empty (document mode)', async () => {
    const c = emptyIndexCtx();
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    expect(res.isError).toBeFalsy();
    expect(c.web.downloadFileBytes).toHaveBeenCalled();
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('document');
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.pageSource).toBe('exact');
    expect(sc.totalPages).toBe(1);
    expect(sc.text).toContain('Hello PDF');
    expect(sc.notice).toMatch(/extracted directly from the PDF|fallback/i);
  });

  it('serves query passages with exact pages from the on-the-fly extraction', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'Hello PDF' }, emptyIndexCtx());
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('passages');
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.passages.length).toBeGreaterThan(0);
    expect(sc.passages[0].text).toContain('Hello PDF');
    expect(sc.passages[0].page).toBe(1);
  });

  it('serves page_range from the extracted pages', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '1' }, emptyIndexCtx());
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('page_range');
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.text).toContain('Hello PDF');
  });

  it('honours fallback:false and returns an actionable error instead', async () => {
    const c = emptyIndexCtx();
    const res = await getFulltext.handler({ item_key: 'PARENT01', fallback: false }, c);
    expect(res.isError).toBe(true);
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toMatch(/not indexed|fallback/i);
  });

  it('errors clearly when the PDF download fails (e.g. linked file with no stored copy)', async () => {
    const c = ctx({
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => {
          throw new Error('404');
        }),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toMatch(/could not be downloaded|linked file/i);
  });

  it('errors clearly when extraction yields nothing (garbage/scan, not a parseable PDF)', async () => {
    const c = ctx({
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'application/pdf' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toMatch(/extraction yielded nothing|index/i);
  });

  it('skips the fallback download entirely for an oversized PDF (OOM guard)', async () => {
    const big = 50 * 1024 * 1024;
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'journalArticle', title: 'Big PDF' } })),
        getItemChildren: vi.fn(async () => ({
          data: [
            {
              key: 'ATT01',
              data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'big.pdf' },
              links: { enclosure: { length: big } },
            },
          ],
          totalResults: 1,
          lastModifiedVersion: 1,
        })),
      },
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    expect(res.isError).toBe(true);
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    const text = (res.content ?? []).map((x: { text: string }) => x.text).join('\n');
    expect(text).toMatch(/larger than|limit|MB/i);
  });
});
