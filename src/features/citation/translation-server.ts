import type { RateLimitedFetcher } from '../../api/http.js';

export interface MultipleChoices {
  url: string;
  session: string;
  items: Record<string, string>;
}

/**
 * Client for a Zotero translation-server (https://github.com/zotero/translation-server).
 * Used for add-by-identifier (DOI/ISBN/PMID/arXiv) and add-by-URL. Optional: if the
 * server is not reachable, callers should degrade gracefully via isUp().
 */
export class TranslationServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: RateLimitedFetcher,
  ) {}

  async isUp(): Promise<boolean> {
    try {
      const res = await this.fetcher.fetch(`${this.baseUrl}/`, { method: 'GET' }, { maxRetries: 0 });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  /** Resolve an identifier (DOI/ISBN/PMID/arXiv/Bibcode) to Zotero-JSON items. */
  async search(identifier: string): Promise<any[]> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/search`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: identifier },
      { maxRetries: 0 },
    );
    if (res.status === 400 || res.status === 501) {
      throw new Error(`No translator could resolve "${identifier}".`);
    }
    if (!res.ok) throw new Error(`translation-server /search returned ${res.status}.`);
    return (await res.json()) as any[];
  }

  /** Scrape a URL. Returns items, or a 300 Multiple-Choices selection set. */
  async web(url: string): Promise<{ items?: any[]; multiple?: MultipleChoices }> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/web`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: url },
      { maxRetries: 0 },
    );
    if (res.status === 300) return { multiple: (await res.json()) as MultipleChoices };
    if (!res.ok) throw new Error(`translation-server /web returned ${res.status}.`);
    return { items: (await res.json()) as any[] };
  }

  async exportFormat(items: any[], format: string): Promise<string> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/export?format=${encodeURIComponent(format)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) },
      { maxRetries: 0 },
    );
    if (!res.ok) throw new Error(`translation-server /export returned ${res.status}.`);
    return res.text();
  }
}
