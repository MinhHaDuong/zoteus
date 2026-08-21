import { BM25Index } from './bm25.js';
import { VectorStore, type VectorEntry, type VectorHit } from './vector-store.js';

/**
 * One indexed passage: a chunk of an item's metadata or of its attachment body text.
 *
 * Ids are `<itemKey>#<n>` for metadata and `<itemKey>#f<n>` for full text, which is what
 * keeps the two namespaces from colliding (see SearchIndex.addFulltext).
 */
export interface ChunkRecord {
  id: string;
  itemKey: string;
  title: string;
  text: string;
  /** Absent for metadata passages, which keeps already-persisted index files loadable. */
  source?: 'fulltext';
}

/**
 * The passage store: everything SearchIndex needs from whatever holds the index. Extracted
 * so the resident JS structures (a BM25Index, a Map and a VectorStore, which is the memory
 * this work is about) can be swapped for on-disk SQLite tables without the orchestration
 * around it — build, embedding, status, persistence — knowing.
 *
 * Deliberately synchronous. SearchIndex.build/addOneItem are hot synchronous loops and
 * node:sqlite is a synchronous binding, so an async port would buy nothing and cost every
 * caller an await.
 */
export interface PassageStore {
  add(rec: ChunkRecord): void;
  /** Keyword hits, best first: score descending and strictly positive. */
  search(query: string, topK: number): Array<{ id: string; score: number }>;
  get(id: string): ChunkRecord | undefined;
  /** Every passage held, in insertion order — what toJSON serialises. */
  values(): Iterable<ChunkRecord>;
  /** Drop every passage belonging to one item, vectors included (the delta-rebuild path). */
  deleteByItem(itemKey: string): void;
  clear(): void;
  readonly size: number;

  /**
   * Item keys the store currently holds at least one passage for.
   *
   * Two callers, and both are the delta's: it is the set a library-wide `?format=versions`
   * map is diffed against to find the items Zotero no longer has, and it is what a
   * reopened index rebuilds `status().items` from — a count that otherwise reads 0 until
   * the next full build, however many passages are sitting on disk.
   *
   * Optional on the port because it is only worth asking of a store that can answer it
   * from an index rather than a scan; one that cannot omits it, and its owner falls back
   * to the set it keeps in the heap.
   */
  itemKeys?(): string[];

  /**
   * Items with at least one full-text passage, and how many such passages exist —
   * `status().fulltextItems` and `status().fulltextPassages`, recovered from the store
   * rather than from counters only a build in this very process could have incremented.
   *
   * Separate from `itemKeys` because a delta has to *recompute* both after dropping an
   * item: nothing in `deleteByItem`'s answer says how many of the passages it removed came
   * from an attachment body.
   */
  fulltextStats?(): { items: string[]; passages: number };
  /**
   * The items holding the most passages, largest first — how concentrated the index is
   * (ticket 0013).
   *
   * Optional, and deliberately NOT folded into `status()`. Measured on the real
   * 360 811-passage index the `GROUP BY item` costs 374 ms cold and 32-58 ms warm, and
   * `status()` is polled every few seconds for the whole length of a build, against the
   * very table the build is writing. So this is a question a caller asks when it wants the
   * answer, not a figure every status poll pays for.
   */
  itemPassageCounts?(limit: number): Array<{ item: string; title?: string; passages: number }>;

  /**
   * Attach an embedding to an already-added passage. Separate from `add` because the two
   * happen at different moments: passages are indexed as items arrive, vectors come back
   * later in batches of 32 from a provider that may be slow, remote, or absent.
   */
  setVector(id: string, v: number[]): void;
  /**
   * Nearest passages to `q`, **best first, score descending** — the same convention as
   * `search`, and for the same reason: SearchIndex fuses the two lists with RRF, which
   * ranks by list position and never looks at the magnitude. A store whose native answer
   * is a *distance* (ascending-best) converts it here, at the port boundary, exactly once.
   */
  vectorSearch(q: number[], topK: number): Array<{ id: string; score: number }>;
  /** How many passages carry an embedding — `status().vectors`, and `hasVectors`. */
  readonly vectorCount: number;

  /**
   * Why this store is holding no vectors, when something about it makes that impossible
   * (a missing optional dependency, say). Undefined when nothing is wrong.
   *
   * Optional on the port because it is a property of a *degraded* store: the resident one
   * has nothing that can go missing. Reported rather than thrown, following the
   * `embedderReason` precedent — an index that quietly stopped storing vectors is
   * indistinguishable from a library with nothing to say on the subject.
   */
  readonly vectorReason?: string;

