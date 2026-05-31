import { describe, it, expect, vi } from 'vitest';
import { isClientIdMetadataUrl, fetchClientMetadata, InMemoryCimdCache } from '../../src/lib/cimd.js';

const OPTS = { maxBytes: 16384, allowedRedirectSchemes: ['https'] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isClientIdMetadataUrl', () => {
  it('accepts https URLs, rejects opaque ids and non-https', () => {
    expect(isClientIdMetadataUrl('https://app.example/cimd.json')).toBe(true);
    expect(isClientIdMetadataUrl('http://app.example/cimd.json')).toBe(false);
    expect(isClientIdMetadataUrl('a1b2c3-uuid')).toBe(false);
    expect(isClientIdMetadataUrl('not a url')).toBe(false);
  });
});

describe('fetchClientMetadata', () => {
  it('accepts a valid doc whose client_id equals the URL', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' }),
    ) as unknown as typeof fetch;
    const client = await fetchClientMetadata(url, { ...OPTS, fetchImpl });
    expect(client.client_id).toBe(url);
    expect(client.redirect_uris).toEqual(['https://app.example/cb']);
  });

  it('rejects a non-https URL', async () => {
    await expect(fetchClientMetadata('http://app.example/cimd.json', OPTS)).rejects.toThrow(/https/i);
  });

  it('rejects when client_id does not equal the document URL', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: 'https://evil.example/x', redirect_uris: ['https://app.example/cb'] }),
    ) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow(/client_id/i);
  });

  it('rejects an oversized document', async () => {
    const url = 'https://app.example/cimd.json';
    const big = 'x'.repeat(64);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: [`https://app.example/${big}`], padding: big.repeat(1000) }),
    ) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { maxBytes: 256, allowedRedirectSchemes: ['https'], fetchImpl })).rejects.toThrow(
      /too large/i,
    );
  });

  it('rejects a redirect_uri with a disallowed scheme', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: ['http://app.example/cb'] }),
    ) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow(/redirect/i);
  });

  it('rejects a malformed (non-JSON) body', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () => new Response('<<not json>>', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow();
  });
});

describe('InMemoryCimdCache', () => {
  it('caches within TTL and re-fetches after expiry', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return { client_id: 'https://app.example/cimd.json', redirect_uris: ['https://app.example/cb'] };
    };
    const cache = new InMemoryCimdCache(1000);
    const k = 'https://app.example/cimd.json';
    await cache.getOrLoad(k, loader);
    await cache.getOrLoad(k, loader);
    expect(calls).toBe(1);
    cache.now = () => Date.now() + 2000; // jump past TTL
    await cache.getOrLoad(k, loader);
    expect(calls).toBe(2);
  });
});
