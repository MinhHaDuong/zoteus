export interface VectorHit {
  id: string;
  score: number;
}

interface Entry {
  id: string;
  vector: number[];
}

/** Brute-force cosine-similarity vector store (fine for a personal library). */
export class VectorStore {
  private entries: Entry[] = [];
  /** Position of each id in `entries`, so a delete does not scan the store. */
  private at = new Map<string, number>();

  get size(): number {
    return this.entries.length;
  }

  /** Width of the stored vectors (undefined when empty). Their embedder's fingerprint. */
  get dimension(): number | undefined {
    return this.entries[0]?.vector.length;
  }

  add(id: string, vector: number[]): void {
    const i = this.at.get(id);
    if (i !== undefined) {
      this.entries[i] = { id, vector };
      return;
    }
    this.at.set(id, this.entries.length);
    this.entries.push({ id, vector });
  }

  /**
   * Remove one vector. The last entry is swapped into the hole rather than splicing, so an
   * update that drops a deleted item stays O(1) per vector; nothing here depends on order.
   */
  remove(id: string): boolean {
    const i = this.at.get(id);
    if (i === undefined) return false;
    const last = this.entries.pop()!;
    if (i < this.entries.length) {
      this.entries[i] = last;
      this.at.set(last.id, i);
    }
    this.at.delete(id);
    return true;
  }

  search(query: number[], topK = 10): VectorHit[] {
    const qn = norm(query);
    if (qn === 0) return [];
    const hits = this.entries.map((e) => ({ id: e.id, score: cosine(query, e.vector, qn) }));
    return hits
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  toJSON(): Entry[] {
    return this.entries;
  }

  static fromJSON(entries: Entry[]): VectorStore {
    const vs = new VectorStore();
    vs.entries = entries ?? [];
    vs.entries.forEach((e, i) => vs.at.set(e.id, i));
    return vs;
  }
}

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/**
 * Cosine of the query against one stored vector: one traversal, two accumulators, where
 * `norm(b)` followed by a dot-product loop walked every entry twice. Same products summed
 * in the same order, so the scores are bit-identical; the tail loop preserves the old
 * reading of a shorter query, which covered all of `b` for the norm but stopped at the
 * shorter operand for the product. The SQLite backend carries the same shape, and gains
 * more from it — there the shared `norm()` was polymorphic besides.
 */
export function cosine(a: number[], b: number[], an: number): number {
  if (a.length < b.length) return cosineUneven(a, b, an);
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    dot += a[i]! * x;
    sq += x * x;
  }
  const bn = Math.sqrt(sq);
  if (bn === 0) return 0;
  return dot / (an * bn);
}

/** The width-mismatch case, out of line so the hot path stays small. See sqlite-index.ts. */
function cosineUneven(a: number[], b: number[], an: number): number {
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  for (let i = 0; i < b.length; i++) sq += b[i]! * b[i]!;
  const bn = Math.sqrt(sq);
  if (bn === 0) return 0;
  return dot / (an * bn);
}
