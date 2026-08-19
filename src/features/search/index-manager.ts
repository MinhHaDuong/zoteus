import { BM25Index, type BM25Hit } from './bm25.js';
import { VectorStore, type VectorHit } from './vector-store.js';
import { chunkText } from './chunker.js';
import { tokenize } from './tokenize.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { Logger } from '../../lib/logger.js';

export interface SearchHit {
  itemKey: string;
  title: string;
  snippet: string;
  score: number;
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
  builtFromVersion: number;
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
  /** Passages indexed so far (alias of documents). */
  passages: number;
  /** Set when state === 'error'. */
  lastError?: string;
}

/** One page of library items plus the library-wide total (for progress). */
export interface PageResult {
  items: any[];
  totalResults: number;
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
}

interface ChunkRecord {
  id: string;
  itemKey: string;
  title: string;
  text: string;
}

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
  const lower = clean.toLowerCase();
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
  private bm25 = new BM25Index();
  private vectors = new VectorStore();
  private chunks = new Map<string, ChunkRecord>();
  private items = new Set<string>();
  private builtFromVersion = 0;

  // Asynchronous build lifecycle (see buildIncremental / requestStop / buildStatus).
  private buildState: BuildState = 'idle';
  private itemsFetched = 0;
  private itemsTotal = 0;
  private lastBuildError: string | undefined = undefined;
  private cancelToken: { cancelled: boolean } | null = null;
  /**
   * Set the first time the provider throws. Kept on the instance (rather than in a build's
   * local scope) precisely so status can report it: a failure that only ever reached a
   * stderr log line is invisible to a desktop-extension user, whose client discards it.
   */
  private embedderError: string | undefined = undefined;

  constructor(private readonly opts: SearchIndexOptions) {}

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
    return this.vectors.size > 0;
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

  /** Full live status: index size + build progress. Backward compatible with status(). */
  buildStatus(): IndexBuildStatus {
    const base = this.status();
    const s: IndexBuildStatus = {
      ...base,
      passages: base.documents,
      state: this.buildState,
      itemsFetched: this.itemsFetched,
      itemsTotal: this.itemsTotal,
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
      documents: this.bm25.size,
      vectors: this.vectors.size,
      items: this.items.size,
      embedder: this.embedderName,
      embedderConfigured: this.embedderConfigured,
      embedderActive: this.embedderActive,
      builtFromVersion: this.builtFromVersion,
    };
    const reason = this.embedderReason;
    if (reason) s.embedderReason = reason;
    return s;
  }

  get isEmpty(): boolean {
    return this.bm25.size === 0;
  }

  private reset(): void {
    this.bm25 = new BM25Index();
    this.vectors = new VectorStore();
    this.chunks = new Map();
    this.items = new Set();
  }

  async build(libraryItems: any[], opts: BuildOptions = {}): Promise<SearchIndexStatus> {
    this.reset();
    // A rebuild is the retry: clear a previous runtime failure so a provider that has since
    // been fixed (model downloaded, package installed) reports healthy again.
    this.embedderError = undefined;
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
        this.chunks.set(rec.id, rec);
        this.bm25.addDoc(rec.id, rec.text);
      }
    }
    if (this.opts.embedder && records.length) {
      try {
        const vecs = await this.opts.embedder.embed(records.map((r) => r.text));
        records.forEach((r, i) => {
          if (vecs[i]) this.vectors.add(r.id, vecs[i]!);
        });
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }
    this.builtFromVersion = opts.version ?? 0;
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
    this.itemsFetched = 0;
    this.itemsTotal = 0;
    const token = { cancelled: false };
    this.cancelToken = token;
    this.reset();

    const embedBatchSize = opts.embedBatchSize ?? 32;
    const persistEveryItems = opts.persistEveryItems ?? 200;
    const persistEveryMs = opts.persistEveryMs ?? 10_000;
    const progressEveryItems = opts.progressEveryItems ?? 500;
    const progressEveryMs = opts.progressEveryMs ?? 10_000;
    const maxItems = opts.maxItems;

    const pending: ChunkRecord[] = []; // passages awaiting embedding
    let start = 0;
    let itemsSincePersist = 0;
    let lastPersistAt = Date.now();
    let itemsSinceLog = 0;
    let lastLogAt = Date.now();

    const persistNow = async (): Promise<void> => {
      itemsSincePersist = 0;
      lastPersistAt = Date.now();
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
    const embedPending = async (force: boolean): Promise<void> => {
      if (!this.hasEmbedder) {
        pending.length = 0;
        return;
      }
      while (pending.length >= (force ? 1 : embedBatchSize)) {
        if (token.cancelled) return;
        const batch = pending.splice(0, Math.min(embedBatchSize, pending.length));
        try {
          const vecs = await this.opts.embedder!.embed(batch.map((r) => r.text));
          batch.forEach((r, i) => {
            if (vecs[i]) this.vectors.add(r.id, vecs[i]!);
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
    };

    try {
      for (;;) {
        if (token.cancelled) break;
        if (maxItems !== undefined && this.itemsFetched >= maxItems) break;
        const page = await fetchPage(start);
        const pageItems = page.items ?? [];
        if (pageItems.length === 0) break;
        if (!this.itemsTotal && page.totalResults) {
          this.itemsTotal = maxItems !== undefined ? Math.min(page.totalResults, maxItems) : page.totalResults;
        }
        for (const item of pageItems) {
          if (token.cancelled) break;
          if (maxItems !== undefined && this.itemsFetched >= maxItems) break;
          this.addOneItem(item, pending);
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
      this.builtFromVersion = this.itemsFetched;
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
    }
  }

  /** Chunk a single library item into the keyword index and queue passages for embedding. */
  private addOneItem(item: any, pending: ChunkRecord[]): void {
    const d = item.data ?? item;
    const key = item.key ?? d.key;
    if (!key) return;
    this.items.add(key);
    for (const ch of chunkText(itemText(d))) {
      const rec: ChunkRecord = { id: `${key}#${ch.index}`, itemKey: key, title: d.title ?? '(untitled)', text: ch.text };
      this.chunks.set(rec.id, rec);
      this.bm25.addDoc(rec.id, rec.text);
      if (this.hasEmbedder) pending.push(rec);
    }
  }

  async query(q: string, opts: { limit?: number; mode?: 'auto' | 'keyword' | 'semantic' } = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const mode = opts.mode ?? 'auto';
    const pool = limit * 3;

    const keyword: BM25Hit[] = mode === 'semantic' ? [] : this.bm25.search(q, pool);
    let vector: VectorHit[] = [];
    if (mode !== 'keyword' && this.opts.embedder && this.vectors.size) {
      try {
        const [qv] = await this.opts.embedder.embed([q]);
        if (qv) vector = this.vectors.search(qv, pool);
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }

    const fused = rrf([keyword, vector]);
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const { id, score } of fused) {
      const rec = this.chunks.get(id);
      if (!rec || seen.has(rec.itemKey)) continue;
      seen.add(rec.itemKey);
      hits.push({ itemKey: rec.itemKey, title: rec.title, snippet: makeSnippet(rec.text, q), score });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  toJSON(): { chunks: ChunkRecord[]; vectors: ReturnType<VectorStore['toJSON']>; builtFromVersion: number } {
    return { chunks: [...this.chunks.values()], vectors: this.vectors.toJSON(), builtFromVersion: this.builtFromVersion };
  }

  loadFromJSON(data: { chunks: ChunkRecord[]; vectors: any[]; builtFromVersion: number }): void {
    this.reset();
    for (const rec of data.chunks ?? []) {
      this.chunks.set(rec.id, rec);
      this.items.add(rec.itemKey);
      this.bm25.addDoc(rec.id, rec.text);
    }
    this.vectors = VectorStore.fromJSON(data.vectors ?? []);
    this.builtFromVersion = data.builtFromVersion ?? 0;
  }
}
