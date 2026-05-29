import { RateLimitedFetcher } from './http.js';
import { ZoteroApiError, actionableMessage } from './errors.js';
import type { Logger } from '../lib/logger.js';

export interface LibraryRef {
  type: 'user' | 'group';
  id: number;
}

export interface KeyInfo {
  key?: string;
  userID: number;
  username: string;
  displayName?: string;
  access: Record<string, unknown>;
}

export interface ListResult<T = any> {
  data: T[];
  totalResults: number;
  lastModifiedVersion: number;
}

export interface ItemQuery {
  q?: string;
  qmode?: 'titleCreatorYear' | 'everything';
  itemType?: string;
  tag?: string | string[];
  sort?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  start?: number;
  since?: number;
  includeTrashed?: boolean;
  top?: boolean;
  collectionKey?: string;
  include?: string;
  format?: string;
}

export interface WebApiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetcher?: RateLimitedFetcher;
  contactEmail?: string;
  logger?: Logger;
}

const DEFAULT_BASE = 'https://api.zotero.org';

export class WebApiClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly contactEmail?: string;

  constructor(opts: WebApiClientOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher({ logger: opts.logger });
    this.contactEmail = opts.contactEmail;
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Zotero-API-Version': '3' };
    if (this.apiKey) h['Zotero-API-Key'] = this.apiKey;
    h['User-Agent'] = this.contactEmail ? `zoteus (mailto:${this.contactEmail})` : 'zoteus';
    return h;
  }

  private prefix(lib: LibraryRef): string {
    return lib.type === 'user' ? `/users/${lib.id}` : `/groups/${lib.id}`;
  }

  private buildQuery(
    params: Record<string, string | number | boolean | string[] | undefined>,
  ): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
      else sp.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private async getJson(path: string, query = ''): Promise<{ json: any; headers: Headers }> {
    const url = `${this.baseUrl}${path}${query}`;
    const res = await this.fetcher.fetch(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
        retryAfter: numOrUndef(res.headers.get('retry-after')),
        currentVersion: numOrUndef(res.headers.get('last-modified-version')),
        body,
      });
    }
    return { json: await res.json(), headers: res.headers };
  }

  private toListResult<T>(json: T[], headers: Headers): ListResult<T> {
    return {
      data: json,
      totalResults: numOrUndef(headers.get('total-results')) ?? json.length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  async keysCurrent(): Promise<KeyInfo> {
    const { json } = await this.getJson('/keys/current');
    return json as KeyInfo;
  }

  async getSchema(): Promise<any> {
    // The global schema endpoint takes no auth.
    const res = await this.fetcher.fetch(`${this.baseUrl}/schema`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
      });
    }
    return res.json();
  }

  async listItems(lib: LibraryRef, query: ItemQuery = {}): Promise<ListResult> {
    const segment = query.top ? '/items/top' : '/items';
    const { top: _top, ...rest } = query;
    const { json, headers } = await this.getJson(
      this.prefix(lib) + segment,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  async getItem(
    lib: LibraryRef,
    key: string,
    query: { include?: string; format?: string } = {},
  ): Promise<any> {
    const { json } = await this.getJson(this.prefix(lib) + `/items/${key}`, this.buildQuery(query));
    return json;
  }

  async getItemChildren(lib: LibraryRef, key: string, query: ItemQuery = {}): Promise<ListResult> {
    const { json, headers } = await this.getJson(
      this.prefix(lib) + `/items/${key}/children`,
      this.buildQuery(query as any),
    );
    return this.toListResult(json, headers);
  }

  async listCollections(
    lib: LibraryRef,
    query: { top?: boolean; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const segment = query.top ? '/collections/top' : '/collections';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(
      this.prefix(lib) + segment,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  async listTags(
    lib: LibraryRef,
    query: { q?: string; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const { json, headers } = await this.getJson(
      this.prefix(lib) + '/tags',
      this.buildQuery(query as any),
    );
    return this.toListResult(json, headers);
  }
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
