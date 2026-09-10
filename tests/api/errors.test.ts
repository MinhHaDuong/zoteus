import { describe, it, expect, vi } from 'vitest';
import { ZoteroApiError, actionableMessage } from '../../src/api/errors.js';
import { WebApiClient } from '../../src/api/web-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

const hdr = (h: Record<string, string>) => new Headers(h);

const READ = (url: string, hasKey: boolean) => ({ method: 'GET', url, hasKey });
const WRITE = (url: string, hasKey: boolean) => ({ method: 'POST', url, hasKey });

describe('actionableMessage', () => {
  it('explains a 412 version conflict and how to recover', () => {
    const msg = actionableMessage(412, '', hdr({ 'last-modified-version': '2114' }));
    expect(msg).toMatch(/changed on the server/i);
    expect(msg).toMatch(/2114/);
    expect(msg).toMatch(/re-fetch/i);
  });

  it('surfaces Retry-After for 429', () => {
    const msg = actionableMessage(429, '', hdr({ 'retry-after': '30' }));
    expect(msg).toMatch(/rate limit/i);
    expect(msg).toMatch(/30/);
  });

  it('tells the model to go sequential when rate-limited (429/503)', () => {
    expect(actionableMessage(429, '', hdr({ 'retry-after': '30' })).toLowerCase()).toMatch(/sequential/);
    expect(actionableMessage(503, '', hdr({})).toLowerCase()).toMatch(/sequential/);
  });

  it('names the cause for 413 and 400', () => {
    expect(actionableMessage(413, 'Too many items', hdr({}))).toMatch(/too (large|many)/i);
    expect(actionableMessage(400, 'invalid itemType', hdr({}))).toMatch(/invalid itemType/);
  });
});

// A 403 covers several unrelated refusals whose remedies contradict each other. Which one
// applies is decided by the request, not the response, so each of these asserts both what
// the message says and what it must NOT say: a wrong remedy stated confidently is the
// failure being fixed here, not merely a vague one (#79).
describe('actionableMessage: 403 depends on the request that drew it', () => {
  const USER = 'https://api.zotero.org/users/19552201/items?limit=3';
  const GROUP = 'https://api.zotero.org/groups/6666644/items';

  it('answers a key-free personal read with the local-mode addressing, not key permissions', () => {
    // The measured case: a read of the caller's own library, by its real user id, on an
    // install with no key at all. It routed to the cloud because library_id was not 0.
    const msg = actionableMessage(403, 'Forbidden', hdr({}), READ(USER, false));
    expect(msg).toMatch(/ZOTERO_API_KEY is unset/);
    expect(msg).toMatch(/library_id:0/);
    expect(msg).toMatch(/19552201/);
    expect(msg).toMatch(/zotero_whoami/);
    // Nothing here is about group permissions or write access, so neither may appear.
    expect(msg).not.toMatch(/write access/i);
    expect(msg).not.toMatch(/read-only/i);
    expect(msg).not.toMatch(/Library Editing/);
  });

  it('answers a key-free group read with membership, and mentions the local alternative', () => {
    const msg = actionableMessage(403, 'Forbidden', hdr({}), READ(GROUP, false));
    expect(msg).toMatch(/ZOTERO_API_KEY is unset/);
    expect(msg).toMatch(/6666644/);
    expect(msg).toMatch(/member/i);
    expect(msg).toMatch(/zotero_groups/);
    expect(msg).not.toMatch(/read-only/i);
  });

  it('distinguishes a keyed READ from a keyed WRITE of the same group', () => {
    const read = actionableMessage(403, 'Forbidden', hdr({}), READ(GROUP, true));
    expect(read).toMatch(/cannot READ group 6666644/);
    expect(read).toMatch(/not what this read needed/);
    const write = actionableMessage(403, 'Forbidden', hdr({}), WRITE(GROUP, true));
    // The three gates a group write can fail on stay named (#74).
    expect(write).toMatch(/cannot WRITE to group 6666644/);
    expect(write).toMatch(/no write access to that group/);
    expect(write).toMatch(/not a member of the group/);
    expect(write).toMatch(/Library Editing/);
  });

  it('reads a keyed personal 403 as ownership, and a keyed personal write as a read-only key', () => {
    const read = actionableMessage(403, 'Forbidden', hdr({}), READ(USER, true));
    expect(read).toMatch(/cannot READ users\/19552201/);
    expect(read).toMatch(/zotero_whoami/);
    // A read-only key can read a personal library, so that cannot be the cause of a 403.
    expect(read).not.toMatch(/read-only/i);
    const write = actionableMessage(403, 'Forbidden', hdr({}), WRITE(USER, true));
    expect(write).toMatch(/cannot WRITE to users\/19552201/);
    expect(write).toMatch(/read-only/i);
    expect(write).toMatch(/Allow write access/);
  });

  it('says the key itself was rejected when /keys/current is the 403', () => {
    const msg = actionableMessage(403, 'Forbidden', hdr({}), READ('https://api.zotero.org/keys/current', true));
    expect(msg).toMatch(/rejected the API key itself/);
    expect(msg).toMatch(/invalid, revoked, or mistyped/);
  });

  it('claims nothing specific when the request context is unknown', () => {
    const msg = actionableMessage(403, 'Forbidden', hdr({}));
    expect(msg).toMatch(/Access denied/);
    expect(msg).toMatch(/zotero_groups/);
    // No library and no method were checked, so none may be asserted.
    expect(msg).not.toMatch(/users\//);
    expect(msg).not.toMatch(/ZOTERO_API_KEY is unset/);
  });
});

describe('WebApiClient hands its refusals the request context', () => {
  const forbid = async () => new Response('Forbidden', { status: 403 });

  it('reports a key-free personal read as key-free local addressing', async () => {
    const fetcher = new RateLimitedFetcher({ fetchImpl: vi.fn(forbid), maxConcurrency: 4 });
    const client = new WebApiClient({ fetcher });
    await expect(client.listItems({ type: 'user', id: 19552201 }, { limit: 3 })).rejects.toThrow(
      /ZOTERO_API_KEY is unset[\s\S]*library_id:0/,
    );
  });

  it('reports a keyed group write as a write, and a keyed group read as a read', async () => {
    const fetcher = new RateLimitedFetcher({ fetchImpl: vi.fn(forbid), maxConcurrency: 4 });
    const client = new WebApiClient({ apiKey: 'KEY', fetcher });
    const lib = { type: 'group' as const, id: 6666644 };
    await expect(client.writeItems(lib, [{ itemType: 'book' }])).rejects.toThrow(/cannot WRITE to group 6666644/);
    await expect(client.listItems(lib, { limit: 3 })).rejects.toThrow(/cannot READ group 6666644/);
  });
});

describe('ZoteroApiError', () => {
  it('carries status, retryAfter, and currentVersion', () => {
    const e = new ZoteroApiError({ status: 412, message: 'conflict', currentVersion: 2114 });
    expect(e.status).toBe(412);
    expect(e.currentVersion).toBe(2114);
    expect(e).toBeInstanceOf(Error);
  });
});
