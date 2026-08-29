import { describe, it, expect } from 'vitest';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { cosine as memoryCosine } from '../../src/features/search/vector-store.js';

/**
 * Fusing the cosine loop is a performance change that must not be a behaviour change: the
 * scan now accumulates the dot product and the row's squared norm in one traversal, where
 * it used to call `norm(b)` and then loop again. The claim made in both call sites is that
 * the scores are bit-identical — the same products summed in the same order — so no index
 * needs rebuilding and no ranking moves.
 *
 * A claim of that shape is worth nothing asserted. These cases run the previous
 * implementation, verbatim, beside the current one and demand exact equality, including
 * the sign of zero and the propagation of NaN. `toBe` is `Object.is`, which is the right
 * comparison here precisely because it does not treat -0 and 0 as interchangeable.
 */

/** The implementation as it stood before the fusion, kept here as the reference. */
function referenceNorm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}
function referenceCosine(a: number[], b: ArrayLike<number>, an: number): number {
  const bn = referenceNorm(b);
  if (bn === 0) return 0;
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot / (an * bn);
}

/** A small LCG, so the fixture is the same on every machine and every run. */
function vectors(seed: number, dim: number, count: number): number[][] {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: count }, () => Array.from({ length: dim }, () => next() - 0.5));
}

/**
 * Deliberately NOT unit vectors. The embedding providers in use return normalized vectors,
 * which would make the norm a constant 1 and hide any error in how it is now accumulated;
 * the magnitudes here span eight orders of magnitude so that the division actually varies.
 */
function scaled(vs: number[][]): number[][] {
  return vs.map((v, i) => v.map((x) => x * 10 ** (i - 4)));
}

describe('the fused cosine is bit-identical to the two-pass one it replaces', () => {
  const dim = 96;
  const [query] = vectors(7, dim, 1) as [number[]];
  const qn = referenceNorm(query);
  const rows = scaled(vectors(11, dim, 9));

  it('agrees on ordinary vectors, over magnitudes that make the norm matter', () => {
    for (const row of rows) {
      expect(memoryCosine(query, row, qn)).toBe(referenceCosine(query, row, qn));
    }
  });

  it('agrees on a zero vector, where the norm divides by nothing', () => {
    const zero = new Array<number>(dim).fill(0);
    expect(memoryCosine(query, zero, qn)).toBe(referenceCosine(query, zero, qn));
    expect(memoryCosine(query, zero, qn)).toBe(0);
  });

  /**
   * Unreachable through `query()`, which drops stale vectors when the query's width stops
   * matching the index's — but an index holding two generations of vectors reaches it, and
   * the old code read the two widths asymmetrically: `norm(b)` covered all of `b` while the
   * dot product stopped at the shorter operand. The tail loop in the fused version exists
   * only to preserve that reading, so this is the case that would catch its absence.
   */
  it('agrees when the query is shorter than the stored vector', () => {
    const short = query.slice(0, dim - 20);
    const sn = referenceNorm(short);
    for (const row of rows) {
      expect(memoryCosine(short, row, sn)).toBe(referenceCosine(short, row, sn));
    }
  });

  it('agrees when the stored vector is shorter than the query', () => {
    for (const row of rows) {
      const short = row.slice(0, dim - 20);
      expect(memoryCosine(query, short, qn)).toBe(referenceCosine(query, short, qn));
    }
  });

  it('propagates a non-finite coordinate the same way', () => {
    const withNaN = [...rows[0]!];
    withNaN[3] = Number.NaN;
    expect(memoryCosine(query, withNaN, qn)).toBe(referenceCosine(query, withNaN, qn));
  });
});

/**
 * The SQLite backend reads its vectors as Float32Array views over the stored BLOB, so its
 * cosine is a separate function over a separate operand type — and it is the one that also
 * shed the polymorphic `norm()` call. It is exercised through the same reference.
 *
 * The module require()s `node:sqlite` at load, so it is imported dynamically and skipped
 * where the runtime has no SQLite, exactly as the backend itself falls back rather than
 * refusing to start.
 */
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;

describe('the SQLite backend cosine, over Float32 rows', () => {
  const dim = 96;
  const [query] = vectors(23, dim, 1) as [number[]];
  const qn = referenceNorm(query);
  const rows = scaled(vectors(29, dim, 9)).map((v) => Float32Array.from(v));

  sqliteIt('agrees with the two-pass implementation on every row', async () => {
    const { cosine } = await import('../../src/features/search/sqlite-index.js');
    for (const row of rows) {
      expect(cosine(query, row, qn)).toBe(referenceCosine(query, row, qn));
    }
  });

  sqliteIt('agrees on a zero row and on mismatched widths', async () => {
    const { cosine } = await import('../../src/features/search/sqlite-index.js');
    const zero = new Float32Array(dim);
    expect(cosine(query, zero, qn)).toBe(referenceCosine(query, zero, qn));

    const short = query.slice(0, dim - 20);
    const sn = referenceNorm(short);
    for (const row of rows) {
      expect(cosine(short, row, sn)).toBe(referenceCosine(short, row, sn));
    }
  });
});
