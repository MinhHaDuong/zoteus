import { DROPLIST_DF_RATIO, pruneByDocumentFrequency, tokenize } from './tokenize.js';

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

/**
 * A compact in-memory BM25 index over short documents/passages.
 *
 * Documents are held by id rather than in a list so a single passage can be removed in
 * place: an incremental update re-indexes only the items that changed, and leaving stale
 * postings behind would keep a deleted item findable and skew every idf in the index.
 */
export class BM25Index {
  private readonly docs = new Map<string, Doc>();
  private readonly df = new Map<string, number>();
  private totalLength = 0;
  /**
   * Terms this index's own corpus says are too common to send, memoised until the corpus
   * moves. This backend needs no derivation step and stores nothing: it already keeps `df`
   * for scoring, so the same rule the SQLite backend pays a vocabulary scan for is a walk
   * over a map that is always current — including for an index just reloaded from disk,
   * which re-derives its postings anyway.
   */
  private common: Set<string> | undefined;

  constructor(
    private readonly k1 = 1.5,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  addDoc(id: string, text: string): void {
    // Re-adding an id replaces it: the caller's ids are content-derived, so a re-chunked
    // item reuses them and two copies of the same passage would double its term counts.
    this.removeDoc(id);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    this.docs.set(id, { id, tokens, length: tokens.length, tf });
    this.totalLength += tokens.length;
    this.common = undefined;
  }

  /** Remove one document and its postings. Returns false when the id was not indexed. */
  removeDoc(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    for (const term of doc.tf.keys()) {
      const n = (this.df.get(term) ?? 0) - 1;
      if (n > 0) this.df.set(term, n);
      else this.df.delete(term);
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
    this.common = undefined;
    return true;
  }

  /** Terms appearing in at least DROPLIST_DF_RATIO of the documents. */
  commonTerms(): ReadonlySet<string> {
    if (!this.common) {
      const floor = this.docs.size * DROPLIST_DF_RATIO;
      this.common = new Set<string>();
      for (const [term, n] of this.df) if (n >= floor) this.common.add(term);
    }
    return this.common;
  }

  search(query: string, topK = 10): BM25Hit[] {
    if (this.docs.size === 0) return [];
    // Deduplicated BEFORE pruning: the fallback counts surviving terms, and a repeated
    // word would otherwise buy the query a survivor it does not have.
    const qTerms = pruneByDocumentFrequency([...new Set(tokenize(query))], this.commonTerms());
    const avgdl = this.totalLength / this.docs.size;
    const N = this.docs.size;

    const hits: BM25Hit[] = [...this.docs.values()].map((doc) => {
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