  /**
   * Raw vectors, in passage order, for the JSON snapshot — the vector half of what
   * `values()` does for passages.
   *
   * Materialising every embedding in the JS heap is exactly what the SQLite backend exists
   * to avoid, so a store that keeps them on disk must not be asked this casually. That
   * guard lives one level up, in `SqliteSearchIndex.toJSON`, which refuses the whole
   * snapshot: the method stays on the port so the two stores remain interchangeable under
   * the parity suites, which round-trip a small index through JSON on both.
   */
  vectorEntries(): VectorEntry[];

  /**
   * Batch boundaries around a long run of `add` calls.
   *
   * They exist because the two backends mean different things by "save what we have so
   * far". For the JSON snapshot that is `IncrementalBuildOptions.persist`, which
   * re-serialises the whole index; for rows it is committing the open transaction and
   * opening the next. Same cadence, different act — so buildIncremental drives both at
   * the same points and neither backend has to know about the other. A store with no
   * transactions implements both as no-ops, which is what keeps the resident path
   * byte-for-byte what it was.
   */
  beginBatch(): void;
  commitBatch(): void;
}

/** The original resident implementation: a BM25 index and a VectorStore over a Map. */
export class MemoryPassageStore implements PassageStore {
  private bm25 = new BM25Index();
  private chunks = new Map<string, ChunkRecord>();
  private vectors = new VectorStore();

  add(rec: ChunkRecord): void {
    this.chunks.set(rec.id, rec);
    this.bm25.addDoc(rec.id, rec.text);
  }

  search(query: string, topK: number): Array<{ id: string; score: number }> {
    return this.bm25.search(query, topK);
  }

  get(id: string): ChunkRecord | undefined {
    return this.chunks.get(id);
  }

  values(): Iterable<ChunkRecord> {
    return this.chunks.values();
  }

  // The three vector methods delegate verbatim to the VectorStore that SearchIndex used to
  // own. Nothing about the resident path's ranking changes by moving the field one level
  // down: same class, same call order, same numbers.
  setVector(id: string, v: number[]): void {
    this.vectors.add(id, v);
  }

  vectorSearch(q: number[], topK: number): VectorHit[] {
    return this.vectors.search(q, topK);
  }

  get vectorCount(): number {
    return this.vectors.size;
  }

  vectorEntries(): VectorEntry[] {
    return this.vectors.toJSON();
  }

  itemKeys(): string[] {
    const keys = new Set<string>();
    for (const rec of this.chunks.values()) keys.add(rec.itemKey);
    return [...keys];
  }

  fulltextStats(): { items: string[]; passages: number } {
    const items = new Set<string>();
    let passages = 0;
    for (const rec of this.chunks.values()) {
      if (rec.source !== 'fulltext') continue;
      items.add(rec.itemKey);
      passages++;
    }
    return { items: [...items], passages };
  }

  deleteByItem(itemKey: string): void {
    const gone = new Set<string>();
    for (const [id, rec] of this.chunks) {
      if (rec.itemKey === itemKey) {
        this.chunks.delete(id);
        gone.add(id);
      }
    }
    if (gone.size === 0) return;
    this.vectors.deleteMany(gone);
    // BM25Index has no delete, and cannot cheaply have one: its document frequencies and
    // average document length are aggregates over every document it holds, so dropping one
    // passage means recomputing them. Rebuilding from the survivors is O(n) per call. That
    // is the honest cost — a stale df table silently mis-ranks every later query, which is
    // worse than a linear pass on the one code path (delta rebuild) that calls this.
    this.bm25 = new BM25Index();
    for (const rec of this.chunks.values()) this.bm25.addDoc(rec.id, rec.text);
  }

  clear(): void {
    this.bm25 = new BM25Index();
    this.chunks = new Map();
    this.vectors = new VectorStore();
  }

  // A Map, a BM25Index and a VectorStore have no notion of a durable write, so there is
  // nothing to open or close. Deliberately not `throw new Error('unsupported')`:
  // buildIncremental calls these unconditionally, and the default backend must go through
  // unchanged.
  beginBatch(): void {}
  commitBatch(): void {}

  /**
   * Document count as BM25 sees it, not `chunks.size`: the two differ if the same id is
   * added twice, and every caller (status().documents, isEmpty) has always read the BM25
   * figure.
   */
  get size(): number {
    return this.bm25.size;
  }
}
