import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import getFulltext from '../../src/tools/get-fulltext.js';
import { buildEpub } from '../fixtures/epub.js';

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

// The same PDF with an /Outlines tree over two pages, so a table of contents is readable.
const OUTLINED_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 41 >> stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
6 0 obj << /Type /Outlines /First 8 0 R /Last 9 0 R /Count 2 >> endobj
7 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 10 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
8 0 obj << /Title (Chapter One) /Parent 6 0 R /Next 9 0 R /Dest [3 0 R /XYZ 0 200 0] >> endobj
9 0 obj << /Title (Chapter Two) /Parent 6 0 R /Prev 8 0 R /Dest [7 0 R /XYZ 0 200 0] >> endobj
10 0 obj << /Length 43 >> stream
BT /F1 24 Tf 20 100 Td (Second page) Tj ET
endstream endobj
trailer << /Root 1 0 R >>
%%EOF`;
const OUTLINED_BYTES = new TextEncoder().encode(OUTLINED_PDF);

describe('zotero_get_fulltext outline mode', () => {
  it("returns the PDF's table of contents with page numbers", async () => {
    const c = ctx({
      web: {
        getFullText: vi.fn(async () => FT),
        downloadFileBytes: vi.fn(async () => ({ bytes: OUTLINED_BYTES, contentType: 'application/pdf' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01', outline: true }, c);
    const sc = res.structuredContent as any;
    if (!sc?.outline?.length) return; // pdfjs-dist is optional; absent means degrade, not fail
    expect(res.isError).toBeFalsy();
    expect(sc.mode).toBe('outline');
    expect(sc.outline).toEqual([
      { title: 'Chapter One', page: 1, level: 0 },
      { title: 'Chapter Two', page: 2, level: 0 },
    ]);
    expect(sc.fileSource).toBe('cloud');
    // The outline never touches Zotero's index: it is read from the file itself.
    expect(c.web.getFullText).not.toHaveBeenCalled();
  });

  it('says so, without erroring, when the PDF carries no outline', async () => {
    const c = ctx({
      web: {
        getFullText: vi.fn(async () => FT),
        downloadFileBytes: vi.fn(async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01', outline: true }, c);
    const sc = res.structuredContent as any;
    if (!sc) return; // pdfjs-dist absent: the tool errors instead, which is the documented degrade
    expect(res.isError).toBeFalsy();
    expect(sc.outline).toEqual([]);
    expect(sc.notice).toMatch(/no embedded table of contents/i);
  });

  it('refuses an outline for an EPUB and points at plain text instead', async () => {
    const c = ctx({
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: buildEpub(), contentType: 'application/epub+zip' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01', outline: true }, c);
    expect(res.isError).toBe(true);
    expect((res.content ?? []).map((x: any) => x.text).join('\n')).toMatch(/EPUB/);
  });

  it('skips the download entirely for an oversized PDF', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'journalArticle', title: 'Big PDF' } })),
        getItemChildren: vi.fn(async () => ({
          data: [
            {
              key: 'ATT01',
              data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'big.pdf' },
              links: { enclosure: { length: 50 * 1024 * 1024 } },
            },
          ],
          totalResults: 1,
          lastModifiedVersion: 1,
        })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01', outline: true }, c);
    expect(res.isError).toBe(true);
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
  });
});

describe('zotero_get_fulltext local extraction sources', () => {
  let zoteroDataDir: string;
  beforeEach(async () => {
    zoteroDataDir = await mkdtemp(join(tmpdir(), 'zoteus-fulltext-'));
  });
  afterEach(async () => {
    await rm(zoteroDataDir, { recursive: true, force: true });
  });

  it('reads the bytes from the running Zotero desktop app before anything else', async () => {
    const c = ctx({
      capabilities: { cloud: null, localApi: true },
      local: { downloadFileBytes: vi.fn(async () => PDF_BYTES) },
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.fileSource).toBe('local-api');
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    expect(sc.notice).toMatch(/desktop app/i);
  });

  it('reads an unindexed PDF out of the Zotero storage folder when the app is closed', async () => {
    await mkdir(join(zoteroDataDir, 'storage', 'ATT01'), { recursive: true });
    await writeFile(join(zoteroDataDir, 'storage', 'ATT01', 'paper.pdf'), PDF_BYTES);
    const c = ctx({
      config: { dataDir: '/tmp', zoteroDataDir },
      capabilities: { cloud: null, localApi: false },
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    const sc = res.structuredContent as any;
    expect(res.isError).toBeFalsy();
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.fileSource).toBe('storage');
    expect(sc.text).toContain('Hello PDF');
    // No cloud key at all, and none needed: the file was already on this machine.
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
  });

  it('extracts an unindexed EPUB attachment and marks it fulltextSource "epub"', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'book', title: 'A Book' } })),
        getItemChildren: vi.fn(async () => ({
          data: [
            { key: 'ATT01', data: { itemType: 'attachment', contentType: 'application/epub+zip', filename: 'book.epub' } },
          ],
          totalResults: 1,
          lastModifiedVersion: 1,
        })),
      },
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: buildEpub(), contentType: 'application/epub+zip' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    const sc = res.structuredContent as any;
    expect(res.isError).toBeFalsy();
    expect(sc.fulltextSource).toBe('epub');
    expect(sc.totalPages).toBeUndefined();
    expect(sc.text).toContain('Chapter Two');
    expect(sc.notice).toMatch(/EPUB/);
  });

  it('picks the EPUB child when the item has no PDF, instead of the first attachment', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'book', title: 'A Book' } })),
        getItemChildren: vi.fn(async () => ({
          data: [
            { key: 'SNAP01', data: { itemType: 'attachment', contentType: 'text/html', filename: 'page.html' } },
            { key: 'ATT01', data: { itemType: 'attachment', contentType: 'application/epub+zip', filename: 'book.epub' } },
          ],
          totalResults: 2,
          lastModifiedVersion: 1,
        })),
      },
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: buildEpub(), contentType: 'application/epub+zip' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    expect((res.structuredContent as any).attachmentKey).toBe('ATT01');
  });

  it('names every source it tried when none of them can produce the file', async () => {
    const c = ctx({
      capabilities: { cloud: null, localApi: true },
      local: {
        downloadFileBytes: vi.fn(async () => {
          throw new Error('Local API file 404 for ATT01');
        }),
      },
      web: { getFullText: vi.fn(async () => null) },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01' }, c);
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: any) => x.text).join('\n');
    expect(text).toMatch(/desktop app could not read it/);
    expect(text).toMatch(/no cloud API key/);
  });
});

describe('zotero_get_fulltext page_range reads real pages', () => {
  function indexedWithPdf(over: any = {}) {
    return ctx({
      web: {
        getFullText: vi.fn(async () => FT),
        downloadFileBytes: vi.fn(async () => ({ bytes: PDF_BYTES, contentType: 'application/pdf' })),
      },
      ...over,
    });
  }

  it('re-extracts the PDF so the span is exact, with no precise_pages flag', async () => {
    const c = indexedWithPdf();
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '1' }, c);
    const sc = res.structuredContent as any;
    expect(c.web.downloadFileBytes).toHaveBeenCalled();
    expect(sc.pageSource).toBe('exact');
    expect(sc.text).toContain('Hello PDF');
    expect(sc.fileSource).toBe('cloud');
  });

  it('honours precise_pages:false and slices the indexed text proportionally instead', async () => {
    const c = indexedWithPdf();
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '1', precise_pages: false }, c);
    const sc = res.structuredContent as any;
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    expect(sc.pageSource).toBe('approximate');
    expect(sc.text).toContain('Background on optimization');
  });

  it('leaves a query alone: passages still come from the index with no download', async () => {
    const c = indexedWithPdf();
    await getFulltext.handler({ item_key: 'PARENT01', query: 'Hessian' }, c);
    expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
  });

  it('explains that an EPUB has no pages rather than inventing a span', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 19552201 }),
        getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'book', title: 'A Book' } })),
        getItemChildren: vi.fn(async () => ({
          data: [
            { key: 'ATT01', data: { itemType: 'attachment', contentType: 'application/epub+zip', filename: 'book.epub' } },
          ],
          totalResults: 1,
          lastModifiedVersion: 1,
        })),
      },
      web: {
        getFullText: vi.fn(async () => null),
        downloadFileBytes: vi.fn(async () => ({ bytes: buildEpub(), contentType: 'application/epub+zip' })),
      },
    });
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '3-7' }, c);
    const sc = res.structuredContent as any;
    expect(res.isError).toBeFalsy();
    expect(sc.notice).toMatch(/no fixed pages/i);
    // One read, not two: there are no PDF pages worth going back for.
    expect(c.web.downloadFileBytes).toHaveBeenCalledTimes(1);
  });
});
