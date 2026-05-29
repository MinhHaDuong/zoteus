import { randomBytes } from 'node:crypto';
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

export interface WriteResult {
  successful: Array<{ index: number; key: string; version?: number }>;
  unchanged: string[];
  failed: Array<{ index: number; key?: string; code: number; message: string }>;
  newLibraryVersion: number;
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

  async listSearches(lib: LibraryRef): Promise<ListResult> {
    const { json, headers } = await this.getJson(this.prefix(lib) + '/searches');
    return this.toListResult(json, headers);
  }

  // ---- Writes ----

  /** Read the library's current version (used as a precondition for deletes/mixed writes). */
  async currentLibraryVersion(lib: LibraryRef): Promise<number> {
    const { headers } = await this.getJson(this.prefix(lib) + '/items', this.buildQuery({ limit: 1 }));
    return numOrUndef(headers.get('last-modified-version')) ?? 0;
  }

  /** Create/update items (batch POST /items). Objects with key+version update; without key create. */
  async writeItems(
    lib: LibraryRef,
    objects: any[],
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.postArray(this.prefix(lib) + '/items', objects, opts.libraryVersion);
  }

  async writeCollections(
    lib: LibraryRef,
    objects: any[],
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.postArray(this.prefix(lib) + '/collections', objects, opts.libraryVersion);
  }

  async writeSearches(
    lib: LibraryRef,
    objects: any[],
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.postArray(this.prefix(lib) + '/searches', objects, opts.libraryVersion);
  }

  /** Partial single-item update (PATCH). Returns the new library version. 412 on stale version. */
  async patchItem(lib: LibraryRef, key: string, patch: Record<string, unknown>, version: number): Promise<number> {
    const res = await this.fetcher.fetch(`${this.baseUrl}${this.prefix(lib)}/items/${key}`, {
      method: 'PATCH',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': String(version),
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
        currentVersion: numOrUndef(res.headers.get('last-modified-version')),
        body,
      });
    }
    return numOrUndef(res.headers.get('last-modified-version')) ?? version;
  }

  async deleteItems(lib: LibraryRef, keys: string[], libraryVersion: number): Promise<void> {
    await this.deleteByKeys(this.prefix(lib) + '/items', 'itemKey', keys, libraryVersion);
  }

  async deleteCollections(lib: LibraryRef, keys: string[], libraryVersion: number): Promise<void> {
    await this.deleteByKeys(this.prefix(lib) + '/collections', 'collectionKey', keys, libraryVersion);
  }

  async deleteSearches(lib: LibraryRef, keys: string[], libraryVersion: number): Promise<void> {
    await this.deleteByKeys(this.prefix(lib) + '/searches', 'searchKey', keys, libraryVersion);
  }

  private writeToken(): string {
    return randomBytes(16).toString('hex');
  }

  private async postArray(path: string, objects: any[], libraryVersion?: number): Promise<WriteResult> {
    const merged: WriteResult = {
      successful: [],
      unchanged: [],
      failed: [],
      newLibraryVersion: libraryVersion ?? 0,
    };
    let currentVersion = libraryVersion ?? 0;
    let offset = 0;
    for (const c of chunk(objects, 50)) {
      const headers: Record<string, string> = { ...this.headers(), 'Content-Type': 'application/json' };
      const withVersion = c.filter((o) => o && typeof o.version === 'number').length;
      if (withVersion === c.length && c.length > 0) {
        // all updates: per-object version provides concurrency; no extra header needed
      } else if (withVersion === 0) {
        headers['Zotero-Write-Token'] = this.writeToken();
      } else {
        headers['If-Unmodified-Since-Version'] = String(currentVersion);
      }
      const res = await this.fetcher.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(c),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ZoteroApiError({
          status: res.status,
          message: actionableMessage(res.status, body, res.headers),
          currentVersion: numOrUndef(res.headers.get('last-modified-version')),
          body,
        });
      }
      const json = await res.json();
      this.mergeWriteBody(merged, json, offset);
      const newV = numOrUndef(res.headers.get('last-modified-version'));
      if (newV !== undefined) currentVersion = newV;
      merged.newLibraryVersion = currentVersion;
      offset += c.length;
    }
    return merged;
  }

  private mergeWriteBody(merged: WriteResult, json: any, offset: number): void {
    for (const [idx, obj] of Object.entries<any>(json.successful ?? {})) {
      merged.successful.push({ index: offset + Number(idx), key: obj.key, version: obj.version });
    }
    for (const [idx, key] of Object.entries<any>(json.success ?? {})) {
      const index = offset + Number(idx);
      if (!merged.successful.some((s) => s.index === index)) {
        merged.successful.push({ index, key: String(key) });
      }
    }
    for (const key of Object.values<any>(json.unchanged ?? {})) merged.unchanged.push(String(key));
    for (const [idx, info] of Object.entries<any>(json.failed ?? {})) {
      merged.failed.push({
        index: offset + Number(idx),
        key: info.key,
        code: info.code,
        message: info.message,
      });
    }
  }

  private async deleteByKeys(
    path: string,
    keyParam: string,
    keys: string[],
    libraryVersion: number,
  ): Promise<void> {
    for (const c of chunk(keys, 50)) {
      const url = `${this.baseUrl}${path}?${keyParam}=${c.map(encodeURIComponent).join(',')}`;
      const res = await this.fetcher.fetch(url, {
        method: 'DELETE',
        headers: { ...this.headers(), 'If-Unmodified-Since-Version': String(libraryVersion) },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ZoteroApiError({
          status: res.status,
          message: actionableMessage(res.status, body, res.headers),
          currentVersion: numOrUndef(res.headers.get('last-modified-version')),
          body,
        });
      }
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
