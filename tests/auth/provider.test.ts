import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';
import pkceChallenge from 'pkce-challenge';
import { ZoteusOAuthProvider } from '../../src/auth/provider.js';
import { MemoryStore } from '../../src/auth/store.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

function makeProvider(): ZoteusOAuthProvider {
  return new ZoteusOAuthProvider({
    mode: 'passcode',
    passcode: 'secret-passcode',
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 2592000,
  });
}

async function registerClient(p: ZoteusOAuthProvider, redirect = 'http://localhost:7777/callback'): Promise<OAuthClientInformationFull> {
  return (await p.clientsStore.registerClient!({
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
    client_name: 'Test Client',
  })) as OAuthClientInformationFull;
}

// Minimal express Response double recording redirect/HTML output.
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  redirectedTo?: string;
}
function fakeRes(): Response & FakeRes {
  const r: Partial<FakeRes> & Record<string, unknown> = { statusCode: 200, headers: {}, body: '' };
  r.setHeader = (k: string, v: string) => {
    (r.headers as Record<string, string>)[k] = v;
    return r;
  };
  r.set = r.setHeader;
  r.status = (c: number) => {
    r.statusCode = c;
    return r;
  };
  r.send = (b: string) => {
    r.body = b;
    return r;
  };
  r.type = () => r;
  r.redirect = (codeOrUrl: number | string, maybeUrl?: string) => {
    r.redirectedTo = typeof codeOrUrl === 'number' ? maybeUrl : codeOrUrl;
    r.statusCode = typeof codeOrUrl === 'number' ? codeOrUrl : 302;
    return r;
  };
  return r as unknown as Response & FakeRes;
}

const authIdFrom = (html: string): string => /name="auth_id" value="([^"]+)"/.exec(html)![1];

describe('ZoteusOAuthProvider', () => {
  let p: ZoteusOAuthProvider;
  beforeEach(() => {
    p = makeProvider();
  });

  it('registers and retrieves clients, generating client_id for public clients (no secret)', async () => {
    const c = await registerClient(p);
    expect(c.client_id).toBeTruthy();
    expect(c.client_secret).toBeUndefined();
    expect(await p.clientsStore.getClient(c.client_id)).toMatchObject({ client_id: c.client_id });
  });

  it('authorize renders the consent page with a hidden auth_id, client name, and redirect host', async () => {
    const c = await registerClient(p);
    const res = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'abc', state: 'st', scopes: [] }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="auth_id"');
    expect(res.body).toContain('Test Client');
    expect(res.body).toContain('localhost:7777');
  });

  it('rejects consent with wrong passcode (re-renders 401, no redirect)', async () => {
    const c = await registerClient(p);
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'abc', state: 'st', scopes: [] }, res1);
    const authId = authIdFrom(res1.body);
    const res2 = fakeRes();
    await p.completeConsent(authId, 'wrong', res2);
    expect(res2.redirectedTo).toBeUndefined();
    expect(res2.statusCode).toBe(401);
    expect(res2.body).toContain('Incorrect');
  });

  it('locks out the pending consent after too many wrong passcodes', async () => {
    const c = await registerClient(p);
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'abc', scopes: [] }, res1);
    const authId = authIdFrom(res1.body);
    for (let i = 0; i < 4; i++) {
      const r = fakeRes();
      await p.completeConsent(authId, 'wrong', r);
      expect(r.statusCode).toBe(401);
    }
    const fifth = fakeRes();
    await p.completeConsent(authId, 'wrong', fifth);
    expect(fifth.statusCode).toBe(429);
    // pending now deleted: even the correct passcode no longer works
    const after = fakeRes();
    await p.completeConsent(authId, 'secret-passcode', after);
    expect(after.statusCode).toBe(400);
    expect(after.redirectedTo).toBeUndefined();
  });

  it('full PKCE S256 flow: consent -> code -> token -> verify', async () => {
    const c = await registerClient(p);
    const { code_verifier, code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, state: 'xyz', scopes: ['zoteus'] }, res1);
    const authId = authIdFrom(res1.body);

    const res2 = fakeRes();
    await p.completeConsent(authId, 'secret-passcode', res2);
    expect(res2.statusCode).toBe(302);
    const loc = new URL(res2.redirectedTo!);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();
    // never leak a token in the redirect query
    expect(res2.redirectedTo).not.toMatch(/access_token|token=/);

    // SDK token handler verifies PKCE using this challenge:
    expect(await p.challengeForAuthorizationCode(c, code)).toBe(code_challenge);

    const tokens = await p.exchangeAuthorizationCode(c, code, code_verifier, c.redirect_uris[0]);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBe(3600);

    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(c.client_id);
    expect(typeof info.expiresAt).toBe('number');
    expect(info.scopes).toEqual(['zoteus']);
  });

  it('rejects an exchange whose redirect_uri does not match the code', async () => {
    const c = await registerClient(p);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const res2 = fakeRes();
    await p.completeConsent(authIdFrom(res1.body), 'secret-passcode', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    await expect(p.exchangeAuthorizationCode(c, code, undefined, 'http://localhost:1/other')).rejects.toThrow();
  });

  it('authorization codes are single-use', async () => {
    const c = await registerClient(p);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const res2 = fakeRes();
    await p.completeConsent(authIdFrom(res1.body), 'secret-passcode', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    await expect(p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0])).rejects.toThrow();
  });

  it('verifyAccessToken rejects unknown and expired tokens', async () => {
    await expect(p.verifyAccessToken('nope')).rejects.toThrow();
    const short = new ZoteusOAuthProvider({ mode: 'passcode', passcode: 'secret-passcode', accessTokenTtlSec: -1, refreshTokenTtlSec: 10 });
    const c = await registerClient(short);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await short.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const res2 = fakeRes();
    await short.completeConsent(authIdFrom(res1.body), 'secret-passcode', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    const t = await short.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    await expect(short.verifyAccessToken(t.access_token)).rejects.toThrow();
  });

  it('refresh token mints a new access token; revoke invalidates', async () => {
    const c = await registerClient(p);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const res2 = fakeRes();
    await p.completeConsent(authIdFrom(res1.body), 'secret-passcode', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    const t1 = await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    const t2 = await p.exchangeRefreshToken(c, t1.refresh_token!);
    expect(t2.access_token).toBeTruthy();
    expect(t2.access_token).not.toBe(t1.access_token);
    await p.revokeToken!(c, { token: t2.access_token });
    await expect(p.verifyAccessToken(t2.access_token)).rejects.toThrow();
  });
});

