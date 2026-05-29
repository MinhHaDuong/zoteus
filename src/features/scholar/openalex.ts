import type { RateLimitedFetcher } from '../../api/http.js';

export interface ScholarWork {
  title?: string;
  doi?: string;
  year?: number;
  authors: string[];
  citationCount?: number;
  openalexId?: string;
  venue?: string;
  inLibrary?: boolean;
}

const BASE = 'https://api.openalex.org';

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
  constructor(
    private readonly fetcher: RateLimitedFetcher,
    private readonly mailto?: string,
  ) {}

  private mailtoParam(extra = ''): string {
    const m = this.mailto ? `mailto=${encodeURIComponent(this.mailto)}` : '';
    if (extra && m) return `?${extra}&${m}`;
    if (extra) return `?${extra}`;
    if (m) return `?${m}`;
    return '';
  }

  private async getJson(url: string): Promise<any> {
    const res = await this.fetcher.fetch(url, { method: 'GET' }, { maxRetries: 1 });
    if (!res.ok) throw new Error(`OpenAlex ${res.status} for ${url}`);
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
    };
  }

  /** Fetch a work by DOI or OpenAlex id. Returns the raw work object. */
  async work(doiOrId: string): Promise<any> {
    const path = /^10\./.test(doiOrId) || /doi\.org/i.test(doiOrId)
      ? `works/doi:${stripDoi(doiOrId)}`
      : `works/${bareId(doiOrId)}`;
    return this.getJson(`${BASE}/${path}${this.mailtoParam()}`);
  }

  /** Resolve many OpenAlex ids to normalized works. */
  async worksByIds(ids: string[]): Promise<ScholarWork[]> {
    const out: ScholarWork[] = [];
    for (const group of chunk(ids.map(bareId), 50)) {
      if (!group.length) continue;
      const filter = `filter=openalex_id:${group.join('|')}&per-page=50`;
      const json = await this.getJson(`${BASE}/works${this.mailtoParam(filter)}`);
      for (const w of json.results ?? []) out.push(this.normalize(w));
    }
    return out;
  }

  /** Works that cite the given OpenAlex id. */
  async citedBy(openalexId: string, perPage = 25): Promise<ScholarWork[]> {
    const filter = `filter=cites:${bareId(openalexId)}&per-page=${Math.min(perPage, 200)}&sort=cited_by_count:desc`;
    const json = await this.getJson(`${BASE}/works${this.mailtoParam(filter)}`);
    return (json.results ?? []).map((w: any) => this.normalize(w));
  }
}
