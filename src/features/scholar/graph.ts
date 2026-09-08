import { OpenAlexClient, type ScholarList, type ScholarWork } from './openalex.js';
import { CrossrefClient } from './crossref.js';
import type { RateLimitedFetcher } from '../../api/http.js';

export type { ScholarList, ScholarWork } from './openalex.js';

export interface ScholarGraphOptions {
  fetcher: RateLimitedFetcher;
  /**
   * A contact address. Crossref's polite pool still reads it from `mailto=`; OpenAlex ignores
   * that parameter since early 2026 and gets the address in the User-Agent instead.
   */
  mailto?: string;
  /** An OpenAlex API key, sent as a bearer header (#76). */
  openalexApiKey?: string;
}

/** Orchestrates scholarly providers (OpenAlex primary, Crossref fallback). */
export class ScholarGraph {
  readonly openalex: OpenAlexClient;
  readonly crossref: CrossrefClient;

  constructor(opts: ScholarGraphOptions) {
    this.openalex = new OpenAlexClient(opts.fetcher, { apiKey: opts.openalexApiKey, contact: opts.mailto });
    this.crossref = new CrossrefClient(opts.fetcher, opts.mailto);
  }

  async lookup(doi: string): Promise<ScholarWork | null> {
    try {
      const w = await this.openalex.work(doi);
      return this.openalex.normalize(w);
    } catch {
      return this.crossref.work(doi);
    }
  }

  /**
   * Works this paper cites, at most `limit` of them, with the full count beside them. A
   * review with 150 references used to answer `limit` works and nothing else, so a
   * citation-gap pass had no way to know it saw a seventh of the list (#76).
   */
  async references(doi: string, limit = 20): Promise<ScholarList> {
    const work = await this.openalex.work(doi);
    const all: string[] = work.referenced_works ?? [];
    const ids = all.slice(0, limit);
    return { works: ids.length ? await this.openalex.worksByIds(ids) : [], total: all.length };
  }

  async related(doi: string, limit = 20): Promise<ScholarList> {
    const work = await this.openalex.work(doi);
    const all: string[] = work.related_works ?? [];
    const ids = all.slice(0, limit);
    return { works: ids.length ? await this.openalex.worksByIds(ids) : [], total: all.length };
  }

  /**
   * Works that cite this paper, most-cited first. `total` is OpenAlex's `cited_by_count` for
   * the work, the size of the list this one page was taken from.
   */
  async citations(doi: string, limit = 20): Promise<ScholarList> {
    const work = await this.openalex.work(doi);
    if (!work.id) return { works: [], total: 0 };
    const works = await this.openalex.citedBy(work.id, limit);
    const counted = typeof work.cited_by_count === 'number' ? work.cited_by_count : 0;
    return { works, total: Math.max(counted, works.length) };
  }
}

/** Tag works that are already in the library (by lowercased DOI). */
export function markInLibrary(works: ScholarWork[], libraryDois: Set<string>): ScholarWork[] {
  return works.map((w) => ({
    ...w,
    inLibrary: w.doi ? libraryDois.has(w.doi.toLowerCase()) : false,
  }));
}
