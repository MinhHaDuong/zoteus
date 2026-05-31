import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEntitlementStore, FileEntitlementStore } from '../../src/billing/store.js';

describe('MemoryEntitlementStore', () => {
  it('binds, reads, and enforces 1:1', () => {
    const s = new MemoryEntitlementStore();
    expect(s.getBinding('LK')).toBeUndefined();
    s.bind('LK', 111);
    expect(s.getBinding('LK')?.zoteroUserId).toBe(111);
    s.bind('LK', 111); // idempotent for the same user
    expect(() => s.bind('LK', 222)).toThrow(/already bound/i);
    s.unbind('LK');
    expect(s.getBinding('LK')).toBeUndefined();
  });
});

describe('FileEntitlementStore (encrypted at rest)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'zoteus-ent-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists a binding across instances', async () => {
    const path = join(dir, 'entitlements.json');
    const s1 = await FileEntitlementStore.open(path, 'secret-key-material');
    s1.bind('LK-SECRET', 111);
    await s1.flush();
    const s2 = await FileEntitlementStore.open(path, 'secret-key-material');
    expect(s2.getBinding('LK-SECRET')?.zoteroUserId).toBe(111);
  });

  it('writes ciphertext, not the plaintext key', async () => {
    const path = join(dir, 'entitlements.json');
    const s = await FileEntitlementStore.open(path, 'secret-key-material');
    s.bind('LK-SECRET', 111);
    await s.flush();
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('LK-SECRET');
  });

  it('fails closed (empty) on the wrong secret', async () => {
    const path = join(dir, 'entitlements.json');
    const s1 = await FileEntitlementStore.open(path, 'right-secret');
    s1.bind('LK', 111);
    await s1.flush();
    const s2 = await FileEntitlementStore.open(path, 'wrong-secret');
    expect(s2.getBinding('LK')).toBeUndefined();
  });
});
