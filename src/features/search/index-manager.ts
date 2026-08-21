import type { VectorEntry, VectorHit } from './vector-store.js';
import { MemoryPassageStore, type ChunkRecord, type PassageStore } from './passage-store.js';
import { chunkText } from './chunker.js';
import { normalizeForSearch, tokenize } from './tokenize.js';
import type { EmbeddingProvider } from './embeddings.js';
import { Semaphore } from '../../lib/semaphore.js';
import type { Logger } from '../../lib/logger.js';

/**
 * Passage size for attachment full text. Deliberately larger than the metadata chunk
 * (512): a body of prose needs more surrounding context per passage to embed usefully,
 * and at 512 a single paper would explode into hundreds of vectors.
 */
export const FULLTEXT_CHUNK_SIZE = 1200;
export const FULLTEXT_CHUNK_OVERLAP = 150;

/**
 * Which Zotero client a build or delta read the library through.
 *
 * It travels beside `builtFromVersion` everywhere, and that pairing is the point. The
 * desktop app and the cloud keep *unrelated* version sequences — the local API answered
 * 200 for a library the Web API numbers in the tens of thousands — so a bare watermark
 * compared after a backend switch is not merely imprecise, it is meaningless in a
 * direction that silently loses data: too high and a real delta is skipped for good, too
 * low and every query replays the whole library. A watermark whose label does not match
 * the client in front of us is therefore not used at all; see `delta.ts`.
 */
export type IndexBackend = 'local' | 'web';

export interface SearchHit {
  itemKey: string;
  title: string;
  snippet: string;
  score: number;
  /** Present when the snippet came from an attachment's body text, not its metadata. */
  source?: 'fulltext';
}

export interface SearchIndexStatus {
  documents: number;
  vectors: number;
  items: number;
  /**
   * The embedder that is actually producing vectors, NOT merely the one that was asked
   * for. Reads "none (local requested; ...)" when the configured provider cannot run, so
   * a 0-vector index explains itself instead of looking like an empty library (#7).
   */
  embedder: string;
  /** The requested ZOTEUS_EMBEDDINGS value, whether or not it works. */
  embedderConfigured: string;
  /** True only while the configured provider is genuinely producing vectors. */
  embedderActive: boolean;
  /** Why `embedderConfigured` is not active, and what to do about it. */
  embedderReason?: string;
  /**
   * Why the *store* is holding no vectors, although the embedder may be producing them
   * happily — on the SQLite backend, sqlite-vec not being loadable. Distinct from
   * `embedderReason`, which is about the other end of the same pipe, and reported for the
   * same reason: a silently keyword-only index is indistinguishable from a healthy one.
   */
  vectorReason?: string;
  /** True when this build was asked to index attachment full text (opt-in). */
  fulltextEnabled: boolean;
  /** Items whose attachment full text is in the index. */
  fulltextItems: number;
  /** Passages that came from attachment full text (a subset of `documents`). */
  fulltextPassages: number;
  /** Why full text is not being indexed although it was requested. */
  fulltextReason?: string;
  /**
   * The Zotero **library version** this index is current as of — not, as it once was, the
   * number of items the build happened to fetch. Deltas are decided by comparing it with
   * the library's `Last-Modified-Version`, so an item count in this field is not a stale
   * number, it is a wrong one.
   */
  builtFromVersion: number;
  /** Which client produced `builtFromVersion`. Absent on an index built before labels. */
  indexBackend?: IndexBackend;
  /**
   * Items holding an attachment Zotero has not extracted text from yet. Reported so that
   * "no text yet" stays distinguishable from "no attachment": the first is a gap a later
   * delta can close, the second is nothing at all. Only meaningful with full text on.
   */
  fulltextPendingItems?: number;
}

/** Lifecycle of the asynchronous background index build. */
export type BuildState = 'idle' | 'building' | 'done' | 'error';

/**
 * Live build/status snapshot. Backward compatible with SearchIndexStatus (it keeps
 * documents/vectors/items/embedder/builtFromVersion) and adds build progress.
 */
export interface IndexBuildStatus extends SearchIndexStatus {
  state: BuildState;
  /** Items pulled from the Zotero API so far. */
  itemsFetched: number;
  /** Total items expected (0 = not yet known). Capped by the build limit. */
  itemsTotal: number;
  /**
   * Items the library actually holds, before the build limit is applied (0 = not yet
   * known). Kept apart from `itemsTotal` so a truncated build stays legible: with only
   * the capped figure, a build that stopped at the limit reports `5000/5000` and is
   * indistinguishable from one that indexed the whole library.
   */
  itemsAvailable: number;
  /** Passages indexed so far (alias of documents). */
  passages: number;
  /** Set when state === 'error'. */
  lastError?: string;
}

/** One page of library items plus the library-wide total (for progress). */
export interface PageResult {
  items: any[];
  totalResults: number;
  /**
   * The library's version when this page was served (`Last-Modified-Version`). The build
   * keeps the FIRST page's value as its watermark, deliberately: an item edited while the
   * crawl was still running may or may not have been picked up, and a watermark taken at
   * the *end* would declare it indexed either way. Taken at the start, the worst case is
   * that the next delta re-indexes a handful of items it already has, which is idempotent.
   */
  libraryVersion?: number;
}

