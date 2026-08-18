import { describe, it, expect } from 'vitest';
import { normalizePosition, buildSortIndex } from '../../src/tools/annotate.js';

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
