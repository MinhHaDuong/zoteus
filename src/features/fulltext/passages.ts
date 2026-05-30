import { BM25Index } from '../search/bm25.js';
import { chunkWithOffsets } from '../search/chunker.js';

export interface Passage {
  text: string;
  charStart: number;
  charEnd: number;
  section?: string;
  /** Proportional page estimate (1-based); present when page totals are known. */
  pageApprox?: number;
  /** Exact page from PDF re-extraction (W1 precise_pages); set later by the tool. */
  page?: number;
  score: number;
}

/** Proportional, clamped, 1-based page estimate. Undefined when totals are missing. */
export function approxPage(charStart: number, totalChars: number, totalPages?: number): number | undefined {
  if (!totalPages || totalPages < 1 || !totalChars || totalChars < 1) return undefined;
  const p = Math.ceil(((charStart + 1) / totalChars) * totalPages);
  return Math.min(Math.max(p, 1), totalPages);
}

const HEADING = /^(?:\d+(?:\.\d+)*\.?\s+\S.{0,80}|[A-Z][A-Z0-9 :-]{3,80})$/;

/** Best-effort nearest preceding section heading before `charStart`. */
export function findSection(content: string, charStart: number): string | undefined {
  const lines = content.slice(0, charStart).split(/\n+/);
  const floor = Math.max(0, lines.length - 200);
  for (let i = lines.length - 1; i >= floor; i--) {
    const line = lines[i]!.trim();
    if (line && HEADING.test(line)) return line.slice(0, 100);
  }
  return undefined;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Reciprocal-rank fusion over lists of chunk indices. */
function fuse(lists: number[][], k = 60): number[] {
  const scores = new Map<number, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

export interface RankOptions {
  content: string;
  query: string;
  maxPassages: number;
  totalChars?: number;
  totalPages?: number;
  /** Optional vector reranker (e.g. ctx.search.embed). Bounded to BM25 candidates. */
  embed?: (texts: string[]) => Promise<number[][]>;
}

/**
 * Rank the document's passages against `query` with an ephemeral BM25 index;
 * when `embed` is provided, vector-rerank the BM25 candidate pool and fuse (RRF).
 */
export async function rankPassages(opts: RankOptions): Promise<Passage[]> {
  const totalChars = opts.totalChars ?? opts.content.length;
  const chunks = chunkWithOffsets(opts.content);
  if (!chunks.length) return [];

  const bm25 = new BM25Index();
  for (const c of chunks) bm25.addDoc(String(c.index), c.text);
  const pool = Math.max(opts.maxPassages * 4, 20);
  const bm25Hits = bm25.search(opts.query, pool);
  if (!bm25Hits.length) return [];

  let order = bm25Hits.map((h) => Number(h.id));
  if (opts.embed && bm25Hits.length > 1) {
    try {
      const candTexts = bm25Hits.map((h) => chunks[Number(h.id)]!.text);
      const [qv, ...cvs] = await opts.embed([opts.query, ...candTexts]);
      if (qv && qv.length) {
        const vecOrder = cvs
          .map((v, i) => ({ idx: Number(bm25Hits[i]!.id), score: cosine(qv, v ?? []) }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.idx);
        order = fuse([order, vecOrder]);
      }
    } catch {
      // keep BM25 order on any embedding failure
    }
  }

  return order.slice(0, opts.maxPassages).map((idx) => {
    const c = chunks[idx]!;
    return {
      text: c.text,
      charStart: c.start,
      charEnd: c.end,
      section: findSection(opts.content, c.start),
      pageApprox: approxPage(c.start, totalChars, opts.totalPages),
      score: bm25Hits.find((h) => Number(h.id) === idx)?.score ?? 0,
    };
  });
}
