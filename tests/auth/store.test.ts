import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, FileStore, type StoredAccess } from '../../src/auth/store.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const client = (id: string): OAuthClientInformationFull =>
  ({ client_id: id, redirect_uris: ['http://localhost/cb'], token_endpoint_auth_method: 'none' }) as OAuthClientInformationFull;

const access = (over: Partial<StoredAccess> = {}): StoredAccess => ({
  clientId: 'c1',
  scopes: ['zoteus'],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  zoteroKey: 'SECRETKEY',
  zoteroUserId: 99,
  username: 'bob',
  ...over,
});

describe('MemoryStore', () => {
  it('round-trips clients and tokens', () => {
    const s = new MemoryStore();
    s.setClient(client('c1'));
    expect(s.getClient('c1')?.client_id).toBe('c1');
    expect(s.clientIds()).toEqual(['c1']);
    s.setAccess('a1', access());
    expect(s.getAccess('a1')?.zoteroKey).toBe('SECRETKEY');
    s.deleteAccess('a1');
    expect(s.getAccess('a1')).toBeUndefined();
  });

  it('sweepExpired drops expired access/refresh', () => {
    const s = new MemoryStore();
    s.setAccess('old', access({ expiresAt: Math.floor(Date.now() / 1000) - 10 }));
    s.setAccess('new', access());
    s.sweepExpired(Math.floor(Date.now() / 1000), Date.now());
    expect(s.getAccess('old')).toBeUndefined();
    expect(s.getAccess('new')).toBeTruthy();
  });
});

describe('FileStore (encrypted at rest)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zoteus-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads clients + tokens across instances', async () => {
    const path = join(dir, 'oauth-store.json');
    const s1 = await FileStore.open(path, 'secret-key-material');
    s1.setClient(client('c1'));
    s1.setAccess('a1', access());
    await s1.flush();

    const s2 = await FileStore.open(path, 'secret-key-material');
    expect(s2.getClient('c1')?.client_id).toBe('c1');
    expect(s2.getAccess('a1')?.zoteroKey).toBe('SECRETKEY');
  });

  it('writes ciphertext, not plaintext keys', async () => {
    const path = join(dir, 'oauth-store.json');
    const s = await FileStore.open(path, 'secret-key-material');
    s.setAccess('a1', access());
    await s.flush();
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('SECRETKEY');
  });

  it('fails closed (empty store) when the secret is wrong', async () => {
    const path = join(dir, 'oauth-store.json');
    const s1 = await FileStore.open(path, 'right-secret');
    s1.setAccess('a1', access());
    await s1.flush();

    const s2 = await FileStore.open(path, 'wrong-secret');
    expect(s2.getAccess('a1')).toBeUndefined();
    expect(s2.clientIds()).toEqual([]);
  });

  it('starts empty when the file is absent', async () => {
    const s = await FileStore.open(join(dir, 'missing.json'), 'k');
    expect(s.clientIds()).toEqual([]);
  });

  it('starts empty (does not throw) on a corrupt file', async () => {
    const path = join(dir, 'oauth-store.json');
    await writeFile(path, 'not-valid-base64-or-json{{{');
    const s = await FileStore.open(path, 'k');
    expect(s.clientIds()).toEqual([]);
  });
});
