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

function cosine(a: number[], b: number[], an: number): number {
  const bn = norm(b);
  if (bn === 0) return 0;
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot / (an * bn);
}
