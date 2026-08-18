import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RateLimitedFetcher } from './http.js';
import { ZoteroApiError } from './errors.js';
import type { WriteResult } from './web-client.js';
import type { Logger } from '../lib/logger.js';

export interface LocalWriteClientOptions {
  /** Zotero desktop local-API port (default 23119). */
  port?: number;
  fetcher?: RateLimitedFetcher;
  logger?: Logger;
  /** Where the granted local-API key is cached (default: <dataDir>/local-api-key.json). */
  keyStorePath?: string;
  /** Pre-provisioned local API key (ZOTEUS_LOCAL_API_KEY); skips the authorize prompt. */
  key?: string;
  /** App name shown in Zotero's grant dialog. */
  appName?: string;
}

interface StoredGrant {
  key: string;
  appName: string;
  serverId?: string;
  remember?: boolean;
  grantedAt: string;
}

/**
 * Write client for the Zotero 9+ desktop local API.
 *
 * Zotero >= 9 accepts writes (POST/PATCH/DELETE) on the same local API the reads use
 * (http://127.0.0.1:23119/api/users/0/...), gated by a *local* API key that the user
 * grants through a one-time in-Zotero dialog:
 *
 *   1. Every response carries a `Zotero-Server-ID` header; writes must echo it back
 *      (428 when missing, 412 when it no longer matches the running instance).
 *   2. `POST /api/local/authorize` with `{"appName": "..."}` shows a dialog in Zotero
 *      ("Allow" / "Always Allow" / "Deny") and returns `{key, remember}`.
 *   3. Writes then carry `Zotero-API-Key: <key>`. A single-use key is consumed by the
 *      first successful write, so a 401 means: re-authorize.
 *
 * Keys are unrelated to zotero.org cloud keys. Grants are cached on disk so the user
 * is prompted once ("Always Allow"); single-use "Allow" grants degrade gracefully by
 * re-prompting on the next write.
 */
export class LocalWriteClient {
  private readonly base: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly logger?: Logger;
  private readonly keyStorePath?: string;
  private readonly appName: string;
  private key?: string;
  private serverId?: string;

  constructor(opts: LocalWriteClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
    this.logger = opts.logger;
    this.keyStorePath = opts.keyStorePath;
    this.appName = opts.appName ?? 'Zoteus MCP';
    this.key = opts.key;
  }

  /**
   * True when a local-API key is already available (env-provided or cached from a
   * previous "Always Allow" grant) — i.e. writes can proceed without prompting.
   */
  hasStoredKey(): boolean {
    if (this.key) return true;
    return Boolean(this.loadGrant()?.key);
  }

  /** Stable ID of the running Zotero instance (required on every write). */
  async getServerId(): Promise<string> {
    if (this.serverId) return this.serverId;
    const res = await this.fetcher.fetch(
      `${this.base}/users/0/items?limit=1`,
      { method: 'GET', headers: this.readHeaders() },
      { maxRetries: 0 },
    );
    if (!res.ok) throw new Error(`Local API unreachable (HTTP ${res.status}) — is Zotero running?`);
    const id = res.headers.get('zotero-server-id');
    await res.body?.cancel().catch(() => {});
    if (!id) throw new Error('Local API did not return a Zotero-Server-ID header (Zotero >= 9 required for writes).');
    this.serverId = id;
    return id;
  }

