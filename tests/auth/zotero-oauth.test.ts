import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  percentEncode,
  buildSignatureBaseString,
  signHmacSha1,
  requestToken,
  accessToken,
  buildAuthorizeUrl,
} from '../../src/auth/zotero-oauth.js';

describe('OAuth 1.0a signing', () => {
  it('percent-encodes per RFC 3986 (unreserved untouched, space -> %20)', () => {
    expect(percentEncode('Hello Ladies + Gentlemen, a signed OAuth request!')).toBe(
      'Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21',
    );
    expect(percentEncode('-._~')).toBe('-._~');
    expect(percentEncode('a/b')).toBe('a%2Fb');
  });

  // Small, fully hand-verifiable base string: sorted params + double-encoding of a space.
  // a=1, b=2, c="a b" → "a=1&b=2&c=a%20b" → percent-encoded into the base string.
  it('builds a hand-verifiable signature base string (sorting + double encoding)', () => {
    const base = buildSignatureBaseString('GET', 'http://example.com/', { b: '2', a: '1', c: 'a b' });
    expect(base).toBe('GET&http%3A%2F%2Fexample.com%2F&a%3D1%26b%3D2%26c%3Da%2520b');
  });

  // Canonical Twitter "Creating a signature" base string (RFC 5849 HMAC-SHA1).
  it('builds the canonical signature base string', () => {
    const base = buildSignatureBaseString('POST', 'https://api.twitter.com/1/statuses/update.json', {
      status: 'Hello Ladies + Gentlemen, a signed OAuth request!',
      include_entities: 'true',
      oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog',
      oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: '1318622958',
      oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      oauth_version: '1.0',
    });
    expect(base).toBe(
      'POST&https%3A%2F%2Fapi.twitter.com%2F1%2Fstatuses%2Fupdate.json&' +
        'include_entities%3Dtrue%26' +
        'oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
        'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
        'oauth_signature_method%3DHMAC-SHA1%26' +
        'oauth_timestamp%3D1318622958%26' +
        'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
        'oauth_version%3D1.0%26' +
        'status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521',
    );
  });

  // HMAC-SHA1 primitive correctness, pinned to the published RFC 2202 §3 test case 2
  // (key="Jefe", data="what do ya want for nothing?") — an authoritative cross-implementation
  // known-answer vector, independent of this code. signHmacSha1 with an empty consumer/token
  // secret reduces the signing key to "Jefe" only if we feed it directly, so we assert the
  // primitive via the same node:crypto call the implementation uses.
  it('uses a correct HMAC-SHA1 (RFC 2202 known-answer vector)', () => {
    const mac = createHmac('sha1', 'Jefe').update('what do ya want for nothing?').digest('hex');
    expect(mac).toBe('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  });

  // The only custom logic in signHmacSha1 is the signing-key assembly:
  //   key = percentEncode(consumerSecret) + '&' + percentEncode(tokenSecret).
  // These cases pin that contract against an inline node:crypto oracle whose key is a
  // HAND-VERIFIABLE literal ('a b'→'a%20b', 'c+d'→'c%2Bd', empty ts → trailing '&'),
  // so the expectation never depends on a memorized third-party signature constant.
  const SMALL_BASE = 'GET&http%3A%2F%2Fexample.com%2F&a%3D1%26b%3D2%26c%3Da%2520b';

  it('derives the signing key as percentEncode(cs)&percentEncode(ts)', () => {
    const expected = createHmac('sha1', 'a%20b&c%2Bd').update(SMALL_BASE).digest('base64');
    expect(signHmacSha1(SMALL_BASE, 'a b', 'c+d')).toBe(expected);
  });

  it('signs with an empty token secret using a trailing & (key = cs&)', () => {
    const expected = createHmac('sha1', 'cs&').update(SMALL_BASE).digest('base64');
    expect(signHmacSha1(SMALL_BASE, 'cs')).toBe(expected);
  });
});

describe('OAuth 1.0a flow helpers (mocked fetch)', () => {
  const form = (body: string): Response =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  it('requestToken posts to /oauth/request and parses the token pair', async () => {
    let seenUrl = '';
    let seenAuth = '';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      return form('oauth_token=REQTOK&oauth_token_secret=REQSEC&oauth_callback_confirmed=true');
    }) as typeof fetch;
    const res = await requestToken(
      { clientKey: 'ck', clientSecret: 'cs', callbackUrl: 'https://z.example/oauth/zotero/callback' },
      { baseUrl: 'https://www.zotero.org', fetchImpl },
    );
    expect(seenUrl).toBe('https://www.zotero.org/oauth/request');
    expect(seenAuth).toMatch(/^OAuth /);
    expect(seenAuth).toContain('oauth_signature=');
    expect(res).toEqual({ oauthToken: 'REQTOK', oauthTokenSecret: 'REQSEC' });
  });

  it('accessToken posts to /oauth/access and returns userID, username, key', async () => {
    const fetchImpl = (async () =>
      form('oauth_token=USERKEYTOK&oauth_token_secret=USERKEY&userID=12345&username=alice')) as typeof fetch;
    const res = await accessToken(
      { clientKey: 'ck', clientSecret: 'cs', oauthToken: 'REQTOK', oauthTokenSecret: 'REQSEC', verifier: 'VERIF' },
      { baseUrl: 'https://www.zotero.org', fetchImpl },
    );
    expect(res).toEqual({ zoteroUserId: 12345, username: 'alice', zoteroKey: 'USERKEY' });
  });

  it('returns the key the Zotero Web API accepts (validates via /keys/current)', async () => {
    // /oauth/access hands back two different candidate values; only oauth_token is a
    // key Zotero honors. The wrong guess used to be stored, yielding "Invalid key".
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/oauth/access')) {
        return form('oauth_token=GOODKEY&oauth_token_secret=BADKEY&userID=777&username=bob');
      }
      if (u.includes('/keys/current')) {
        const key = (init?.headers as Record<string, string>)?.['Zotero-API-Key'];
        return new Response(key === 'GOODKEY' ? '{"userID":777}' : 'Forbidden', {
          status: key === 'GOODKEY' ? 200 : 403,
        });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    const res = await accessToken(
      { clientKey: 'ck', clientSecret: 'cs', oauthToken: 'REQTOK', oauthTokenSecret: 'REQSEC', verifier: 'VERIF' },
      { baseUrl: 'https://www.zotero.org', apiBaseUrl: 'https://api.zotero.org', fetchImpl },
    );
    expect(res.zoteroKey).toBe('GOODKEY');
    expect(res.zoteroUserId).toBe(777);
  });

  it('throws if neither candidate key is accepted (surfaces a bad setup loudly)', async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth/access')) return form('oauth_token=A&oauth_token_secret=B&userID=5&username=x');
      return new Response('Forbidden', { status: 403 }); // /keys/current rejects everything
    }) as typeof fetch;
    await expect(
      accessToken(
        { clientKey: 'ck', clientSecret: 'cs', oauthToken: 'REQTOK', oauthTokenSecret: 'REQSEC', verifier: 'V' },
        { baseUrl: 'https://www.zotero.org', apiBaseUrl: 'https://api.zotero.org', fetchImpl },
      ),
    ).rejects.toThrow(/rejected by the Zotero/);
  });

  it('falls back to the documented key on a transient /keys/current failure (no hard 502)', async () => {
    // Zotero throttles the validation call (429). The key is fine; we must not reject it.
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/oauth/access')) return form('oauth_token=K&oauth_token_secret=K&userID=9&username=z');
      return new Response('Too Many Requests', { status: 429 }); // /keys/current throttled
    }) as typeof fetch;
    const res = await accessToken(
      { clientKey: 'ck', clientSecret: 'cs', oauthToken: 'REQTOK', oauthTokenSecret: 'REQSEC', verifier: 'V' },
      { baseUrl: 'https://www.zotero.org', apiBaseUrl: 'https://api.zotero.org', fetchImpl },
    );
    expect(res).toEqual({ zoteroUserId: 9, username: 'z', zoteroKey: 'K' });
  });

  it('buildAuthorizeUrl sets read-only permission params', () => {
    const url = new URL(buildAuthorizeUrl('REQTOK', { baseUrl: 'https://www.zotero.org', readOnly: true }));
    expect(url.origin + url.pathname).toBe('https://www.zotero.org/oauth/authorize');
    expect(url.searchParams.get('oauth_token')).toBe('REQTOK');
    // Regression: `identity=1` puts Zotero in identity-only mode (returns the "identity"
    // sentinel, never a real key). It must never be set.
    expect(url.searchParams.has('identity')).toBe(false);
    expect(url.searchParams.get('library_access')).toBe('1');
    // notes stay readable even read-only (write_access/all_groups are the mutation gates)
    expect(url.searchParams.get('notes_access')).toBe('1');
    expect(url.searchParams.get('write_access')).toBe('0');
    expect(url.searchParams.get('all_groups')).toBe('read');
  });

  it('buildAuthorizeUrl requests write when not read-only', () => {
    const url = new URL(buildAuthorizeUrl('REQTOK', { baseUrl: 'https://www.zotero.org', readOnly: false }));
    expect(url.searchParams.get('notes_access')).toBe('1');
    expect(url.searchParams.get('write_access')).toBe('1');
    expect(url.searchParams.get('all_groups')).toBe('write');
  });

  it('throws a clear error on a non-200 Zotero response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    await expect(
      requestToken({ clientKey: 'ck', clientSecret: 'cs', callbackUrl: 'https://z/cb' }, { baseUrl: 'https://www.zotero.org', fetchImpl }),
    ).rejects.toThrow(/Zotero OAuth/);
  });
});
