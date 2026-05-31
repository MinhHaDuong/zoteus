import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Binding } from './entitlement.js';

/** Durable license↔user bindings (anti-sharing 1:1). Mirrors the OAuthStore split. */
export interface EntitlementStore {
  getBinding(key: string): Binding | undefined;
  /** Bind a key to a user; idempotent for the same user, throws on a different user. */
  bind(key: string, zoteroUserId: number): void;
  /** Operator reset (e.g. a legitimate account move). */
  unbind(key: string): void;
  /** Reverse lookup: the binding (and key) for a user, for ongoing entitlement re-checks. */
  findByUser?(zoteroUserId: number): { key: string; binding: Binding } | undefined;
  flush(): Promise<void>;
}

type Snapshot = Array<[string, Binding]>;

export class MemoryEntitlementStore implements EntitlementStore {
  protected bindings = new Map<string, Binding>();

  getBinding(key: string): Binding | undefined {
    return this.bindings.get(key);
  }
  bind(key: string, zoteroUserId: number): void {
    const existing = this.bindings.get(key);
    if (existing) {
      if (existing.zoteroUserId !== zoteroUserId) {
        throw new Error('license key already bound to another Zotero account');
      }
      return; // idempotent for the same user
    }
    this.bindings.set(key, { zoteroUserId, boundAt: Date.now() });
    this.touch();
  }
  unbind(key: string): void {
    if (this.bindings.delete(key)) this.touch();
  }
  findByUser(zoteroUserId: number): { key: string; binding: Binding } | undefined {
    for (const [key, binding] of this.bindings) if (binding.zoteroUserId === zoteroUserId) return { key, binding };
    return undefined;
  }
  async flush(): Promise<void> {
    /* no-op for memory */
  }

  protected touch(): void {}
  protected snapshot(): Snapshot {
    return [...this.bindings.entries()];
  }
  protected restore(s: Snapshot): void {
    this.bindings = new Map(s);
  }
}

const ALG = 'aes-256-gcm';

/** AES-256-GCM encrypted bindings file. Same layout/semantics as auth/store.ts FileStore. */
export class FileEntitlementStore extends MemoryEntitlementStore {
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly key: Buffer,
  ) {
    super();
  }

  static async open(path: string, secret: string): Promise<FileEntitlementStore> {
    const key = createHash('sha256').update(secret).digest();
    const store = new FileEntitlementStore(path, key);
    await store.load();
    return store;
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return; // absent → empty
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
      // wrong secret / corrupt → fail closed with an empty store
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