describe('provider onEvent', () => {
  it('emits auth_failed on wrong passcode', async () => {
    const onEvent = vi.fn();
    const p = new ZoteusOAuthProvider({
      mode: 'passcode',
      passcode: 'correct-passcode',
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
      onEvent,
    });
    const client = await registerClient(p);
    const res1 = fakeRes();
    await p.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'abc', state: 'st', scopes: [] }, res1);
    const authId = authIdFrom(res1.body);
    const res2 = fakeRes();
    await p.completeConsent(authId, 'wrong-passcode', res2);
    expect(res2.statusCode).toBe(401);
    expect(onEvent).toHaveBeenCalledWith('auth_failed');
    expect(onEvent).not.toHaveBeenCalledWith('token_issued');
  });

  it('emits token_issued when tokens are minted', async () => {
    const onEvent = vi.fn();
    const p = new ZoteusOAuthProvider({
      mode: 'passcode',
      passcode: 'passcode-1234',
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
      onEvent,
    });
    // exercise via refresh exchange (issues tokens). Register a client + refresh record first:
    const client = p.clientsStore.registerClient!({ redirect_uris: ['http://localhost/cb'] } as never);
    // Seed a refresh token through the store-backed path:
    // (Use the public exchangeRefreshToken with a token we set directly.)
    // Set up a refresh token in the store:
    (p as never as { store: { setRefresh: (t: string, r: unknown) => void } }).store.setRefresh('r1', {
      clientId: client.client_id,
      scopes: ['zoteus'],
      expiresAt: Date.now() + 60_000,
    });
    await p.exchangeRefreshToken(client, 'r1', ['zoteus']);
    expect(onEvent).toHaveBeenCalledWith('token_issued');
  });
});

