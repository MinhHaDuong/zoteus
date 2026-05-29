import { tokenize } from './tokenize.js';

interface Doc {
  id: string;
  tokens: string[];
  length: number;
  tf: Map<string, number>;
}

export interface BM25Hit {
  id: string;
  score: number;
}

/** A compact in-memory BM25 index over short documents/passages. */
export class BM25Index {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.length;
  }

  addDoc(id: string, text: string): void {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    this.docs.push({ id, tokens, length: tokens.length, tf });
    this.totalLength += tokens.length;
  }

  search(query: string, topK = 10): BM25Hit[] {
    if (this.docs.length === 0) return [];
    const qTerms = [...new Set(tokenize(query))];
    const avgdl = this.totalLength / this.docs.length;
    const N = this.docs.length;

    const hits: BM25Hit[] = this.docs.map((doc) => {
      let score = 0;
      for (const term of qTerms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const n = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom = f + this.k1 * (1 - this.b + (this.b * doc.length) / avgdl);
        score += idf * ((f * (this.k1 + 1)) / denom);
      }
      return { id: doc.id, score };
    });

    return hits
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
