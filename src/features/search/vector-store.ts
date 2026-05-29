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

  get size(): number {
    return this.entries.length;
  }

  add(id: string, vector: number[]): void {
    this.entries.push({ id, vector });
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
