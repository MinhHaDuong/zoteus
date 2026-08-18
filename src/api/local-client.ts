import { RateLimitedFetcher } from './http.js';
import type { ItemQuery, ListResult } from './web-client.js';

export interface LocalApiClientOptions {
  port?: number;
  fetcher?: RateLimitedFetcher;
}

/**
 * Read-only client for the Zotero desktop local API (Zotero 7+).
 * Base: http://127.0.0.1:<port>/api ; the personal library is always users/0.
 * Every endpoint here is GET. Native local-API writes exist from Zotero 10 and live in
 * local-writes.ts, which needs the grant flow this client deliberately stays out of.
 */
export class LocalApiClient {
  static readonly LOCAL_USER_ID = 0;
  private readonly base: string;
  private readonly fetcher: RateLimitedFetcher;

  constructor(opts: LocalApiClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
  }

  private headers(): Record<string, string> {
    return { 'Zotero-API-Version': '3', 'x-zotero-connector-api-version': '3' };
  }

  private buildQuery(
    params: Record<string, string | number | boolean | string[] | undefined>,
  ): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((i) => sp.append(k, String(i)));
      else sp.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private async getJson(path: string, query = ''): Promise<{ json: any; headers: Headers }> {
    const res = await this.fetcher.fetch(
      `${this.base}${path}${query}`,
      { method: 'GET', headers: this.headers() },
      { maxRetries: 0 },
    );
    if (!res.ok) throw new Error(`Local API ${res.status} for ${path}`);
    return { json: await res.json(), headers: res.headers };
  }

  private toListResult<T>(json: T[], headers: Headers): ListResult<T> {
    // Mirror the Web API client: a MISSING header must fall back, not parse as 0
    // (`Number(null)` is 0, which is finite). A bogus totalResults of 0 would stop a
    // paging caller — e.g. the search-index build — after its very first page.
    return {
      data: json,
      totalResults: numOrUndef(headers.get('total-results')) ?? json.length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.getJson('/users/0/items', this.buildQuery({ limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }

  async listItems(query: ItemQuery = {}): Promise<ListResult> {
    const { top: _t, collectionKey, ...rest } = query;
    const base = collectionKey ? `/collections/${collectionKey}` : '';
    const segment = query.top ? `${base}/items/top` : `${base}/items`;
    const { json, headers } = await this.getJson(`/users/0${segment}`, this.buildQuery(rest as any));
    return this.toListResult(json, headers);
  }

  async getItem(key: string, query: { include?: string; format?: string } = {}): Promise<any> {
    const { json } = await this.getJson(`/users/0/items/${key}`, this.buildQuery(query));
    return json;
  }

  /**
   * Children (attachments, notes, annotations) of an item. The desktop local API
   * silently ignores a `parentItem` query param on /items and answers with the whole
   * library, so the dedicated /children endpoint is the only correct way to ask.
   */
  async getItemChildren(key: string, query: ItemQuery = {}): Promise<ListResult> {
    const { top: _t, collectionKey: _c, ...rest } = query;
    const { json, headers } = await this.getJson(
      `/users/0/items/${key}/children`,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  async listCollections(
    query: { top?: boolean; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const segment = query.top ? '/collections/top' : '/collections';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(`/users/0${segment}`, this.buildQuery(rest as any));
    return this.toListResult(json, headers);
  }
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
