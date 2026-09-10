import type { RateLimitedFetcher } from '../../api/http.js';

export interface ScholarWork {
  title?: string;
  doi?: string;
  year?: number;
  authors: string[];
  citationCount?: number;
  openalexId?: string;
  venue?: string;
  /** OpenAlex's own work type ("article", "book", "conference-paper", ...), when it reports one. */
  type?: string;
  inLibrary?: boolean;
}

/**
 * A page of works together with the size of the list it was cut from, so a caller can tell
 * twenty references from twenty of a hundred and fifty (#76).
 */
export interface ScholarList {
  works: ScholarWork[];
  total: number;
}

export interface OpenAlexOptions {
  /**
   * An OpenAlex API key. Optional: keyless requests still work on a small daily budget, and a
   * key raises it. Before February 2026 a `mailto=` parameter selected a faster "polite
   * pool"; OpenAlex has replaced that with keys and now ignores the parameter, so it is no
   * longer sent (#76).
   */
  apiKey?: string;
  /** A contact address, carried in the User-Agent the way the Zotero client carries it. */
  contact?: string;
}

const BASE = 'https://api.openalex.org';

/**
 * A non-OK response from OpenAlex, carrying the status so a caller can tell the two apart:
 * 404 is OpenAlex answering that it has no such work, anything else is the service failing
 * and must never be reported as an absent record. Same idiom as LocalApiError. The URL
 * stays in the message for logs; callers that speak to a model format their own line from
 * the status instead of quoting it.
 */
export class OpenAlexError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAlexError';
  }
}

function stripDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

function bareId(id: string): string {
  return id.replace('https://openalex.org/', '');
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export class OpenAlexClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly fetcher: RateLimitedFetcher,
    opts: OpenAlexOptions = {},
  ) {
    this.headers = { 'User-Agent': opts.contact ? `zoteus (mailto:${opts.contact})` : 'zoteus' };
    // A header rather than `?api_key=`: every error this client throws quotes the URL, and
    // those messages reach logs and tool output. A header does not.
    if (opts.apiKey) this.headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  private async getJson(url: string): Promise<any> {
    const res = await this.fetcher.fetch(url, { method: 'GET', headers: this.headers }, { maxRetries: 1 });
    if (!res.ok) throw new OpenAlexError(res.status, `OpenAlex ${res.status} for ${url}`);
    return res.json();
  }

  normalize(w: any): ScholarWork {
    return {
      title: w.display_name ?? w.title,
      doi: w.doi ? stripDoi(w.doi) : undefined,
      year: w.publication_year,
      authors: (w.authorships ?? [])
        .map((a: any) => a.author?.display_name)
        .filter(Boolean)
        .slice(0, 10),
      citationCount: w.cited_by_count,
      openalexId: w.id ? bareId(w.id) : undefined,
      venue: w.primary_location?.source?.display_name ?? w.host_venue?.display_name,
      type: w.type,
    };
  }

  /** Fetch a work by DOI or OpenAlex id. Returns the raw work object. */
  async work(doiOrId: string): Promise<any> {
    const path = /^10\./.test(doiOrId) || /doi\.org/i.test(doiOrId)
      ? `works/doi:${stripDoi(doiOrId)}`
      : `works/${bareId(doiOrId)}`;
    return this.getJson(`${BASE}/${path}`);
  }

  /** Resolve many OpenAlex ids to normalized works. */
  async worksByIds(ids: string[]): Promise<ScholarWork[]> {
    const out: ScholarWork[] = [];
    for (const group of chunk(ids.map(bareId), 50)) {
      if (!group.length) continue;
      const json = await this.getJson(`${BASE}/works?filter=openalex_id:${group.join('|')}&per-page=50`);
      for (const w of json.results ?? []) out.push(this.normalize(w));
    }
    return out;
  }

  /** Works that cite the given OpenAlex id. */
  async citedBy(openalexId: string, perPage = 25): Promise<ScholarWork[]> {
    const json = await this.getJson(
      `${BASE}/works?filter=cites:${bareId(openalexId)}&per-page=${Math.min(perPage, 200)}&sort=cited_by_count:desc`,
    );
    return (json.results ?? []).map((w: any) => this.normalize(w));
  }
}
