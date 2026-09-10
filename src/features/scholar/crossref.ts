import type { RateLimitedFetcher } from '../../api/http.js';
import type { ScholarWork } from './openalex.js';

const BASE = 'https://api.crossref.org';

function stripDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

/**
 * Whether this 200 really is one work, and not a listing that happens to parse.
 *
 * `/works/<doi>` and `/works/` are the same route with and without a DOI, and the second is
 * Crossref's works-LIST endpoint: it answers 200 with `{"message-type":"work-list",
 * message:{facets, total-results: 186 million, items:[...]}}`. Read as a work, that
 * envelope has no title, no DOI and no authors, so an empty DOI came back as a successful
 * lookup of an untitled paper with nothing in it. A 200 from the wrong endpoint is not a
 * result: the envelope has to say `work`, and the payload has to carry the DOI that every
 * indexed work has, before anything is read out of it.
 *
 * `message-type` is checked only when present, so a lenient mirror that omits it still
 * works, and the `items` array catches a list envelope either way.
 */
function isSingleWork(json: any): boolean {
  const type = json['message-type'];
  if (typeof type === 'string' && type !== 'work') return false;
  const w = json.message;
  if (w === null || typeof w !== 'object') return false;
  return !Array.isArray(w.items) && typeof w.DOI === 'string';
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
      if (!w || !isSingleWork(json)) return null;
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
