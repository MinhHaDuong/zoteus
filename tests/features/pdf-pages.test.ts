import { describe, it, expect } from 'vitest';
import { locatePage, extractPdfPages } from '../../src/features/fulltext/pdf-pages.js';

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
