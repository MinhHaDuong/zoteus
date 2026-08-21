export interface VectorHit {
  id: string;
  score: number;
}

/**
 * One stored vector. Exported because it is the currency of the JSON snapshot
 * (`SearchIndex.toJSON().vectors`), which now travels through the PassageStore port
 * rather than reaching into this class directly.
 */
export interface VectorEntry {
  id: string;
  vector: number[];
}

/** Brute-force cosine-similarity vector store (fine for a personal library). */
export class VectorStore {
  private entries: VectorEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  add(id: string, vector: number[]): void {
    this.entries.push({ id, vector });
  }

  /**
   * Drop every vector whose id is in `ids`. Added for PassageStore.deleteByItem: a vector
   * that outlives its passage is a hit pointing at nothing, and SearchIndex.query drops
   * such an id silently — a lost result with no trace of why.
   *
   * One filtering pass rather than a splice per id: the caller removes a whole item's
   * passages at once, so the linear scan is paid once per item, not once per passage.
   */
  deleteMany(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    this.entries = this.entries.filter((e) => !ids.has(e.id));
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

  toJSON(): VectorEntry[] {
    return this.entries;
  }

  static fromJSON(entries: VectorEntry[]): VectorStore {
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