/** Fetch a page of items starting at offset `start` (the Web API pages 100-at-a-time). */
export type PageFetcher = (start: number) => Promise<PageResult>;

export interface IncrementalBuildOptions {
  /** Hard cap on items to index (defaults to no cap beyond the fetcher). */
  maxItems?: number;
  /** Embedding batch size (texts handed to the provider per call). */
  embedBatchSize?: number;
  /** Persist partial progress every N items. */
  persistEveryItems?: number;
  /** Persist partial progress at least every N ms. */
  persistEveryMs?: number;
  /** Log/report progress every N items. */
  progressEveryItems?: number;
  /** Log/report progress at least every N ms. */
  progressEveryMs?: number;
  /** Atomically persist the current (partial) index; called periodically and at the end. */
  persist?: () => Promise<void>;
  /** Optional progress hook (e.g. MCP notifications) fired alongside the logger. */
  onProgress?: (status: IndexBuildStatus) => void;
  /**
   * Optional supplier of an item's attachment full text. When present, that text is
   * chunked into extra passages beside the metadata ones, so a search can match the body
   * of a paper and not only its title and abstract. Opt-in: see ZOTEUS_INDEX_FULLTEXT.
   */
  fulltextFor?: (itemKey: string, item: any) => Promise<string | undefined>;
  /** Concurrent full-text fetches while indexing one page of items (default 4). */
  fulltextConcurrency?: number;
  /** Which client `fetchPage` reads through; recorded beside the watermark. */
  backend?: IndexBackend;
  /** Items whose attachments exist but carry no extracted text yet (see status). */
  fulltextPending?: Iterable<string>;
}

/** What a delta brings into the index, and the watermark it brings it up to. */
export interface IndexDelta {
  /**
   * Items to re-index. Each is dropped wholesale and rebuilt from the payload, so a
   * modification cannot leave old passages beside new ones.
   */
  changed?: Array<{ item: any; fulltext?: string; fulltextPending?: boolean }>;
  /** Item keys the library no longer has. */
  removed?: Iterable<string>;
  /** The library version this delta brings the index up to. */
  version: number;
  /** Which client produced it. Never optional here — see IndexBackend. */
  backend: IndexBackend;
}

export interface DeltaResult {
  reindexed: number;
  removed: number;
  version: number;
}

/**
 * Re-exported from its new home so the many modules that import it from here keep working.
 * The definition moved to passage-store.ts because it is the port's currency, not this
 * orchestrator's private shape.
 */
export type { ChunkRecord };

export interface BuildOptions {
  version?: number;
  extraText?: Map<string, string>;
}

export interface SearchIndexOptions {
  embedder: EmbeddingProvider | null;
  logger?: Logger;
  /** What ZOTEUS_EMBEDDINGS asked for (defaults to the provider's own name, or 'off'). */
  configured?: string;
  /** Why the request produced no provider at all, known at construction time. */
  unavailable?: string;
  /**
   * Where passages live. Defaults to the resident BM25-plus-Map store; an FTS5 store
   * (see sqlite-index.ts) moves them out of the heap without changing anything here.
   */
  store?: PassageStore;
  /**
   * Seed for the reported `builtFromVersion`. The JSON backend recovers it from the
   * snapshot in `loadFromJSON`; a store-backed index has no snapshot to read, so whoever
   * knows the value (see SqliteSearchIndex) hands it in at construction.
   */
  builtFromVersion?: number;
  /**
   * Seed for the watermark's backend label, recovered the same way and for the same
   * reason as `builtFromVersion` — the two are only meaningful together.
   */
  indexBackend?: IndexBackend;
  /** Seed for the pending-full-text set (SQLite recovers it from index_meta). */
  fulltextPending?: Iterable<string>;
}

function itemText(d: any): string {
  const creators = (d.creators ?? []).map((c: any) => c.lastName ?? c.name).filter(Boolean).join(' ');
  const tags = (d.tags ?? []).map((t: any) => t.tag).filter(Boolean).join(' ');
  return [d.title, d.abstractNote, creators, tags, d.date, d.publicationTitle, d.bookTitle, d.note]
    .filter(Boolean)
    .join('. ');
}

/**
 * First sentence of a reason, for the one-line embedder label. Reasons are written to be
 * actionable, which makes them paragraph-length; the label needs the cause only, and the
 * full text still travels in `embedderReason`.
 */
function shortCause(reason: string): string {
  const first = reason.split(/(?<=\.)\s/)[0] ?? reason;
  const trimmed = first.replace(/\.$/, '').trim();
  return trimmed.length > 90 ? `${trimmed.slice(0, 89).trimEnd()}...` : trimmed;
}