  /**
   * Ask Zotero to grant this app a local API key. Blocks until the user answers the
   * dialog in Zotero ("Always Allow" recommended). Returns the key, or throws with a
   * human-readable reason on denial/error.
   */
  async authorize(): Promise<string> {
    this.logger?.info(`Requesting local API write access from Zotero (appName="${this.appName}")…`);
    const res = await this.fetcher.fetch(
      `${this.base}/local/authorize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Zotero-API-Version': '3' },
        body: JSON.stringify({ appName: this.appName }),
      },
      { maxRetries: 0, deadlineMs: 300_000 },
    );
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error('Zotero local write access was denied. Re-run when you can accept the dialog in Zotero.');
    }
    if (res.status === 429) {
      throw new Error('Too many local-API authorization prompts; wait a minute and try again.');
    }
    if (!res.ok) {
      throw new Error(`Local API authorize failed (HTTP ${res.status}): ${text || res.statusText}. ` +
        'Writes need Zotero 9+ with the local API enabled.');
    }
    const { key, remember } = JSON.parse(text) as { key: string; remember?: boolean };
    this.key = key;
    this.storeGrant({ key, appName: this.appName, serverId: this.serverId, remember, grantedAt: new Date().toISOString() });
    this.logger?.info(`Local API write access granted (remember=${!!remember}).`);
    return key;
  }

  private readHeaders(): Record<string, string> {
    return { 'Zotero-API-Version': '3', 'x-zotero-connector-api-version': '3' };
  }

  private async writeHeaders(): Promise<Record<string, string>> {
    return {
      ...this.readHeaders(),
      'Zotero-API-Key': this.key ?? (await this.authorize()),
      'Zotero-Server-ID': await this.getServerId(),
    };
  }

  private loadGrant(): StoredGrant | null {
    if (!this.keyStorePath) return null;
    try {
      return JSON.parse(readFileSync(this.keyStorePath, 'utf8')) as StoredGrant;
    } catch {
      return null;
    }
  }

  private storeGrant(grant: StoredGrant): void {
    if (!this.keyStorePath) return;
    try {
      mkdirSync(dirname(this.keyStorePath), { recursive: true });
      writeFileSync(this.keyStorePath, JSON.stringify(grant, null, 2));
    } catch (e) {
      this.logger?.warn(`Could not persist local API grant: ${e}`);
    }
  }

  private async ensureKey(): Promise<void> {
    if (this.key) return;
    const grant = this.loadGrant();
    if (grant?.key) {
      this.key = grant.key;
      this.serverId = this.serverId ?? grant.serverId;
    }
  }

  /**
   * Run a write request against the local API, transparently handling the two
   * re-auth/re-probe cases: 401 (key consumed/unknown -> authorize again) and
   * 412/428 (server-id stale/missing -> refresh it).
   */
  private async request(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init: { json?: unknown; form?: URLSearchParams; headers?: Record<string, string> } = {},
    retried = false,
  ): Promise<Response> {
    await this.ensureKey();
    if (!this.key) await this.authorize();
    const headers = await this.writeHeaders();
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    } else if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.fetcher.fetch(
      `${this.base}${path}`,
      {
        method,
        headers: { ...headers, ...init.headers },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.form?.toString(),
      },
      { maxRetries: 0, deadlineMs: 120_000 },
    );
    if (res.status === 401 && !retried) {
      this.logger?.info('Local API key rejected (401); requesting a fresh grant from Zotero…');
      this.key = undefined;
      await this.authorize();
      return this.request(method, path, init, true);
    }
    if ((res.status === 412 || res.status === 428) && !retried) {
      this.serverId = undefined;
      await res.body?.cancel().catch(() => {});
      return this.request(method, path, init, true);
    }
    return res;
  }

  /** Multi-write (create/update) up to 50 items, mirroring the Web API semantics. */
  async writeItems(items: Record<string, unknown>[]): Promise<WriteResult> {
    const res = await this.request('POST', '/users/0/items', { json: items });
    return this.parseWriteResult(res);
  }

  /** Partial single-item update. */
  async patchItem(key: string, patch: Record<string, unknown>): Promise<number> {
    const res = await this.request('PATCH', `/users/0/items/${key}`, { json: patch });
    if (!res.ok) await this.throwApi(res, `PATCH /items/${key}`);
    const v = Number(res.headers.get('last-modified-version'));
    await res.body?.cancel().catch(() => {});
    return Number.isFinite(v) ? v : 0;
  }

  /** Trash items by key (permanent=false, the default) or delete permanently. */
  async deleteItems(keys: string[], permanent = false): Promise<void> {
    const path = `/users/0/items${permanent ? '/deleted' : ''}?itemKey=${keys.join(',')}`;
    const res = await this.request('DELETE', path);
    if (!res.ok && res.status !== 204) await this.throwApi(res, `DELETE ${path}`);
    await res.body?.cancel().catch(() => {});
  }

  /**
   * Store a file on a (child) attachment item using the Web-API 3-phase upload flow,
   * which the local API re-implements: authorize -> POST bytes to the returned URL ->
   * register the uploadKey.
   */
  async uploadFile(
    attachmentKey: string,
    file: { bytes: Uint8Array; filename: string; contentType: string; mtimeMs?: number },
  ): Promise<void> {
    const md5 = createHash('md5').update(file.bytes).digest('hex');
    const mtime = file.mtimeMs ?? Date.now();
    const authorize = await this.request('POST', `/users/0/items/${attachmentKey}/file`, {
      form: new URLSearchParams({
        md5,
        filename: file.filename,
        filesize: String(file.bytes.length),
        mtime: String(mtime),
        contentType: file.contentType,
      }),
      headers: { 'If-None-Match': '*' },
    });
    if (!authorize.ok) await this.throwApi(authorize, `authorize upload for ${attachmentKey}`);
    const auth = (await authorize.json()) as { exists?: number; url?: string; uploadKey?: string };
    if (auth.exists) return; // identical file already stored
    if (!auth.url || !auth.uploadKey) throw new Error('Local API did not return an upload URL.');

    const bodyInit: RequestInit['body'] = file.bytes;
    const up = await this.fetcher.fetch(
      auth.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bodyInit,
      },
      { maxRetries: 0, deadlineMs: 300_000 },
    );
    if (!up.ok) await this.throwApi(up, 'file-bytes upload');
    await up.body?.cancel().catch(() => {});

    const register = await this.request('POST', `/users/0/items/${attachmentKey}/file`, {
      form: new URLSearchParams({ upload: auth.uploadKey }),
      headers: { 'If-None-Match': '*' },
    });
    if (!register.ok && register.status !== 204) await this.throwApi(register, 'register upload');
    await register.body?.cancel().catch(() => {});
  }

  private async parseWriteResult(res: Response): Promise<WriteResult> {
    if (!res.ok) await this.throwApi(res, 'local write');
    const json = (await res.json().catch(() => ({}))) as any;
    const successful: WriteResult['successful'] = [];
    for (const [idx, obj] of Object.entries<any>(json.successful ?? {})) {
      successful.push({ index: Number(idx), key: obj.key, version: obj.version });
    }
    const failed: WriteResult['failed'] = [];
    for (const [idx, obj] of Object.entries<any>(json.failed ?? {})) {
      failed.push({ index: Number(idx), code: obj.code ?? 0, message: obj.message ?? 'write failed', key: obj.key });
    }
    return {
      successful,
      unchanged: Object.keys(json.unchanged ?? {}),
      failed,
      newLibraryVersion: Number(res.headers.get('last-modified-version')) || 0,
    };
  }

  private async throwApi(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '');
    throw new ZoteroApiError({ status: res.status, message: `Local API ${what} failed (${res.status}): ${body.slice(0, 400)}`, body });
  }
}
