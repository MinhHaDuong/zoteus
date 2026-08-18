import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWriteClient } from '../../src/api/local-writes.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

const SERVER_ID = 'zotero-instance-1';

/** A local API that answers GETs with a Zotero-Server-ID and records writes. */
function makeClient(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  opts: { key?: string; keyStorePath?: string } = {},
) {
  const fetcher = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 2 });
  return new LocalWriteClient({
    port: 23119,
    fetcher,
    key: opts.key,
    keyStorePath: opts.keyStorePath,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
  });
}

function okJson(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe('LocalWriteClient (Zotero 9+ desktop writes)', () => {
  it('writes items with a pre-provisioned key and the required server-id header', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'zotero-server-id': SERVER_ID } });
      }
      return okJson({ successful: { '0': { key: 'NEWKEY1', version: 42 } }, failed: {}, unchanged: {} }, { 'last-modified-version': '42' });
    });
    const client = makeClient(fetchImpl, { key: 'preset-key' });
    const result = await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(result.successful).toEqual([{ index: 0, key: 'NEWKEY1', version: 42 }]);
    expect(result.failed).toEqual([]);
    expect(result.newLibraryVersion).toBe(42);
    // No authorize round-trip when a key is pre-provisioned.
    expect(seen.some((s) => s.url.includes('/local/authorize'))).toBe(false);
    const write = seen.find((s) => s.url.endsWith('/users/0/items') && s.headers['Content-Type'] === 'application/json');
    expect(write).toBeTruthy();
    expect(write!.headers['Zotero-API-Key']).toBe('preset-key');
    expect(write!.headers['Zotero-Server-ID']).toBe(SERVER_ID);
  });

  it('authorizes via the grant dialog when no key exists, and caches the grant on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-grant-'));
    const keyStorePath = join(dir, 'local-api-key.json');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) {
        const body = JSON.parse(String(init.body));
        expect(body.appName).toBeTruthy();
        return okJson({ key: 'granted-key', remember: true });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'zotero-server-id': SERVER_ID } });
      }
      return okJson({ successful: { '0': { key: 'K1', version: 1 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl, { keyStorePath });
    const result = await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(result.successful[0]?.key).toBe('K1');
    // The grant was persisted so future runs skip the dialog.
    expect(existsSync(keyStorePath)).toBe(true);
    const grant = JSON.parse(readFileSync(keyStorePath, 'utf8'));
    expect(grant.key).toBe('granted-key');
    expect(grant.remember).toBe(true);
  });

  it('loads a cached grant from disk instead of prompting again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-grant-'));
    const keyStorePath = join(dir, 'local-api-key.json');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) throw new Error('authorize should not be called');
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'zotero-server-id': SERVER_ID } });
      }
      expect((init.headers as any)['Zotero-API-Key']).toBe('cached-key');
      return okJson({ successful: {}, failed: {}, unchanged: {} });
    });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(keyStorePath, JSON.stringify({ key: 'cached-key', appName: 'Zoteus MCP', grantedAt: 'now' }));
    const client = makeClient(fetchImpl, { keyStorePath });
    await client.writeItems([]);
  });

  it('re-authorizes once on 401 (single-use "Allow" grant consumed)', async () => {
    let writes = 0;
    let authorizations = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/local/authorize')) {
        authorizations++;
        return okJson({ key: `key-${authorizations}`, remember: false });
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'zotero-server-id': SERVER_ID } });
      }
      writes++;
      if (writes === 1) return new Response('key consumed', { status: 401 });
      expect((init.headers as any)['Zotero-API-Key']).toBe('key-2');
      return okJson({ successful: { '0': { key: 'K9', version: 2 } }, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl);
    const result = await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(authorizations).toBe(2);
    expect(writes).toBe(2);
    expect(result.successful[0]?.key).toBe('K9');
  });

  it('re-probes the server id on 428/412 (Zotero restarted between calls)', async () => {
    let serverId = 'old-instance';
    let writes = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'zotero-server-id': serverId } });
      }
      writes++;
      if (writes === 1) {
        expect((init.headers as any)['Zotero-Server-ID']).toBe('old-instance');
        serverId = 'new-instance'; // Zotero restarted: the old id is now stale
        return new Response('precondition failed', { status: 412 });
      }
      expect((init.headers as any)['Zotero-Server-ID']).toBe('new-instance');
      return okJson({ successful: {}, failed: {}, unchanged: {} });
    });
    const client = makeClient(fetchImpl, { key: 'k' });
    await client.writeItems([{ itemType: 'book', title: 'T' }]);
    expect(writes).toBe(2);
  });

  it('surfaces a human-readable error when the user denies the grant dialog', async () => {
    const fetchImpl = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith('/local/authorize')) return new Response('denied', { status: 403 });
      return new Response(JSON.stringify([]), { status: 200, headers: { 'zotero-server-id': SERVER_ID } });
    });
    const client = makeClient(fetchImpl);
    await expect(client.writeItems([{ itemType: 'book' }])).rejects.toThrow(/denied/i);
  });
});
