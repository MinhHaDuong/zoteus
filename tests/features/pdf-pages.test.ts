import { describe, it, expect } from 'vitest';
import {
  locatePage,
  extractPdfPages,
  extractPdfOutline,
  DEFAULT_PRECISE_MAX_BYTES,
} from '../../src/features/fulltext/pdf-pages.js';

// A tiny, valid PDF with one text-bearing page (pdfjs recovers the xref by object indexing).
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

describe('locatePage', () => {
  const pages = ['title and intro', 'methods the hessian is decomposed here', 'references'];
  it('returns the 1-based page whose text contains the passage head', () => {
    expect(locatePage(pages, 'The Hessian is decomposed')).toBe(2);
  });
  it('returns undefined when no page matches', () => {
    expect(locatePage(pages, 'completely unrelated phrase xyzzy')).toBeUndefined();
  });
});

describe('extractPdfPages', () => {
  it('returns null when the optional dependency is unavailable (degrade, not throw)', async () => {
    // An empty buffer + absent/failing pdfjs must resolve to null, never throw.
    const result = await extractPdfPages(new Uint8Array([1, 2, 3])).catch(() => 'THREW');
    expect(result === null || Array.isArray(result)).toBe(true);
    expect(result).not.toBe('THREW');
  });
});

describe('extractPdfPages size guard (OOM defense for small hosts)', () => {
  it('DEFAULT_PRECISE_MAX_BYTES is a sane cap (1MB..64MB)', () => {
    expect(DEFAULT_PRECISE_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_PRECISE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('parses a small PDF when under the byte cap', async () => {
    const pages = await extractPdfPages(PDF_BYTES, { maxBytes: 1_000_000 });
    expect(Array.isArray(pages)).toBe(true);
    expect((pages ?? []).join(' ')).toContain('Hello');
  });

  it('refuses (returns null) when bytes exceed the cap — never parses, never OOMs', async () => {
    const pages = await extractPdfPages(PDF_BYTES, { maxBytes: 50 });
    expect(pages).toBeNull();
  });
});

// Two pages plus an /Outlines tree: one chapter with a nested section, then a second
// chapter, so both the nesting level and the page each heading points at are observable.
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
8 0 obj << /Title (Chapter One) /Parent 6 0 R /Next 9 0 R /First 11 0 R /Last 11 0 R /Count 1 /Dest [3 0 R /XYZ 0 200 0] >> endobj
9 0 obj << /Title (Chapter Two) /Parent 6 0 R /Prev 8 0 R /Dest [7 0 R /XYZ 0 200 0] >> endobj
10 0 obj << /Length 43 >> stream
BT /F1 24 Tf 20 100 Td (Second page) Tj ET
endstream endobj
11 0 obj << /Title (Section 1.1) /Parent 8 0 R /Dest [7 0 R /XYZ 0 100 0] >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
const OUTLINED_BYTES = new TextEncoder().encode(OUTLINED_PDF);

describe('extractPdfOutline', () => {
  it('returns the table of contents depth-first, with each heading on its own page', async () => {
    const outline = await extractPdfOutline(OUTLINED_BYTES);
    if (outline === null) return; // pdfjs-dist is optional; absent means degrade, not fail
    expect(outline).toEqual([
      { title: 'Chapter One', page: 1, level: 0 },
      { title: 'Section 1.1', page: 2, level: 1 },
      { title: 'Chapter Two', page: 2, level: 0 },
    ]);
  });

  it('returns an empty list for a PDF that carries no outline, not null', async () => {
    const outline = await extractPdfOutline(PDF_BYTES);
    if (outline === null) return; // pdfjs-dist absent
    expect(outline).toEqual([]);
  });

  it('returns null (degrade, never throws) when the bytes are not a parseable PDF', async () => {
    const result = await extractPdfOutline(new Uint8Array([1, 2, 3])).catch(() => 'THREW');
    expect(result).toBeNull();
  });

  it('refuses above the byte cap without parsing anything', async () => {
    expect(await extractPdfOutline(OUTLINED_BYTES, { maxBytes: 50 })).toBeNull();
  });
});