/** Reciprocal Rank Fusion of multiple ranked lists. */
function rrf(lists: Array<Array<{ id: string }>>, k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/** Build a readable, query-centred snippet trimmed to word boundaries. */
export function makeSnippet(text: string, query: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Folded the same way the query is, or an accented query would locate nothing and every
  // snippet of a French passage would start at character zero. These are offsets into
  // `clean`, so the folded form is only usable while it is the same length — which it is
  // for precomposed text, NFD/NFC being a round trip there. The guard covers the rest.
  const folded = normalizeForSearch(clean);
  const lower = folded.length === clean.length ? folded : clean.toLowerCase();
  let pos = -1;
  for (const t of tokenize(query)) {
    const i = lower.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  let start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(max / 3));
  if (start > 0) {
    const sp = clean.indexOf(' ', start);
    start = sp >= 0 ? sp + 1 : start;
  }
  let end = Math.min(start + max, clean.length);
  if (end < clean.length) {
    const sp = clean.lastIndexOf(' ', end);
    if (sp > start) end = sp;
  }
  let snip = clean.slice(start, end).trim();
  if (start > 0) snip = `… ${snip}`;
  if (end < clean.length) snip = `${snip} …`;
  return snip;
}

/** Hybrid (BM25 + vector) search index over the library, persistable as JSON. */
export class SearchIndex {
  private readonly store: PassageStore;
  private items = new Set<string>();
  /** Items with at least one full-text passage, and how many such passages exist. */
  private fulltextItems = new Set<string>();
  private fulltextPassages = 0;
  /** Whether the running/last build was asked for full text, and why it may not deliver. */
  private fulltextEnabled = false;
  private fulltextUnavailable: string | undefined = undefined;
  /** Items with an attachment Zotero has not extracted yet; see status().fulltextPendingItems. */
  private fulltextPending = new Set<string>();
  private builtFromVersion = 0;
  private indexBackend: IndexBackend | undefined = undefined;

  // Asynchronous build lifecycle (see buildIncremental / requestStop / buildStatus).
  private buildState: BuildState = 'idle';
  private itemsFetched = 0;
  private itemsTotal = 0;
  private itemsAvailable = 0;
  private lastBuildError: string | undefined = undefined;
  private cancelToken: { cancelled: boolean } | null = null;
  /**
   * Set the first time the provider throws. Kept on the instance (rather than in a build's
   * local scope) precisely so status can report it: a failure that only ever reached a
   * stderr log line is invisible to a desktop-extension user, whose client discards it.
   */
  private embedderError: string | undefined = undefined;

  constructor(private readonly opts: SearchIndexOptions) {
    this.store = opts.store ?? new MemoryPassageStore();
    this.builtFromVersion = opts.builtFromVersion ?? 0;
    this.indexBackend = opts.indexBackend;
    if (opts.fulltextPending) this.fulltextPending = new Set(opts.fulltextPending);
    // What the store already holds, read back before anything asks. Closes the gap ticket
    // 0005 left open: `builtFromVersion` was recovered at construction but `items` and
    // `fulltextItems` were not, so a restarted server with a full index on disk reported
    // 0 items until somebody rebuilt it by hand.
    this.adoptStoreCounters();
    // Said once, at startup, for the same reason createEmbeddingProvider warns there: a
    // store that cannot hold vectors will otherwise announce itself only as an index that
    // happens to have none, hours into a build.
    if (this.store.vectorReason) this.opts.logger?.warn(this.store.vectorReason);
  }

  /** What ZOTEUS_EMBEDDINGS asked for. */
  get embedderConfigured(): string {
    return this.opts.configured ?? this.opts.embedder?.name ?? 'off';
  }

  /** True only while vectors are genuinely being produced. */
  get embedderActive(): boolean {
    return Boolean(this.opts.embedder) && !this.embedderError;
  }

  /** Why the configured embedder is not active (undefined when nothing is wrong). */
  get embedderReason(): string | undefined {
    if (this.embedderActive) return undefined;
    return this.embedderError ?? this.opts.unavailable;
  }

  /**
   * The *effective* embedder, for humans. Reporting the configured value here regardless
   * of whether it worked is what made a missing optional dependency look like an empty
   * library, so a degraded provider names itself and its reason instead.
   */
  get embedderName(): string {
    if (this.embedderActive) return this.opts.embedder!.name;
    const configured = this.embedderConfigured;
    if (configured === 'off') return 'none (keyword-only)';
    const reason = this.embedderReason;
    return `none (${configured} requested; ${reason ? shortCause(reason) : 'unavailable'})`;
  }

  get hasEmbedder(): boolean {
    return this.embedderActive;
  }

  /** True when the index actually holds vectors, i.e. semantic-only ranking can work. */
  get hasVectors(): boolean {
    return this.store.vectorCount > 0;
  }

  /**
   * Why the store is holding no vectors (undefined when nothing is wrong). The store-side
   * counterpart of `embedderReason`: the embedder can be perfectly healthy and the vectors
   * still go nowhere, if the backend that was meant to hold them cannot.
   */
  get vectorStorageReason(): string | undefined {
    return this.store.vectorReason;
  }

  /**
   * Explain why an opt-in full-text build is not producing passages (nothing extracted in
   * Zotero yet, unreachable full-text endpoints). Mirrors the embedder's reporting: a
   * metadata-only index that was ASKED for full text must say so, not look complete.
   */
  noteFulltextUnavailable(reason: string): void {
    this.fulltextUnavailable = reason;
  }

  /** Record the first provider failure so status, not just the log, can report it. */
  private noteEmbedFailure(e: unknown): void {
    if (this.embedderError) return;
    this.embedderError = e instanceof Error ? e.message : String(e);
    this.opts.logger?.warn(`Embedding failed; falling back to keyword-only. ${this.embedderError}`);
  }

  /** True while a background build is running. */
  get isBuilding(): boolean {
    return this.buildState === 'building';
  }

  /**
   * How current this index is, and which client says so. Always read as a pair: the
   * version alone is a number from a sequence nobody named. See IndexBackend.
   */
  get watermark(): { version: number; backend?: IndexBackend } {
    return this.indexBackend
      ? { version: this.builtFromVersion, backend: this.indexBackend }
      : { version: this.builtFromVersion };
  }

  /**
   * Whether this index can be brought up to date item-by-item rather than rebuilt whole.
   *
   * False here, and that is the JSON backend's answer rather than an oversight. A delta
   * costs a partial write per changed item, and the resident store has no such thing:
   * `MemoryPassageStore.deleteByItem` rebuilds the entire BM25 index from the survivors on
   * every call, because BM25's document frequencies are aggregates over every document it
   * holds. Fifty deletions would mean fifty full re-indexes of the library. The SQLite
   * backend overrides this because `passage_meta` carries a real index on `item`, which is
   * what makes a delete-by-item cost nothing (0 ms against 362 ms on a 408 628-passage
   * corpus). So the JSON backend keeps exactly the behaviour it had: full rebuild only,
   * no freshness check, no extra requests.
   */
  get supportsDelta(): boolean {
    return false;
  }

  /** Item keys the index currently holds passages for. */
  indexedItemKeys(): string[] {
    return this.store.itemKeys?.() ?? [...this.items];
  }

  /**
   * Persist the watermark where a restart can find it. A no-op here: the JSON backend
   * carries `builtFromVersion` in its snapshot (see toJSON), which `saveIndex` writes on
   * its own schedule. The SQLite backend overrides it — the database IS the state, so
   * nothing else would ever write the value back, which is the second half of the gap
   * ticket 0005 left open.
   */
  protected recordWatermark(): void {}

  /**
   * Re-read the counters the store is the authority on. Silently does nothing for a store
   * that does not implement the optional half of the port (see PassageStore.itemKeys).
   */
  private adoptStoreCounters(): void {
    const keys = this.store.itemKeys?.();
    if (keys) this.items = new Set(keys);
    // A recorded pending item is evidence on its own that this index was built asking for
    // full text, and it is the ONLY evidence in the case that matters most: a library where
    // Zotero has extracted nothing yet holds zero full-text passages, so a reopened index
    // would otherwise read as metadata-only, run a metadata-only delta, and clear the very
    // record that was meant to bring those items back.
    if (this.fulltextPending.size > 0) this.fulltextEnabled = true;
    const ft = this.store.fulltextStats?.();
    if (!ft) return;
    this.fulltextItems = new Set(ft.items);
    this.fulltextPassages = ft.passages;
    // An index that HOLDS full-text passages is full-text-enabled whatever this process
    // has done so far — the same reading loadFromJSON already takes of a reloaded index.
    if (ft.passages > 0) this.fulltextEnabled = true;
  }

  /** Record which items have an attachment awaiting extraction (see the status field). */
  noteFulltextPending(keys: Iterable<string>): void {
    this.fulltextPending = new Set(keys);
  }

  /** Items with an attachment Zotero has not extracted text from yet. */
  get fulltextPendingItems(): string[] {
    return [...this.fulltextPending];
  }

  /** Full live status: index size + build progress. Backward compatible with status(). */
  buildStatus(): IndexBuildStatus {
    const base = this.status();
    const s: IndexBuildStatus = {
      ...base,
      passages: base.documents,
      state: this.buildState,
      itemsFetched: this.itemsFetched,
      itemsTotal: this.itemsTotal,
      itemsAvailable: this.itemsAvailable,
    };
    if (this.buildState === 'error' && this.lastBuildError) s.lastError = this.lastBuildError;
    return s;
  }

  /**
   * Cooperatively cancel the running build. Returns false if nothing is building.
   * The build halts between pages/batches and keeps whatever was already indexed.
   */
  requestStop(): boolean {
    if (!this.isBuilding || !this.cancelToken) return false;
    this.cancelToken.cancelled = true;
    return true;
  }

  /** Embed arbitrary texts with the configured provider (empty array if none). */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.opts.embedder) return [];
    return this.opts.embedder.embed(texts);
  }

  status(): SearchIndexStatus {
    const s: SearchIndexStatus = {
      documents: this.store.size,
      vectors: this.store.vectorCount,
      items: this.items.size,
      embedder: this.embedderName,
      embedderConfigured: this.embedderConfigured,
      embedderActive: this.embedderActive,
      fulltextEnabled: this.fulltextEnabled,
      fulltextItems: this.fulltextItems.size,
      fulltextPassages: this.fulltextPassages,
      builtFromVersion: this.builtFromVersion,
    };
    if (this.indexBackend) s.indexBackend = this.indexBackend;
    if (this.fulltextPending.size) s.fulltextPendingItems = this.fulltextPending.size;
    const reason = this.embedderReason;
    if (reason) s.embedderReason = reason;
    const storeReason = this.store.vectorReason;
    if (storeReason) s.vectorReason = storeReason;
    if (this.fulltextEnabled && this.fulltextUnavailable) s.fulltextReason = this.fulltextUnavailable;
    return s;
  }

  get isEmpty(): boolean {
    return this.store.size === 0;
  }

  private reset(): void {
    // Cleared in place, never reassigned: the store may be injected (and file-backed), and
    // a fresh MemoryPassageStore here would silently drop it on the first build. Vectors
    // now go with it — clear() is what forgets the embedding dimension too, which is what
    // makes changing the embedding model and rebuilding a supported operation.
    this.store.clear();
    this.items = new Set();
    this.fulltextItems = new Set();
    this.fulltextPassages = 0;
  }

  /**
   * Forget the watermark. Called when the index is emptied by something other than a
   * build that will immediately record a new one — a cleared index that kept a version
   * would answer the freshness check with "already current" and never refill.
   */
  protected forgetWatermark(): void {
    this.builtFromVersion = 0;
    this.indexBackend = undefined;
    this.recordWatermark();
  }

  async build(libraryItems: any[], opts: BuildOptions = {}): Promise<SearchIndexStatus> {
    this.reset();
    // A rebuild is the retry: clear a previous runtime failure so a provider that has since
    // been fixed (model downloaded, package installed) reports healthy again.
    this.embedderError = undefined;
    // This path indexes metadata (plus any caller-supplied extraText), never attachment
    // full text, so it must not inherit a previous incremental build's verdict.
    this.fulltextEnabled = false;
    this.fulltextUnavailable = undefined;
    this.fulltextPending = new Set();
    const records: ChunkRecord[] = [];
    for (const item of libraryItems) {
      const d = item.data ?? item;
      const key = item.key ?? d.key;
      if (!key) continue;
      this.items.add(key);
      const base = itemText(d);
      const extra = opts.extraText?.get(key);
      const text = extra ? `${base}. ${extra}` : base;
      for (const ch of chunkText(text)) {
        const rec: ChunkRecord = { id: `${key}#${ch.index}`, itemKey: key, title: d.title ?? '(untitled)', text: ch.text };
        records.push(rec);
        this.store.add(rec);
      }
    }
    if (this.opts.embedder && records.length) {
      try {
        const vecs = await this.opts.embedder.embed(records.map((r) => r.text));
        records.forEach((r, i) => {
          if (vecs[i]) this.store.setVector(r.id, vecs[i]!);
        });
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }
    this.builtFromVersion = opts.version ?? 0;
    // No label: this path is handed a list of items and never learns which client they came
    // from. Recording the version under the PREVIOUS build's label would be worse than
    // recording nothing — it would make an incomparable pair look comparable, which is the
    // one failure mode the label exists to prevent. Unlabelled, the freshness check refuses
    // the watermark and rebuilds.
    this.indexBackend = undefined;
    this.recordWatermark();
    return this.status();
  }

  /**
   * Asynchronous, incremental, resumable index build.
   *
   * Pages items via `fetchPage`, chunks/keyword-indexes them as they arrive, embeds in
   * small batches, and atomically persists partial progress along the way — so a
   * timeout, crash, or `requestStop()` never leaves a corrupt index and whatever was
   * saved stays queryable. Returns the final build status; the caller should kick this
   * off without awaiting (fire-and-forget) and poll `buildStatus()`.
   */
  async buildIncremental(fetchPage: PageFetcher, opts: IncrementalBuildOptions = {}): Promise<IndexBuildStatus> {
    if (this.isBuilding) throw new Error('Index build already in progress; poll action:"status".');
    this.buildState = 'building';
    this.lastBuildError = undefined;
    this.embedderError = undefined;
    // A rebuild is the retry for full text too: clear the previous run's verdict so a
    // library that has since been extracted in Zotero stops reporting the old reason.
    this.fulltextEnabled = Boolean(opts.fulltextFor);
    this.fulltextUnavailable = undefined;
    this.fulltextPending = new Set(opts.fulltextPending ?? []);
    this.itemsFetched = 0;
    this.itemsTotal = 0;
    this.itemsAvailable = 0;
    const token = { cancelled: false };
    this.cancelToken = token;
    this.reset();
    // Dropped before the first row lands, not merely overwritten at the end. Should this
    // process die mid-crawl, what stays on disk is a partial index with NO watermark,
    // which the freshness check refuses and rebuilds. The alternative — the previous
    // build's watermark sitting above a third of a library — reads as "current" forever.
    this.forgetWatermark();
    // Open the first batch. See PassageStore.beginBatch: for the JSON backend this is a
    // no-op and `opts.persist` is the whole story; for a row store it is the transaction
    // that every insert below runs inside.
    this.store.beginBatch();

    const embedBatchSize = opts.embedBatchSize ?? 32;
    const persistEveryItems = opts.persistEveryItems ?? 200;
    const persistEveryMs = opts.persistEveryMs ?? 10_000;
    const progressEveryItems = opts.progressEveryItems ?? 500;
    const progressEveryMs = opts.progressEveryMs ?? 10_000;
    const maxItems = opts.maxItems;
    const fulltextLimit = new Semaphore(Math.max(1, opts.fulltextConcurrency ?? 4));

    const pending: ChunkRecord[] = []; // passages awaiting embedding
    // The library version as of the FIRST page — see PageResult.libraryVersion for why the
    // start of the crawl and not its end.
    let libraryVersion: number | undefined;
    let start = 0;
    let itemsSincePersist = 0;
    let lastPersistAt = Date.now();
    let itemsSinceLog = 0;
    let lastLogAt = Date.now();

    const persistNow = async (): Promise<void> => {
      itemsSincePersist = 0;
      lastPersistAt = Date.now();
      // Close the current batch and open the next one. Before the early return below,
      // deliberately: the SQLite backend supplies no `persist` callback at all — the
      // database IS the snapshot — so a batch boundary placed after it would never run.
      this.store.commitBatch();
      this.store.beginBatch();
      if (!opts.persist) return;
      try {
        await opts.persist();
      } catch (e) {
        this.opts.logger?.warn(`Could not persist index: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const maybePersist = async (): Promise<void> => {
      if (itemsSincePersist >= persistEveryItems || Date.now() - lastPersistAt >= persistEveryMs) await persistNow();
    };
    const maybeLog = (): void => {
      if (itemsSinceLog < progressEveryItems && Date.now() - lastLogAt < progressEveryMs) return;
      itemsSinceLog = 0;
      lastLogAt = Date.now();
      const s = this.buildStatus();
      const total = s.itemsTotal > 0 ? String(s.itemsTotal) : '?';
      this.opts.logger?.info(
        `index build: ${s.itemsFetched}/${total} items, ${s.passages} passages, ${s.vectors} vectors (embedder=${s.embedder})`,
      );
      opts.onProgress?.(s);
    };
    const embedPending = (force: boolean): Promise<void> =>
      this.drainPending(pending, embedBatchSize, force, () => token.cancelled);

    try {
      for (;;) {
        if (token.cancelled) break;
        if (maxItems !== undefined && this.itemsFetched >= maxItems) break;
        const page = await fetchPage(start);
        const pageItems = page.items ?? [];
        if (pageItems.length === 0) break;
        if (libraryVersion === undefined && typeof page.libraryVersion === 'number') {
          libraryVersion = page.libraryVersion;
        }
        if (!this.itemsTotal && page.totalResults) {
          this.itemsAvailable = page.totalResults;
          this.itemsTotal = maxItems !== undefined ? Math.min(page.totalResults, maxItems) : page.totalResults;
        }
        // Only the items that still fit under the cap are worth fetching full text for.
        const room = maxItems === undefined ? pageItems.length : Math.max(0, maxItems - this.itemsFetched);
        const batch = pageItems.slice(0, room);
        // Full text is fetched a page at a time, several attachments in flight, so the
        // per-item round trip does not serialize the whole build behind the network.
        const texts =
          opts.fulltextFor && !token.cancelled
            ? await Promise.all(
                batch.map((item) =>
                  fulltextLimit.run(async () => {
                    if (token.cancelled) return undefined;
                    const d = item.data ?? item;
                    const key = item.key ?? d.key;
                    if (!key) return undefined;
                    try {
                      return await opts.fulltextFor!(key, item);
                    } catch (e) {
                      this.opts.logger?.debug(
                        `full text for ${key} skipped: ${e instanceof Error ? e.message : String(e)}`,
                      );
                      return undefined;
                    }
                  }),
                ),
              )
            : undefined;
        for (let i = 0; i < batch.length; i++) {
          if (token.cancelled) break;
          this.addOneItem(batch[i], pending, texts?.[i]);
          this.itemsFetched++;
          itemsSincePersist++;
          itemsSinceLog++;
        }
        start += pageItems.length;
        await embedPending(false);
        maybeLog();
        await maybePersist();
        if (start >= page.totalResults) break;
      }
      if (!token.cancelled) await embedPending(true);
      // The watermark, and the whole reason this ticket exists. It used to be
      // `this.itemsFetched` — an item COUNT sitting in a field every later comparison
      // reads as a library version, which is not a stale value but a wrong one.
      //
      // Recorded only on a crawl that ran to its own end. A watermark asserts "everything
      // this index set out to cover is covered as of version V", so the item cap is no
      // objection — it is part of what the build set out to cover, it applies identically
      // next time, and the delta then keeps that subset current. A `requestStop()` is a
      // different thing entirely: an arbitrary point in the library, above which nothing
      // was read. Left with a watermark, those items would never be visited again.
      if (!token.cancelled) {
        this.builtFromVersion = libraryVersion ?? 0;
        this.indexBackend = opts.backend;
        this.recordWatermark();
      }
      await persistNow();
      this.buildState = 'done';
      const final = this.buildStatus();
      const total = final.itemsTotal > 0 ? String(final.itemsTotal) : '?';
      this.opts.logger?.info(
        `index build ${token.cancelled ? 'stopped' : 'complete'}: ` +
          `${final.itemsFetched}/${total} items, ${final.passages} passages, ${final.vectors} vectors (embedder=${final.embedder})`,
      );
      opts.onProgress?.(final);
      return final;
    } catch (e) {
      this.buildState = 'error';
      this.lastBuildError = e instanceof Error ? e.message : String(e);
      this.opts.logger?.error(`index build failed: ${this.lastBuildError}`);
      // Keep whatever partial data we already indexed, and persist it best-effort.
      await persistNow().catch(() => {});
      opts.onProgress?.(this.buildStatus());
      return this.buildStatus();
    } finally {
      this.cancelToken = null;
      // The last batch, on every one of the three ways out of this method: completion,
      // `requestStop()` cancellation, and the error path above. All three reach here, and
      // that is what makes "a stopped or crashed build leaves its rows queryable" a
      // property rather than a happy-path accident. It is load-bearing even after a
      // successful persistNow(), because persistNow always opens the *next* batch — left
      // open, that transaction silently absorbs every write that happens after the build
      // returns, and no second connection ever sees them.
      // Best-effort, like persistNow: a commit that fails must not turn a finished build
      // into a thrown exception the fire-and-forget caller can only log.
      try {
        this.store.commitBatch();
      } catch (e) {
        this.opts.logger?.warn(`Could not commit index batch: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Embed the queued passages in provider-sized batches and file the vectors.
   *
   * Lifted out of `buildIncremental`, where it was a closure, so the delta path embeds
   * through the same code rather than a second copy of it: an item re-indexed by a delta
   * has to reach the provider in the same batches, with the same failure handling, as one
   * indexed by a build. `force` drains a partial batch (end of a run); `cancelled` lets a
   * caller with a cancel token stop between batches — a delta passes neither.
   */
  private async drainPending(
    pending: ChunkRecord[],
    batchSize: number,
    force: boolean,
    cancelled?: () => boolean,
  ): Promise<void> {
    if (!this.hasEmbedder) {
      pending.length = 0;
      return;
    }
    while (pending.length >= (force ? 1 : batchSize)) {
      if (cancelled?.()) return;
      const batch = pending.splice(0, Math.min(batchSize, pending.length));
      try {
        const vecs = await this.opts.embedder!.embed(batch.map((r) => r.text));
        batch.forEach((r, i) => {
          if (vecs[i]) this.store.setVector(r.id, vecs[i]!);
        });
      } catch (e) {
        // hasEmbedder goes false from here, which both stops this loop and makes every
        // later status report say why the index has no vectors.
        this.noteEmbedFailure(e);
        pending.length = 0;
      }
      // Yield so long embedding runs stay interruptible and the event loop breathes.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Bring the index up to date item-by-item instead of rebuilding it.
   *
   * Each changed item is **dropped and re-added**, never merged into: an item whose title
   * or abstract was edited would otherwise keep its old passages beside the new ones and
   * go on answering queries for text it no longer contains. That is the same act as a
   * removal followed by an insertion, which is why both live in one transaction here.
   *
   * The watermark moves only once the whole delta has landed. A partially applied delta
   * that advanced it would mark the unapplied remainder as indexed for good.
   */
  async applyDelta(delta: IndexDelta, opts: { embedBatchSize?: number } = {}): Promise<DeltaResult> {
    if (this.isBuilding) throw new Error('Index build in progress; a delta cannot run beside it.');
    const embedBatchSize = opts.embedBatchSize ?? 32;
    const pending: ChunkRecord[] = [];
    let removed = 0;
    let reindexed = 0;

    this.store.beginBatch();
    try {
      for (const key of delta.removed ?? []) {
        this.store.deleteByItem(key);
        this.fulltextPending.delete(key);
        removed++;
      }
      for (const change of delta.changed ?? []) {
        const d = change.item?.data ?? change.item;
        const key = change.item?.key ?? d?.key;
        if (!key) continue;
        this.store.deleteByItem(key);
        this.addOneItem(change.item, pending, change.fulltext);
        if (change.fulltextPending) this.fulltextPending.add(key);
        else this.fulltextPending.delete(key);
        reindexed++;
      }
      // Inside the transaction, exactly as in buildIncremental: the vectors belong with
      // the passages they point at, and a crash between the two would leave KNN hits
      // resolving to nothing.
      await this.drainPending(pending, embedBatchSize, true);
    } finally {
      this.store.commitBatch();
    }

    // Counters come back from the store rather than being adjusted by hand: nothing in a
    // delete-by-item says how many of the passages it removed were full text.
    this.adoptStoreCounters();
    this.builtFromVersion = delta.version;
    this.indexBackend = delta.backend;
    this.recordWatermark();
    return { reindexed, removed, version: delta.version };
  }

  /** Chunk a single library item into the keyword index and queue passages for embedding. */
  private addOneItem(item: any, pending: ChunkRecord[], fulltext?: string): void {
    const d = item.data ?? item;
    const key = item.key ?? d.key;
    if (!key) return;
    this.items.add(key);
    const title = d.title ?? '(untitled)';
    for (const ch of chunkText(itemText(d))) {
      const rec: ChunkRecord = { id: `${key}#${ch.index}`, itemKey: key, title, text: ch.text };
      this.store.add(rec);
      if (this.hasEmbedder) pending.push(rec);
    }
    if (fulltext) this.addFulltext(key, title, fulltext, pending);
  }

  /**
   * Index an item's attachment body text as extra passages. They carry the parent item's
   * key, so a body hit is reported (and de-duplicated) as that item, exactly like a hit on
   * its abstract. Ids are namespaced `#f<n>` so they can never collide with metadata ones.
   */
  private addFulltext(itemKey: string, title: string, text: string, pending: ChunkRecord[]): void {
    let added = 0;
    for (const ch of chunkText(text, FULLTEXT_CHUNK_SIZE, FULLTEXT_CHUNK_OVERLAP)) {
      const rec: ChunkRecord = {
        id: `${itemKey}#f${ch.index}`,
        itemKey,
        title,
        text: ch.text,
        source: 'fulltext',
      };
      this.store.add(rec);
      if (this.hasEmbedder) pending.push(rec);
      added++;
    }
    if (added) {
      this.fulltextItems.add(itemKey);
      this.fulltextPassages += added;
    }
  }

  async query(q: string, opts: { limit?: number; mode?: 'auto' | 'keyword' | 'semantic' } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const mode = opts.mode ?? 'auto';
    const pool = limit * 3;

    const keyword = mode === 'semantic' ? [] : this.store.search(q, pool);
    let vector: VectorHit[] = [];
    if (mode !== 'keyword' && this.opts.embedder && this.store.vectorCount) {
      try {
        const [qv] = await this.opts.embedder.embed([q]);
        // Inside the same try as the embed call on purpose: a store can refuse a query
        // vector too (an index built by a different model, so a different width), and that
        // is the same class of failure — reported through embedderReason, keyword half
        // still returned — rather than a search that throws.
        if (qv) vector = this.store.vectorSearch(qv, pool);
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }

    const fused = rrf([keyword, vector]);
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const { id, score } of fused) {
      const rec = this.store.get(id);
      if (!rec || seen.has(rec.itemKey)) continue;
      seen.add(rec.itemKey);
      const hit: SearchHit = { itemKey: rec.itemKey, title: rec.title, snippet: makeSnippet(rec.text, q), score };
      // Worth surfacing: a body-text snippet is a passage the caller can go and cite with
      // zotero_get_fulltext, whereas a metadata one is just the abstract.
      if (rec.source === 'fulltext') hit.source = 'fulltext';
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  toJSON(): { chunks: ChunkRecord[]; vectors: VectorEntry[]; builtFromVersion: number } {
    return {
      chunks: [...this.store.values()],
      vectors: this.store.vectorEntries(),
      builtFromVersion: this.builtFromVersion,
    };
  }

  loadFromJSON(data: { chunks: ChunkRecord[]; vectors: any[]; builtFromVersion: number }): void {
    this.reset();
    for (const rec of data.chunks ?? []) {
      this.store.add(rec);
      this.items.add(rec.itemKey);
      if (rec.source === 'fulltext') {
        this.fulltextItems.add(rec.itemKey);
        this.fulltextPassages++;
      }
    }
    // A reloaded index reports what it HOLDS: an index carrying full-text passages counts
    // as full-text-enabled even before this process runs a build of its own.
    this.fulltextEnabled = this.fulltextPassages > 0;
    // Replayed through the port rather than handed to a VectorStore wholesale: on the
    // resident store setVector IS VectorStore.add, called in the snapshot's own order, so
    // the reloaded index is the one that was saved. Chunks first, above, because a store
    // that keys vectors by passage rowid needs the passage to exist already.
    for (const e of data.vectors ?? []) {
      if (e && typeof e.id === 'string' && Array.isArray(e.vector)) this.store.setVector(e.id, e.vector);
    }
    this.builtFromVersion = data.builtFromVersion ?? 0;
    // No backend label in a JSON snapshot, and none is invented: the JSON backend runs no
    // deltas (see supportsDelta), so nothing ever compares this version to a live one.
    this.indexBackend = undefined;
  }
}
