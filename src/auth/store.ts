import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface StoredAccess {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // seconds since epoch
  zoteroKey?: string;
  zoteroUserId?: number;
  username?: string;
}

export interface StoredRefresh {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms since epoch
  zoteroKey?: string;
  zoteroUserId?: number;
  username?: string;
}

/** Durable OAuth state: registered clients + access/refresh tokens (carrying per-user Zotero keys). */
export interface OAuthStore {
  getClient(id: string): OAuthClientInformationFull | undefined;
  setClient(info: OAuthClientInformationFull): void;
  deleteClient(id: string): void;
  clientIds(): string[];

  getAccess(token: string): StoredAccess | undefined;
  setAccess(token: string, rec: StoredAccess): void;
  deleteAccess(token: string): void;

  getRefresh(token: string): StoredRefresh | undefined;
  setRefresh(token: string, rec: StoredRefresh): void;
  deleteRefresh(token: string): void;

  sweepExpired(nowSec: number, nowMs: number): void;
  /** Persist to disk if backed by a file; a no-op for in-memory. */
  flush(): Promise<void>;
}

interface Snapshot {
  clients: OAuthClientInformationFull[];
  access: Array<[string, StoredAccess]>;
  refresh: Array<[string, StoredRefresh]>;
}

/** Shared in-memory body; FileStore extends it with encryption + persistence. */
export class MemoryStore implements OAuthStore {
  protected clients = new Map<string, OAuthClientInformationFull>();
  protected access = new Map<string, StoredAccess>();
  protected refresh = new Map<string, StoredRefresh>();

  getClient(id: string): OAuthClientInformationFull | undefined {
    return this.clients.get(id);
  }
  setClient(info: OAuthClientInformationFull): void {
    this.clients.set(info.client_id, info);
    this.touch();
  }
  deleteClient(id: string): void {
    if (this.clients.delete(id)) this.touch();
  }
  clientIds(): string[] {
    return [...this.clients.keys()];
  }

  getAccess(token: string): StoredAccess | undefined {
    return this.access.get(token);
  }
  setAccess(token: string, rec: StoredAccess): void {
    this.access.set(token, rec);
    this.touch();
  }
  deleteAccess(token: string): void {
    if (this.access.delete(token)) this.touch();
  }

  getRefresh(token: string): StoredRefresh | undefined {
    return this.refresh.get(token);
  }
  setRefresh(token: string, rec: StoredRefresh): void {
    this.refresh.set(token, rec);
    this.touch();
  }
  deleteRefresh(token: string): void {
    if (this.refresh.delete(token)) this.touch();
  }

  sweepExpired(nowSec: number, nowMs: number): void {
    let changed = false;
    for (const [k, v] of this.access) {
      if (v.expiresAt < nowSec) {
        this.access.delete(k);
        changed = true;
      }
    }
    for (const [k, v] of this.refresh) {
      if (v.expiresAt < nowMs) {
        this.refresh.delete(k);
        changed = true;
      }
    }
    if (changed) this.touch();
  }

  async flush(): Promise<void> {
    /* no-op for memory */
  }

  /** Hook overridden by FileStore to schedule a debounced persist. */
  protected touch(): void {}

  protected snapshot(): Snapshot {
    return {
      clients: [...this.clients.values()],
      access: [...this.access.entries()],
      refresh: [...this.refresh.entries()],
    };
  }
  protected restore(s: Snapshot): void {
    this.clients = new Map(s.clients.map((c) => [c.client_id, c]));
    this.access = new Map(s.access);
    this.refresh = new Map(s.refresh);
  }
}

const ALG = 'aes-256-gcm';

/** AES-256-GCM encrypted JSON file store. Key = SHA-256(secret). Layout: base64(iv|tag|ciphertext). */
export class FileStore extends MemoryStore {
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly key: Buffer,
  ) {
    super();
  }

  static async open(path: string, secret: string): Promise<FileStore> {
    const key = createHash('sha256').update(secret).digest();
    const store = new FileStore(path, key);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return; // absent → empty store
    }
    try {
      const buf = Buffer.from(raw, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const ct = buf.subarray(28);
      const decipher = createDecipheriv(ALG, this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      this.restore(JSON.parse(plain) as Snapshot);
    } catch {
      // wrong secret / corrupt / truncated → fail closed with an empty store
    }
  }

  protected override touch(): void {
    this.dirty = true;
  }

  override async flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    const prev = this.writing;
    this.writing = (async () => {
      await prev.catch(() => {}); // serialize writes so the last rename reflects the newest state
      const plain = Buffer.from(JSON.stringify(this.snapshot()), 'utf8');
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALG, this.key, iv);
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      const payload = Buffer.concat([iv, tag, ct]).toString('base64');
      const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`;
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, payload);
      await rename(tmp, this.path);
    })();
    return this.writing;
  }
}
