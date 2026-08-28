import { describe, it, expect } from 'vitest';
import { compactPassage, charsToRects, locatePassages } from '../../src/features/fulltext/pdf-locate.js';

// One page, one line of Helvetica text, so pdfjs reports real geometry to anchor against.
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

describe('compactPassage', () => {
  it('ignores what two renderings of the same passage disagree about', () => {
    // Line wraps, hyphenation across a break, case, and smart punctuation.
    expect(compactPassage('robot-\ncentric  ELEVATION')).toBe('robotcentricelevation');
    expect(compactPassage('the “map’s” edge')).toBe('the"map\'s"edge');
    // Ligatures and accents set as separate glyphs must reduce to their letters, because
    // one extractor emits `ﬁ`/`hˆi` where another emits `fi`/`ĥi`.
    expect(compactPassage('ﬁeld')).toBe(compactPassage('field'));
    expect(compactPassage('hˆi')).toBe(compactPassage('hi'));
    expect(compactPassage('ĥ')).toBe('h');
  });
});

describe('charsToRects', () => {
  const line = (y: number, from: number, n: number, h = 10) =>
    Array.from({ length: n }, (_, i) => ({ ch: 'x', x0: from + i * 5, x1: from + i * 5 + 5, y0: y, y1: y + h }));

  it('emits one rect per visual line', () => {
    const chars = [...line(100, 50, 4), ...line(88, 50, 3)];
    expect(charsToRects(chars, 0, chars.length - 1)).toEqual([
      [50, 100, 70, 110],
      [50, 88, 65, 98],
    ]);
  });

  it('widens a line for a superscript instead of splitting it', () => {
    // A raised, smaller glyph still overlaps its line's band: the reader keeps one rect.
    const chars = [...line(100, 50, 2), { ch: '2', x0: 60, x1: 63, y0: 105, y1: 112 }, ...line(100, 63, 2)];
    expect(charsToRects(chars, 0, chars.length - 1)).toEqual([[50, 100, 73, 112]]);
  });

  it('skips virtual break characters, which position text but are never drawn', () => {
    const chars = [...line(100, 50, 2), { ch: '\n', x0: 60, x1: 60, y0: 100, y1: 110, virtual: true }];
    expect(charsToRects(chars, 0, chars.length - 1)).toEqual([[50, 100, 60, 110]]);
  });
});

describe('locatePassages', () => {
  it('anchors a passage to rects inside the page it sits on', async () => {
    const hits = await locatePassages(PDF_BYTES, [{ text: 'Hello PDF' }]);
    if (hits === null) return; // pdfjs-dist is optional; absent means degrade, not fail
    expect(hits).toHaveLength(1);
    const [anchor] = hits[0]!;
    expect(anchor).toBeDefined();
    expect(anchor!.pageIndex).toBe(0);
    expect(anchor!.pageHeight).toBe(200);
    const [x1, y1, x2, y2] = anchor!.rects[0]!;
    // Drawn at (20,100) at 24pt: the rect must start there and stay on the page.
    expect(x1).toBeCloseTo(20, 0);
    expect(x2).toBeGreaterThan(x1!);
    expect(y1!).toBeLessThan(100);
    expect(y2!).toBeGreaterThan(100);
    expect(y2!).toBeLessThanOrEqual(200);
  });

  it('matches across the wrapping and case the extractor does not preserve', async () => {
    const hits = await locatePassages(PDF_BYTES, [{ text: '  hello\n  pdf  ' }]);
    if (hits === null) return;
    expect(hits[0]!.length).toBe(1);
  });

  it('returns an empty result for a passage that is not there, and honours a page filter', async () => {
    const hits = await locatePassages(PDF_BYTES, [{ text: 'nowhere in this document' }, { text: 'Hello', pageIndex: 4 }]);
    if (hits === null) return;
    expect(hits[0]).toEqual([]);
    expect(hits[1]).toEqual([]);
  });

  it('degrades to null rather than throwing on an unparseable or oversized PDF', async () => {
    await expect(locatePassages(new Uint8Array([1, 2, 3]), [{ text: 'x' }])).resolves.toBeNull();
    await expect(locatePassages(PDF_BYTES, [{ text: 'Hello' }], { maxBytes: 10 })).resolves.toBeNull();
  });
});
