import { pruneTerms } from './query-terms.js';
import { accentKey, isStopword, tokenize } from './tokenize.js';

interface Doc {
  id: string;
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
  /**
   * folded form → the accented spellings currently in the vocabulary, so an unaccented
   * query term can be expanded to the variants the index actually holds — the same
   * asymmetric expansion the SQLite backend runs through its `accent_variants` table
   * (see `expandTerm` there for the direction and why). Maintained beside `df`, and
   * pruned with it, so a deleted document's spellings do not stay searchable.
   */
  private readonly variants = new Map<string, Set<string>>();
  private totalLength = 0;

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
    for (const term of tf.keys()) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
      const folded = accentKey(term);
      if (folded !== term && folded.length > 1) {
        let set = this.variants.get(folded);
        if (!set) this.variants.set(folded, (set = new Set()));
        set.add(term);
      }
    }
    this.docs.set(id, { id, length: tokens.length, tf });
    this.totalLength += tokens.length;
  }

  /** Remove one document and its postings. Returns false when the id was not indexed. */
  removeDoc(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    for (const term of doc.tf.keys()) {
      const n = (this.df.get(term) ?? 0) - 1;
      if (n > 0) this.df.set(term, n);
      else {
        this.df.delete(term);
        // Its last occurrence is gone, so the spelling leaves the expansion map too.
        const folded = accentKey(term);
        const set = this.variants.get(folded);
        if (set?.delete(term) && set.size === 0) this.variants.delete(folded);
      }
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
    return true;
  }

  search(query: string, topK = 10): BM25Hit[] {
    if (this.docs.size === 0) return [];
    const pruned = pruneTerms([...new Set(tokenize(query))], isStopword);
    // The same asymmetric, dominance-gated expansion as the SQLite backend's
    // `expandTerm` (the direction and the gate are explained there): an unaccented term
    // also scores the accented spellings the vocabulary holds — but only when those
    // spellings outweigh the typed one in this corpus. An accented term runs as typed.
    const qTerms = [
      ...new Set(
        pruned.flatMap((t) => {
          if (accentKey(t) !== t) return [t];
          const vs = [...(this.variants.get(t) ?? [])];
          if (!vs.length) return [t];
          const variantsDf = vs.reduce((s, v) => s + (this.df.get(v) ?? 0), 0);
          return variantsDf > (this.df.get(t) ?? 0) ? [t, ...vs] : [t];
        }),
      ),
    ];
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
