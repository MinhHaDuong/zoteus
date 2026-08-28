import { describe, it, expect, vi } from 'vitest';
import annotate, { normalizePosition, buildSortIndex } from '../../src/tools/annotate.js';

describe('annotate helpers', () => {
  it('normalizes shorthand [page, rect] positions', () => {
    const pos = normalizePosition([3, [10, 20, 30, 40]]);
    expect(pos).toEqual({ pageIndex: 3, rects: [[10, 20, 30, 40]] });
  });

  it('normalizes Zotero-form objects and JSON strings', () => {
    const obj = { pageIndex: 4, rects: [[1, 2, 3, 4], [5, 6, 7, 8]] };
    expect(normalizePosition(obj)).toEqual(obj);
    expect(normalizePosition(JSON.stringify(obj))).toEqual(obj);
  });

  it('falls back to a page-only position and drops bad rects', () => {
    expect(normalizePosition(undefined, 7)).toEqual({ pageIndex: 7, rects: [] });
    expect(normalizePosition({ pageIndex: 1, rects: [[1, 2, 3]] })).toEqual({ pageIndex: 1, rects: [] });
    expect(normalizePosition('not json')).toBeNull();
  });

  it('builds reader-compatible sort indexes', () => {
    // Mirrors the real annotation "00004|001235|00636" shape (A4-ish page height).
    const rects = [[70.944, 196.106, 297.615, 205.162]];
    expect(buildSortIndex(4, rects, { offset: 1235, pageHeight: 841.162 })).toBe('00004|001235|00636');
    expect(buildSortIndex(0, [], {})).toBe('00000|000000|00000');
    expect(buildSortIndex(12, [[0, 10, 100, 50]], { pageHeight: 792 })).toBe('00012|000000|00742');
  });
});

describe('zotero_annotate action:"delete"', () => {
  it('trashes annotations by flag rather than erasing them via the local API DELETE', async () => {
    const setDeleted = vi.fn(async () => ({
      successful: [{ index: 0, key: 'ANN1', version: 4 }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 4,
    }));
    const deleteItems = vi.fn(async () => undefined);
    const ctx: any = {
      capabilities: { cloud: null, localApi: true },
      localWrites: { setDeleted, deleteItems },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    };
    const res = await annotate.handler({ action: 'delete', annotation_keys: ['ANN1'] }, ctx);
    expect(setDeleted).toHaveBeenCalledWith(['ANN1'], 1);
    expect(deleteItems).not.toHaveBeenCalled();
    expect(res.structuredContent?.trashed).toEqual(['ANN1']);
  });
});

// One page of Helvetica, so the anchoring path runs against real pdfjs geometry.
const MINIMAL_PDF = new TextEncoder().encode(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 41 >> stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`);

function anchoringCtx(overrides: any = {}) {
  const writeItems = vi.fn(async (items: any[]) => ({
    successful: items.map((_, i) => ({ index: i, key: `ANN${i}`, version: 1 })),
    unchanged: [],
    failed: [],
    newLibraryVersion: 1,
  }));
  const ctx: any = {
    capabilities: { cloud: null, localApi: true },
    config: { local: 'auto' },
    localWrites: { writeItems },
    local: {
      downloadFileBytes: vi.fn(async () => MINIMAL_PDF),
      getItemChildren: vi.fn(async () => ({ data: [] })),
    },
    router: {
      getItem: vi.fn(async () => ({ data: { itemType: 'attachment', key: 'ATT1', contentType: 'application/pdf' } })),
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return { ctx, writeItems };
}

describe('zotero_annotate anchors a highlight from its text', () => {
  it('computes page rects for a passage given without a position', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', comment: 'from text alone' }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    const [written] = writeItems.mock.calls[0]![0] as any[];
    const pos = JSON.parse(written.annotationPosition);
    expect(pos.pageIndex).toBe(0);
    expect(pos.rects).toHaveLength(1);
    // Text is drawn at x=20 on a 200pt page: the rect must sit there, not at a made-up origin.
    expect(pos.rects[0][0]).toBeCloseTo(20, 0);
    expect(pos.rects[0][2]).toBeGreaterThan(pos.rects[0][0]);
    expect(written.annotationText).toBe('Hello PDF');
    // The sort index must come from the located offset and real page height, not from zeros.
    expect(written.annotationSortIndex).toMatch(/^00000\|\d{6}\|\d{5}$/);
    expect(res.structuredContent?.anchoredFromText).toBe(1);
  });

  it('refuses to guess when the passage is not in the PDF, and writes nothing', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'a passage this PDF does not contain' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('passage not found');
    expect(writeItems).not.toHaveBeenCalled();
  });

  it('leaves an explicitly positioned highlight alone and never fetches the PDF', async () => {
    const { ctx, writeItems } = anchoringCtx();
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF', position: [2, [1, 2, 3, 4]] }] },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(ctx.local.downloadFileBytes).not.toHaveBeenCalled();
    const [written] = writeItems.mock.calls[0]![0] as any[];
    expect(JSON.parse(written.annotationPosition)).toEqual({ pageIndex: 2, rects: [[1, 2, 3, 4]] });
  });

  it('explains itself when the PDF cannot be read at all', async () => {
    const { ctx, writeItems } = anchoringCtx();
    ctx.local.downloadFileBytes = vi.fn(async () => { throw new Error('no stored copy'); });
    const res = await annotate.handler(
      { parent: 'ATT1', annotations: [{ type: 'highlight', text: 'Hello PDF' }] },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('the PDF could not be read');
    expect(writeItems).not.toHaveBeenCalled();
  });
});