// A tiny mock Zotero OAuth 1.0a endpoint set, served by overriding the provider's fetchImpl.
function mockZoteroFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const form = (s: string) =>
      new Response(s, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    if (u.endsWith('/oauth/request')) return form('oauth_token=REQTOK&oauth_token_secret=REQSEC&oauth_callback_confirmed=true');
    if (u.endsWith('/oauth/access')) return form('oauth_token=UT&oauth_token_secret=USERKEY-77&userID=77&username=carol');
    if (u.endsWith('/keys/current')) return new Response('{"userID":77}', { status: 200 }); // Zotero accepts the key
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function zoteroProvider(): ZoteusOAuthProvider {
  return new ZoteusOAuthProvider({
    mode: 'zotero',
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 2592000,
    store: new MemoryStore(),
    zotero: {
      clientKey: 'ck',
      clientSecret: 'cs',
      callbackUrl: 'https://z.example/oauth/zotero/callback',
      readOnly: true,
      baseUrl: 'https://www.zotero.org',
      fetchImpl: mockZoteroFetch(),
    },
  });
}

describe('ZoteusOAuthProvider — zotero (multi-tenant) mode', () => {
  it('authorize redirects the browser to zotero.org with a request token', async () => {
    const p = zoteroProvider();
    const c = await registerClient(p);
    const res = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'abc', state: 'st', scopes: ['zoteus'] }, res);
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.redirectedTo!);
    expect(loc.origin + loc.pathname).toBe('https://www.zotero.org/oauth/authorize');
    expect(loc.searchParams.get('oauth_token')).toBe('REQTOK');
    expect(loc.searchParams.get('write_access')).toBe('0');
  });

  it('callback exchanges the verifier and mints a code bound to the per-user key', async () => {
    const p = zoteroProvider();
    const c = await registerClient(p);
    const a = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'chal', state: 'xyz', scopes: ['zoteus'] }, a);

    const cb = fakeRes();
    await p.completeZoteroCallback('REQTOK', 'VERIF', cb);
    expect(cb.statusCode).toBe(302);
    const loc = new URL(cb.redirectedTo!);
    expect(loc.origin + loc.pathname).toBe('http://localhost:7777/callback');
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    expect(await p.challengeForAuthorizationCode(c, code)).toBe('chal');
    const tokens = await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.extra).toMatchObject({ zoteroKey: 'USERKEY-77', zoteroUserId: 77, username: 'carol' });
    expect(typeof info.expiresAt).toBe('number');
  });

  it('the per-user identity survives a refresh-token rotation', async () => {
    const p = zoteroProvider();
    const c = await registerClient(p);
    const a = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'chal', scopes: ['zoteus'] }, a);
    const cb = fakeRes();
    await p.completeZoteroCallback('REQTOK', 'VERIF', cb);
    const code = new URL(cb.redirectedTo!).searchParams.get('code')!;
    const t1 = await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    const t2 = await p.exchangeRefreshToken(c, t1.refresh_token!);
    const info = await p.verifyAccessToken(t2.access_token);
    expect(info.extra).toMatchObject({ zoteroUserId: 77 });
  });

  it('callback with an unknown oauth_token renders an error page (no redirect)', async () => {
    const p = zoteroProvider();
    const res = fakeRes();
    await p.completeZoteroCallback('UNKNOWN', 'VERIF', res);
    expect(res.redirectedTo).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });
});

describe('provider CIMD client resolution', () => {
  const url = 'https://claude.ai/.well-known/oauth-client';
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  it('resolves a URL client_id via CIMD without DCR', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: ['https://claude.ai/cb'], token_endpoint_auth_method: 'none' }),
    ) as unknown as typeof fetch;
    const p = new ZoteusOAuthProvider({
      mode: 'passcode',
      passcode: 'secret-passcode',
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
      cimd: {
        enabled: true,
        cacheTtlSec: 3600,
        maxBytes: 16384,
        allowedRedirectSchemes: ['https'],
        fetchImpl,
        lookupImpl: async () => ['93.184.216.34'],
      },
    });
    const client = await p.clientsStore.getClient(url);
    expect(client?.client_id).toBe(url);
    expect(client?.redirect_uris).toEqual(['https://claude.ai/cb']);
    // second lookup is cached → no second fetch
    await p.clientsStore.getClient(url);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns undefined for an unknown opaque id when CIMD is on (DCR untouched)', async () => {
    const p = new ZoteusOAuthProvider({
      mode: 'passcode',
      passcode: 'secret-passcode',
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
      cimd: { enabled: true, cacheTtlSec: 3600, maxBytes: 16384, allowedRedirectSchemes: ['https'] },
    });
    expect(await p.clientsStore.getClient('opaque-dcr-id')).toBeUndefined();
  });

  it('ignores URL client_ids when CIMD is disabled', async () => {
    const p = new ZoteusOAuthProvider({
      mode: 'passcode',
      passcode: 'secret-passcode',
      accessTokenTtlSec: 60,
      refreshTokenTtlSec: 600,
    });
    expect(await p.clientsStore.getClient(url)).toBeUndefined();
  });
});
