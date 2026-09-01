import { highDfMinimum, MIN_DERIVATION_PASSAGES, MIN_MATCH_TERMS, pruneTerms } from './query-terms.js';
import { indexText, tokenize } from './tokenize.js';

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
  /** Cleared whenever `df` moves; see `commonTerms`. */
  private common: Set<string> | undefined;
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
    // The same augmentation the SQLite side indexes: the words as written, plus the
    // mark-stripped form of any that carry marks, so an unaccented query reaches an
    // accented document on this backend too. Parity here is not decorative — the two
    // backends are asserted to answer identically.
    const tokens = tokenize(indexText(text));
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
    this.docs.set(id, { id, length: tokens.length, tf });
    this.common = undefined;
    this.totalLength += tokens.length;
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

  /**
   * Whether a term appears in enough documents to be worth pruning off a query.
   *
   * This backend needs no stored droplist and no cadence rule, unlike the SQLite one: `df`
   * is already exact and already resident, and it is rebuilt from the raw passage text on
   * every load exactly as the postings are. So the answer is live by construction — an
   * index written before this existed adopts it the moment it is read back, with no
   * migration and nothing to recompute.
   *
   * Query side only. `addDoc` keeps indexing every term, because dropping them from the
   * documents would both destroy the df this reads and make the degeneracy fallback — which
   * exists precisely to search on those terms — unable to match anything.
   */
  isHighDf(term: string): boolean {
    return this.commonTerms().has(term);
  }

  /**
   * The terms this backend considers common, computed once per change to the index.
   *
   * Memoised because `search` asks per query term and the answer only moves when a document
   * is added or removed. Guarded the same way the SQLite side guards its stored list: a set
   * naming every term in the vocabulary is not a list of common terms, it is the vocabulary,
   * and pruning by it empties every query. That happens whenever the corpus is too small for
   * a document frequency to mean anything — three documents put the bar at one.
   */
  private commonTerms(): ReadonlySet<string> {
    if (!this.common) {
      const set = new Set<string>();
      if (this.docs.size >= MIN_DERIVATION_PASSAGES) {
        const floor = highDfMinimum(this.docs.size);
        for (const [term, n] of this.df) if (n >= floor) set.add(term);
      }
      this.common = set.size >= this.df.size ? new Set<string>() : set;
    }
    return this.common;
  }

  search(query: string, topK = 10): BM25Hit[] {
    if (this.docs.size === 0) return [];
    const qTerms = pruneTerms([...new Set(tokenize(query))], (t) => this.isHighDf(t), MIN_MATCH_TERMS, 'raw');
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
