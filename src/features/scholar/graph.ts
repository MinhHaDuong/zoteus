import { OpenAlexClient, type ScholarWork } from './openalex.js';
import { CrossrefClient } from './crossref.js';
import type { RateLimitedFetcher } from '../../api/http.js';

export type { ScholarWork } from './openalex.js';

export interface ScholarGraphOptions {
  fetcher: RateLimitedFetcher;
  mailto?: string;
}

/** Orchestrates scholarly providers (OpenAlex primary, Crossref fallback). */
export class ScholarGraph {
  readonly openalex: OpenAlexClient;
  readonly crossref: CrossrefClient;

  constructor(opts: ScholarGraphOptions) {
    this.openalex = new OpenAlexClient(opts.fetcher, opts.mailto);
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

  async references(doi: string, limit = 20): Promise<ScholarWork[]> {
    const work = await this.openalex.work(doi);
    const ids: string[] = (work.referenced_works ?? []).slice(0, limit);
    if (!ids.length) return [];
    return this.openalex.worksByIds(ids);
  }

  async related(doi: string, limit = 20): Promise<ScholarWork[]> {
    const work = await this.openalex.work(doi);
    const ids: string[] = (work.related_works ?? []).slice(0, limit);
    if (!ids.length) return [];
    return this.openalex.worksByIds(ids);
  }

  async citations(doi: string, limit = 20): Promise<ScholarWork[]> {
    const work = await this.openalex.work(doi);
    if (!work.id) return [];
    return this.openalex.citedBy(work.id, limit);
  }
}

/** Tag works that are already in the library (by lowercased DOI). */
export function markInLibrary(works: ScholarWork[], libraryDois: Set<string>): ScholarWork[] {
  return works.map((w) => ({
    ...w,
    inLibrary: w.doi ? libraryDois.has(w.doi.toLowerCase()) : false,
  }));
}
