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
  embedder: string;
  builtFromVersion: number;
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
}

function itemText(d: any): string {
  const creators = (d.creators ?? []).map((c: any) => c.lastName ?? c.name).filter(Boolean).join(' ');
  const tags = (d.tags ?? []).map((t: any) => t.tag).filter(Boolean).join(' ');
  return [d.title, d.abstractNote, creators, tags, d.date, d.publicationTitle, d.bookTitle, d.note]
    .filter(Boolean)
    .join('. ');
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

  constructor(private readonly opts: SearchIndexOptions) {}

  get embedderName(): string {
    return this.opts.embedder?.name ?? 'none (keyword-only)';
  }

  get hasEmbedder(): boolean {
    return Boolean(this.opts.embedder);
  }

  /** Embed arbitrary texts with the configured provider (empty array if none). */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.opts.embedder) return [];
    return this.opts.embedder.embed(texts);
  }

  status(): SearchIndexStatus {
    return {
      documents: this.bm25.size,
      vectors: this.vectors.size,
      items: this.items.size,
      embedder: this.embedderName,
      builtFromVersion: this.builtFromVersion,
    };
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
        this.opts.logger?.warn(`Embedding failed; falling back to keyword-only. ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.builtFromVersion = opts.version ?? 0;
    return this.status();
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
        this.opts.logger?.warn(`Query embedding failed; keyword-only. ${e instanceof Error ? e.message : String(e)}`);
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
