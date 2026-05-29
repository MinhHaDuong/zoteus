import type { RateLimitedFetcher } from '../../api/http.js';
import type { ScholarWork } from './openalex.js';

const BASE = 'https://api.crossref.org';

function stripDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

/** Crossref DOI-metadata fallback. Tolerates non-JSON error responses. */
export class CrossrefClient {
  constructor(
    private readonly fetcher: RateLimitedFetcher,
    private readonly mailto?: string,
  ) {}

  async work(doi: string): Promise<ScholarWork | null> {
    const m = this.mailto ? `?mailto=${encodeURIComponent(this.mailto)}` : '';
    try {
      const res = await this.fetcher.fetch(`${BASE}/works/${stripDoi(doi)}${m}`, { method: 'GET' }, { maxRetries: 1 });
      if (!res.ok) return null;
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        return null;
      }
      const w = json.message;
      if (!w) return null;
      return {
        title: Array.isArray(w.title) ? w.title[0] : w.title,
        doi: w.DOI,
        year: w.issued?.['date-parts']?.[0]?.[0],
        authors: (w.author ?? [])
          .map((a: any) => [a.given, a.family].filter(Boolean).join(' '))
          .filter(Boolean)
          .slice(0, 10),
        citationCount: w['is-referenced-by-count'],
        venue: Array.isArray(w['container-title']) ? w['container-title'][0] : w['container-title'],
      };
    } catch {
      return null;
    }
  }
}
