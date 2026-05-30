import { describe, it, expect } from 'vitest';
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

  it('computes the canonical HMAC-SHA1 signature', () => {
    const base =
      'POST&https%3A%2F%2Fapi.twitter.com%2F1%2Fstatuses%2Fupdate.json&' +
      'include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26' +
      'oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26' +
      'oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26' +
      'oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26' +
      'oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521';
    // HMAC-SHA1(key, base) base64 for the canonical base string with
    // key = consumerSecret&tokenSecret (node:crypto is the authoritative oracle).
    const sig = signHmacSha1(base, 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7', 'LswwdoUaIvS4TZeYd0qagO5j5y6OdtNNiyN4Q1lcL');
    expect(sig).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  });

  // The signing key is percentEncode(consumerSecret)&percentEncode(tokenSecret). These two
  // cases pin that derivation: reserved chars in the secrets must be encoded, and the empty
  // token secret (the request-token step) still appends a trailing '&'.
  const SMALL_BASE = 'GET&http%3A%2F%2Fexample.com%2F&a%3D1%26b%3D2%26c%3Da%2520b';

  it('derives the signing key with percent-encoded secrets (key = a%20b&c%2Bd)', () => {
    expect(signHmacSha1(SMALL_BASE, 'a b', 'c+d')).toBe('wTfdngFkw0Q6T6f0Ej/8mZbjQ4Q=');
  });

  it('signs with an empty token secret using a trailing & (key = cs&)', () => {
    expect(signHmacSha1(SMALL_BASE, 'cs')).toBe('Sb27JjFmH8B9Rh+8aZTSjFmkjwY=');
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

  it('buildAuthorizeUrl sets read-only permission params', () => {
    const url = new URL(buildAuthorizeUrl('REQTOK', { baseUrl: 'https://www.zotero.org', readOnly: true }));
    expect(url.origin + url.pathname).toBe('https://www.zotero.org/oauth/authorize');
    expect(url.searchParams.get('oauth_token')).toBe('REQTOK');
    expect(url.searchParams.get('library_access')).toBe('1');
    expect(url.searchParams.get('write_access')).toBe('0');
    expect(url.searchParams.get('all_groups')).toBe('read');
  });

  it('buildAuthorizeUrl requests write when not read-only', () => {
    const url = new URL(buildAuthorizeUrl('REQTOK', { baseUrl: 'https://www.zotero.org', readOnly: false }));
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
