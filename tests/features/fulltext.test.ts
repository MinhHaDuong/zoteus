import { describe, it, expect } from 'vitest';
import { approxPage, findSection, rankPassages } from '../../src/features/fulltext/passages.js';

describe('approxPage', () => {
  it('maps a char offset proportionally to a clamped 1-based page', () => {
    expect(approxPage(0, 1000, 10)).toBe(1);
    expect(approxPage(550, 1000, 10)).toBe(6);
    expect(approxPage(999, 1000, 10)).toBe(10);
  });
  it('returns undefined without page totals', () => {
    expect(approxPage(10, 1000, undefined)).toBeUndefined();
    expect(approxPage(10, 0, 10)).toBeUndefined();
  });
});

describe('findSection', () => {
  it('finds the nearest preceding numbered heading', () => {
    const doc = 'Intro text.\n4.2 Newton step\nThe Hessian is decomposed into blocks.';
    const at = doc.indexOf('The Hessian');
    expect(findSection(doc, at)).toBe('4.2 Newton step');
  });
});

describe('rankPassages', () => {
  const content =
    'Background on optimization. '.repeat(20) +
    'The Hessian is decomposed into a Gauss-Newton term plus a remainder. '.repeat(3) +
    'Unrelated appendix material. '.repeat(20);

  it('returns query-relevant passages with offsets and approx pages (BM25 only)', async () => {
    const passages = await rankPassages({ content, query: 'Hessian decomposed', maxPassages: 2, totalPages: 10 });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0].text.toLowerCase()).toContain('hessian');
    expect(content.slice(passages[0].charStart, passages[0].charEnd)).toBe(passages[0].text);
    expect(passages[0].pageApprox).toBeGreaterThanOrEqual(1);
    expect(passages[0].pageApprox).toBeLessThanOrEqual(10);
  });

  it('still ranks when an embedder is supplied (fused)', async () => {
    const embed = async (texts: string[]) => texts.map((t) => [t.length % 7, (t.match(/hessian/gi)?.length ?? 0)]);
    const passages = await rankPassages({ content, query: 'Hessian decomposed', maxPassages: 2, embed });
    expect(passages[0].text.toLowerCase()).toContain('hessian');
  });
});
