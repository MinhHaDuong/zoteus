# M11 — Multi-tenant (per-user Zotero accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zoteus multi-tenant — each claude.ai user authorizes their own Zotero account via Zotero OAuth 1.0a (bridged under the existing OAuth 2.1 connector), and every MCP call runs against that user's library.

**Architecture:** Keep the M10 OAuth 2.1 server unchanged for claude.ai. Add a config-selected consent strategy (`ZOTEUS_OAUTH_MODE=passcode|zotero`, default `passcode`). In `zotero` mode, `provider.authorize()` starts Zotero OAuth 1.0a and redirects to zotero.org; a new `GET /oauth/zotero/callback` exchanges for the per-user Zotero key + userID, mints a user-bound auth code, and completes the OAuth 2.1 flow. Issued bearer tokens carry `{zoteroKey, zoteroUserId, username}` in `AuthInfo.extra`. The HTTP per-session factory becomes auth-aware: on `initialize` it resolves a per-user `ToolContext` (cached/LRU by `zoteroUserId`) whose `WebApiClient` uses that user's key. A pluggable `OAuthStore` (default in-memory; optional AES-256-GCM-encrypted JSON file) persists clients + tokens + per-user keys across restarts. Semantic index is scoped per user.

**Tech Stack:** TypeScript NodeNext ESM, `@modelcontextprotocol/sdk@^1.29` (auth helpers), `express@5`, `node:crypto` (HMAC-SHA1 for OAuth 1.0a, AES-256-GCM for at-rest), Vitest. No new runtime dependencies.

## Key SDK contracts (verified against installed SDK 1.29)

- `AuthInfo` = `{ token, clientId, scopes, expiresAt?, resource?, extra?: Record<string, unknown>, [k]: unknown }`. `requireBearerAuth` rejects a token whose `expiresAt` is not a finite number when present; we always set it.
- `requireBearerAuth({ verifier, requiredScopes?, resourceMetadataUrl? })` calls `verifier.verifyAccessToken(token)` then sets `req.auth = authInfo`. So in an Express route mounted *after* the guard, `req.auth` holds the full `AuthInfo` including `extra`.
- `OAuthServerProvider`: `clientsStore`, `authorize(client, params, res)`, `challengeForAuthorizationCode(client, code)`, `exchangeAuthorizationCode(client, code, codeVerifier?, redirectUri?, resource?)`, `exchangeRefreshToken(client, refreshToken, scopes?, resource?)`, `verifyAccessToken(token)`, `revokeToken?`.
- `AuthorizationParams` = `{ state?, scopes?, redirectUri, codeChallenge, resource?: URL }`.
- `WebApiClient` already accepts `{ apiKey, baseUrl?, fetcher, contactEmail, logger }`; `RateLimitedFetcher` captures `globalThis.fetch` at construction — so a test that stubs `globalThis.fetch` before `buildContext` runs is picked up.

## File structure

**New**
- `src/auth/zotero-oauth.ts` — OAuth 1.0a signing (`percentEncode`, base string, HMAC-SHA1 `sign`) + `requestToken` / `accessToken` / `buildAuthorizeUrl`. Late-bound `fetch` (overridable for tests). One responsibility: speak Zotero OAuth 1.0a.
- `src/auth/store.ts` — `OAuthStore` interface, `StoredAccess`/`StoredRefresh` types, `MemoryStore`, encrypted `FileStore`. One responsibility: persist OAuth clients/tokens/keys.
- `tests/auth/zotero-oauth.test.ts`, `tests/auth/store.test.ts`, `tests/integration/multitenant.test.ts`.

**Modified**
- `src/config.ts` — new env vars + cross-field validation.
- `src/auth/provider.ts` — inject `OAuthStore`; consent strategy (passcode|zotero); token records carry Zotero identity; `verifyAccessToken` → `extra`; `completeZoteroCallback`.
- `src/auth/router.ts` — mount `GET /oauth/zotero/callback` in zotero mode; build provider with mode/creds/store.
- `src/server.ts` — split into `buildContext(config, overrides)` + `createServer(ctx)`; add `ContextCache`; keep `buildServer` wrapper; bump VERSION `0.10.0`.
- `src/transports/http.ts` — auth-aware `McpServerFactory` (`(authInfo?) => ...`).
- `src/index.ts` — wire `ContextCache` + auth-aware factory.
- `src/registry/registry.ts` — add `searchIndexPath` to `ToolContext`.
- `src/tools/index-tool.ts` — use `ctx.searchIndexPath`.
- `package.json` — `0.10.0`.
- `Dockerfile`, `docs/remote-oauth.md`, `docs/configuration.md`, `.env.example`, `README.md`.

**Conventions:** every relative import ends in `.js`. Commits carry **no** co-authoring/attribution trailers. Run the gate (`npm run typecheck && npm run lint && npm run build && npm test`) green before each commit where practical; always before the final tag.

---

## Task 1: Config — M11 OAuth settings + validation

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests** — append inside `tests/config.test.ts` (a new `describe`):

```ts
describe('m11 multi-tenant config', () => {
  const base = {
    ZOTEUS_OAUTH_ENABLED: 'true',
    ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com',
  } as NodeJS.ProcessEnv;

  it('defaults oauth.mode to passcode and store to memory', () => {
    const c = loadConfig({ ...base, ZOTEUS_OAUTH_PASSCODE: 'passcode-1234' } as NodeJS.ProcessEnv);
    expect(c.oauth.mode).toBe('passcode');
    expect(c.oauth.store).toBe('memory');
  });

  it('parses zotero mode with client credentials', () => {
    const c = loadConfig({
      ...base,
      ZOTEUS_OAUTH_MODE: 'zotero',
      ZOTERO_OAUTH_CLIENT_KEY: 'ck',
      ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
    } as NodeJS.ProcessEnv);
    expect(c.oauth.mode).toBe('zotero');
    expect(c.oauth.zoteroClientKey).toBe('ck');
    expect(c.oauth.zoteroClientSecret).toBe('cs');
  });

  it('does NOT require a passcode in zotero mode', () => {
    expect(() =>
      loadConfig({
        ...base,
        ZOTEUS_OAUTH_MODE: 'zotero',
        ZOTERO_OAUTH_CLIENT_KEY: 'ck',
        ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('throws in zotero mode without Zotero client credentials', () => {
    expect(() =>
      loadConfig({ ...base, ZOTEUS_OAUTH_MODE: 'zotero' } as NodeJS.ProcessEnv),
    ).toThrow(/ZOTERO_OAUTH_CLIENT_KEY/);
  });

  it('still requires a passcode in passcode mode', () => {
    expect(() => loadConfig(base)).toThrow(/ZOTEUS_OAUTH_PASSCODE/);
  });

  it('requires a token secret when store=file', () => {
    expect(() =>
      loadConfig({
        ...base,
        ZOTEUS_OAUTH_MODE: 'zotero',
        ZOTERO_OAUTH_CLIENT_KEY: 'ck',
        ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
        ZOTEUS_OAUTH_STORE: 'file',
      } as NodeJS.ProcessEnv),
    ).toThrow(/ZOTEUS_OAUTH_TOKEN_SECRET/);
  });

  it('accepts store=file with a token secret', () => {
    const c = loadConfig({
      ...base,
      ZOTEUS_OAUTH_MODE: 'zotero',
      ZOTERO_OAUTH_CLIENT_KEY: 'ck',
      ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
      ZOTEUS_OAUTH_STORE: 'file',
      ZOTEUS_OAUTH_TOKEN_SECRET: 'a'.repeat(32),
    } as NodeJS.ProcessEnv);
    expect(c.oauth.store).toBe('file');
    expect(c.oauth.tokenSecret).toBe('a'.repeat(32));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts -t "m11 multi-tenant config"`
Expected: FAIL (`oauth.mode` undefined / no throws).

- [ ] **Step 3: Implement** — in `src/config.ts`:

Extend the `oauth` block of the `ZoteusConfig` interface (add after `allowedHosts: string[];`):

```ts
    mode: 'passcode' | 'zotero';
    zoteroClientKey?: string;
    zoteroClientSecret?: string;
    store: 'memory' | 'file';
    tokenSecret?: string;
```

Add to the zod `schema` object (after `ZOTEUS_ALLOWED_HOSTS`):

```ts
    ZOTEUS_OAUTH_MODE: z.enum(['passcode', 'zotero']).default('passcode'),
    ZOTERO_OAUTH_CLIENT_KEY: z.string().min(1).optional(),
    ZOTERO_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    ZOTEUS_OAUTH_STORE: z.enum(['memory', 'file']).default('memory'),
    ZOTEUS_OAUTH_TOKEN_SECRET: z.string().min(1).optional(),
```

Replace the existing `if (oauthEnabled) { ... }` validation block with mode-aware validation:

```ts
  const oauthEnabled = parsed.ZOTEUS_OAUTH_ENABLED;
  const publicUrl = parsed.ZOTEUS_PUBLIC_URL?.replace(/\/+$/, '');
  const mode = parsed.ZOTEUS_OAUTH_MODE;
  const store = parsed.ZOTEUS_OAUTH_STORE;
  if (oauthEnabled) {
    if (!publicUrl) throw new Error('ZOTEUS_PUBLIC_URL is required when ZOTEUS_OAUTH_ENABLED=true');
    if (mode === 'passcode') {
      if (!parsed.ZOTEUS_OAUTH_PASSCODE) throw new Error('ZOTEUS_OAUTH_PASSCODE is required when ZOTEUS_OAUTH_ENABLED=true (passcode mode)');
      if (parsed.ZOTEUS_OAUTH_PASSCODE.length < MIN_PASSCODE_LENGTH) {
        throw new Error(
          `ZOTEUS_OAUTH_PASSCODE must be at least ${MIN_PASSCODE_LENGTH} characters (generate one with: openssl rand -base64 24)`,
        );
      }
    } else {
      // zotero mode: per-user Zotero login replaces the shared passcode
      if (!parsed.ZOTERO_OAUTH_CLIENT_KEY || !parsed.ZOTERO_OAUTH_CLIENT_SECRET) {
        throw new Error(
          'ZOTERO_OAUTH_CLIENT_KEY and ZOTERO_OAUTH_CLIENT_SECRET are required when ZOTEUS_OAUTH_MODE=zotero (register an app at https://www.zotero.org/oauth/apps)',
        );
      }
    }
    if (store === 'file' && !parsed.ZOTEUS_OAUTH_TOKEN_SECRET) {
      throw new Error(
        'ZOTEUS_OAUTH_TOKEN_SECRET is required when ZOTEUS_OAUTH_STORE=file (used to encrypt stored Zotero keys at rest; generate one with: openssl rand -base64 32)',
      );
    }
  }
```

Add to the returned `oauth` object (after `allowedHosts`):

```ts
      mode,
      zoteroClientKey: parsed.ZOTERO_OAUTH_CLIENT_KEY,
      zoteroClientSecret: parsed.ZOTERO_OAUTH_CLIENT_SECRET,
      store,
      tokenSecret: parsed.ZOTEUS_OAUTH_TOKEN_SECRET,
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (existing + new cases).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "M11: config for oauth mode (passcode|zotero), zotero client creds, store, token secret"
```

---

## Task 2: Zotero OAuth 1.0a signing + flow helpers

**Files:**
- Create: `src/auth/zotero-oauth.ts`
- Test: `tests/auth/zotero-oauth.test.ts`

- [ ] **Step 1: Write failing tests** (`tests/auth/zotero-oauth.test.ts`):

```ts
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

  // Canonical Twitter "Creating a signature" vector (RFC 5849 HMAC-SHA1).
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
    const sig = signHmacSha1(base, 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Y7', 'LswwdoUaIvS4TZeYd0qagO5j5y6OdtNNiyN4Q1lcL');
    expect(sig).toBe('tnnArxj06cWHq44gCs1OSKk/jLY=');
  });

  it('signs with an empty token secret (request-token step) without trailing junk', () => {
    // key becomes "consumerSecret&" — just assert it runs and returns base64
    const sig = signHmacSha1('GET&http%3A%2F%2Fexample.com&a%3D1', 'cs');
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/auth/zotero-oauth.test.ts`
Expected: FAIL (module not found). If the Twitter base-string/signature literals mismatch the published vector, reconcile against https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature before changing the implementation — the constants are authoritative.

- [ ] **Step 3: Implement** (`src/auth/zotero-oauth.ts`):

```ts
import { createHmac, randomBytes } from 'node:crypto';

const ZOTERO_BASE = 'https://www.zotero.org';

/** RFC 3986 percent-encoding (OAuth 1.0a §3.6): only A-Z a-z 0-9 - . _ ~ stay literal. */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Build the RFC 5849 §3.4.1 signature base string from method, base URL, and all (oauth_+query+body) params. */
export function buildSignatureBaseString(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
): string {
  const normalized = Object.keys(params)
    .map((k) => [percentEncode(k), percentEncode(params[k])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [method.toUpperCase(), percentEncode(baseUrl), percentEncode(normalized)].join('&');
}

/** HMAC-SHA1 signature (base64) with key = percentEncode(consumerSecret)&percentEncode(tokenSecret). */
export function signHmacSha1(baseString: string, consumerSecret: string, tokenSecret = ''): string {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', key).update(baseString).digest('base64');
}

interface SignedHeaderInput {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  extra?: Record<string, string>; // additional oauth_* params, e.g. oauth_callback / oauth_verifier
}

/** Compose the `Authorization: OAuth ...` header for a signed request. */
function authorizationHeader(input: SignedHeaderInput): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0',
    ...(input.token ? { oauth_token: input.token } : {}),
    ...(input.extra ?? {}),
  };
  const base = buildSignatureBaseString(input.method, input.url, oauth);
  oauth.oauth_signature = signHmacSha1(base, input.consumerSecret, input.tokenSecret ?? '');
  const header = Object.keys(oauth)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
    .join(', ');
  return `OAuth ${header}`;
}

export interface ZoteroOAuthOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

async function postForm(
  url: string,
  authHeader: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, string>> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zotero OAuth request to ${url} failed (${res.status}). ${body.slice(0, 200)}`);
  }
  const text = await res.text();
  return Object.fromEntries(new URLSearchParams(text));
}

export interface RequestTokenInput {
  clientKey: string;
  clientSecret: string;
  callbackUrl: string;
}

/** Step 1: get a temporary request token + secret from /oauth/request. */
export async function requestToken(
  input: RequestTokenInput,
  opts: ZoteroOAuthOptions = {},
): Promise<{ oauthToken: string; oauthTokenSecret: string }> {
  const baseUrl = opts.baseUrl ?? ZOTERO_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl}/oauth/request`;
  const header = authorizationHeader({
    method: 'POST',
    url,
    consumerKey: input.clientKey,
    consumerSecret: input.clientSecret,
    extra: { oauth_callback: input.callbackUrl },
  });
  const parsed = await postForm(url, header, fetchImpl);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error('Zotero OAuth /oauth/request returned no token pair');
  }
  return { oauthToken: parsed.oauth_token, oauthTokenSecret: parsed.oauth_token_secret };
}

export interface AccessTokenInput {
  clientKey: string;
  clientSecret: string;
  oauthToken: string;
  oauthTokenSecret: string;
  verifier: string;
}

/** Step 3: exchange the authorized request token for the permanent per-user key + identity. */
export async function accessToken(
  input: AccessTokenInput,
  opts: ZoteroOAuthOptions = {},
): Promise<{ zoteroUserId: number; username: string; zoteroKey: string }> {
  const baseUrl = opts.baseUrl ?? ZOTERO_BASE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${baseUrl}/oauth/access`;
  const header = authorizationHeader({
    method: 'POST',
    url,
    consumerKey: input.clientKey,
    consumerSecret: input.clientSecret,
    token: input.oauthToken,
    tokenSecret: input.oauthTokenSecret,
    extra: { oauth_verifier: input.verifier },
  });
  const parsed = await postForm(url, header, fetchImpl);
  const userId = Number(parsed.userID);
  if (!parsed.oauth_token_secret || !Number.isFinite(userId)) {
    throw new Error('Zotero OAuth /oauth/access returned no userID/key');
  }
  // Per Zotero docs the oauth_token_secret IS the permanent Zotero API key.
  return { zoteroUserId: userId, username: parsed.username ?? String(userId), zoteroKey: parsed.oauth_token_secret };
}

/** Step 2: the URL the user's browser visits to approve. read-only scopes by default. */
export function buildAuthorizeUrl(
  oauthToken: string,
  opts: { baseUrl?: string; readOnly: boolean; name?: string },
): string {
  const baseUrl = opts.baseUrl ?? ZOTERO_BASE;
  const url = new URL(`${baseUrl}/oauth/authorize`);
  url.searchParams.set('oauth_token', oauthToken);
  url.searchParams.set('identity', '1');
  url.searchParams.set('name', opts.name ?? 'Zoteus');
  url.searchParams.set('library_access', '1');
  url.searchParams.set('notes_access', opts.readOnly ? '0' : '1');
  url.searchParams.set('write_access', opts.readOnly ? '0' : '1');
  url.searchParams.set('all_groups', opts.readOnly ? 'read' : 'write');
  return url.href;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/auth/zotero-oauth.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/auth/zotero-oauth.ts tests/auth/zotero-oauth.test.ts
git commit -m "M11: Zotero OAuth 1.0a signing + request/access/authorize helpers"
```

---

## Task 3: OAuth store (memory + encrypted file)

**Files:**
- Create: `src/auth/store.ts`
- Test: `tests/auth/store.test.ts`

- [ ] **Step 1: Write failing tests** (`tests/auth/store.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    const raw = await (await import('node:fs/promises')).readFile(path, 'utf8');
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/auth/store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`src/auth/store.ts`):

```ts
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
    for (const [k, v] of this.access) if (v.expiresAt < nowSec) (this.access.delete(k), (changed = true));
    for (const [k, v] of this.refresh) if (v.expiresAt < nowMs) (this.refresh.delete(k), (changed = true));
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
    const plain = Buffer.from(JSON.stringify(this.snapshot()), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([iv, tag, ct]).toString('base64');
    const tmp = `${this.path}.tmp-${randomBytes(6).toString('hex')}`;
    this.writing = (async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(tmp, payload);
      await rename(tmp, this.path);
    })();
    return this.writing;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/auth/store.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/auth/store.ts tests/auth/store.test.ts
git commit -m "M11: OAuth store interface + in-memory + AES-256-GCM encrypted file store"
```

---

## Task 4: Provider — inject store, carry Zotero identity, consent strategy + callback

**Files:**
- Modify: `src/auth/provider.ts`
- Test: `tests/auth/provider.test.ts` (extend; existing cases must stay green)

- [ ] **Step 1: Write failing tests** — append a new `describe` to `tests/auth/provider.test.ts`:

```ts
import { MemoryStore } from '../../src/auth/store.js';

// A tiny mock Zotero OAuth 1.0a endpoint set, served by overriding the provider's fetchImpl.
function mockZoteroFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const form = (s: string) =>
      new Response(s, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    if (u.endsWith('/oauth/request')) return form('oauth_token=REQTOK&oauth_token_secret=REQSEC&oauth_callback_confirmed=true');
    if (u.endsWith('/oauth/access')) return form('oauth_token=UT&oauth_token_secret=USERKEY-77&userID=77&username=carol');
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
```

Also update the existing `makeProvider()` helper at the top of the file so passcode-mode construction matches the new options shape:

```ts
function makeProvider(): ZoteusOAuthProvider {
  return new ZoteusOAuthProvider({
    mode: 'passcode',
    passcode: 'secret-passcode',
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 2592000,
  });
}
```

And the short-TTL provider in the "rejects expired" test:

```ts
    const short = new ZoteusOAuthProvider({ mode: 'passcode', passcode: 'secret-passcode', accessTokenTtlSec: -1, refreshTokenTtlSec: 10 });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/auth/provider.test.ts`
Expected: FAIL (new options/`completeZoteroCallback` not implemented).

- [ ] **Step 3: Implement** — rewrite `src/auth/provider.ts`. Changes from M10:

1. New imports + options shape:

```ts
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { renderConsentPage } from './consent.js';
import { MemoryStore, type OAuthStore, type StoredAccess, type StoredRefresh } from './store.js';
import { requestToken, accessToken, buildAuthorizeUrl } from './zotero-oauth.js';

export interface ZoteroBridgeOptions {
  clientKey: string;
  clientSecret: string;
  callbackUrl: string;
  readOnly: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ZoteusOAuthProviderOptions {
  mode: 'passcode' | 'zotero';
  passcode?: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  store?: OAuthStore;
  zotero?: ZoteroBridgeOptions;
}
```

2. Identity bundle + extended record/pending types (delete the old `StoredAccess`/`StoredRefresh` interfaces here — they now live in `store.ts`):

```ts
interface ZoteroIdentity {
  zoteroKey: string;
  zoteroUserId: number;
  username: string;
}

interface PendingConsent {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  attempts: number;
  expiresAt: number; // ms
  zoteroReqTokenSecret?: string; // zotero mode: secret for the request token (key = the request token)
}
interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
  identity?: ZoteroIdentity;
}
```

3. Constructor + fields — keep `pending`/`codes` in memory; route clients/access/refresh through the store:

```ts
export class ZoteusOAuthProvider implements OAuthServerProvider {
  private readonly store: OAuthStore;
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, StoredCode>();

  constructor(private readonly opts: ZoteusOAuthProviderOptions) {
    this.store = opts.store ?? new MemoryStore();
    if (opts.mode === 'passcode' && !opts.passcode) throw new Error('passcode mode requires a passcode');
    if (opts.mode === 'zotero' && !opts.zotero) throw new Error('zotero mode requires zotero bridge options');
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.store.getClient(id),
    registerClient: (info) => {
      const partial = info as Partial<OAuthClientInformationFull>;
      const client_id = partial.client_id ?? randomUUID();
      const full = {
        ...info,
        client_id,
        client_id_issued_at: partial.client_id_issued_at ?? nowSec(),
      } as OAuthClientInformationFull;
      this.capClients();
      this.store.setClient(full);
      return full;
    },
  };
```

4. `authorize` — branch on mode:

```ts
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.sweep();
    if (this.opts.mode === 'zotero') return this.authorizeViaZotero(client, params, res);
    const authId = randomUUID();
    this.pending.set(authId, {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      attempts: 0,
      expiresAt: Date.now() + CONSENT_TTL_MS,
    });
    this.sendConsent(res, 200, authId, client.client_name ?? client.client_id, params.redirectUri);
  }

  private async authorizeViaZotero(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const z = this.opts.zotero!;
    const { oauthToken, oauthTokenSecret } = await requestToken(
      { clientKey: z.clientKey, clientSecret: z.clientSecret, callbackUrl: z.callbackUrl },
      { baseUrl: z.baseUrl, fetchImpl: z.fetchImpl },
    );
    // Key the pending consent by the Zotero request token so the callback can recover it.
    this.pending.set(oauthToken, {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      attempts: 0,
      expiresAt: Date.now() + CONSENT_TTL_MS,
      zoteroReqTokenSecret: oauthTokenSecret,
    });
    res.redirect(302, buildAuthorizeUrl(oauthToken, { baseUrl: z.baseUrl, readOnly: z.readOnly }));
  }
```

5. New `completeZoteroCallback` (analogous to `completeConsent`):

```ts
  /** Zotero OAuth 1.0a callback: exchange the verifier for the per-user key, then mint a user-bound code. */
  async completeZoteroCallback(oauthToken: string, verifier: string, res: Response): Promise<void> {
    this.sweep();
    const pc = this.pending.get(oauthToken);
    if (!pc || pc.expiresAt < Date.now() || !pc.zoteroReqTokenSecret) {
      this.pending.delete(oauthToken);
      this.sendConsent(res, 400, oauthToken, 'this client', '', 'Session expired — please reconnect from the client.');
      return;
    }
    this.pending.delete(oauthToken);
    const z = this.opts.zotero!;
    let identity: ZoteroIdentity;
    try {
      identity = await accessToken(
        {
          clientKey: z.clientKey,
          clientSecret: z.clientSecret,
          oauthToken,
          oauthTokenSecret: pc.zoteroReqTokenSecret,
          verifier,
        },
        { baseUrl: z.baseUrl, fetchImpl: z.fetchImpl },
      );
    } catch {
      this.sendConsent(res, 502, oauthToken, pc.clientName, hostOf(pc.redirectUri), 'Could not complete Zotero sign-in. Please try again.');
      return;
    }
    const code = newToken();
    this.codes.set(code, {
      clientId: pc.clientId,
      redirectUri: pc.redirectUri,
      codeChallenge: pc.codeChallenge,
      scopes: pc.scopes,
      resource: pc.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
      identity,
    });
    const target = new URL(pc.redirectUri);
    target.searchParams.set('code', code);
    if (pc.state !== undefined) target.searchParams.set('state', pc.state);
    res.redirect(302, target.href);
  }
```

6. `exchangeAuthorizationCode` / `exchangeRefreshToken` / `issueTokens` carry `identity`; access/refresh go through the store:

```ts
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && !redirectUriMatches(redirectUri, c.redirectUri)) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    this.codes.delete(authorizationCode);
    return this.issueTokens(c.clientId, c.scopes, c.resource, c.identity);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const r = this.store.getRefresh(refreshToken);
    if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    this.store.deleteRefresh(refreshToken);
    const grantScopes = scopes && scopes.length ? scopes : r.scopes;
    const identity = r.zoteroKey && r.zoteroUserId !== undefined
      ? { zoteroKey: r.zoteroKey, zoteroUserId: r.zoteroUserId, username: r.username ?? String(r.zoteroUserId) }
      : undefined;
    void this.store.flush();
    return this.issueTokens(r.clientId, grantScopes, r.resource, identity);
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string, identity?: ZoteroIdentity): OAuthTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    const idFields = identity
      ? { zoteroKey: identity.zoteroKey, zoteroUserId: identity.zoteroUserId, username: identity.username }
      : {};
    const accessRec: StoredAccess = { clientId, scopes, resource, expiresAt: nowSec() + this.opts.accessTokenTtlSec, ...idFields };
    const refreshRec: StoredRefresh = { clientId, scopes, resource, expiresAt: Date.now() + this.opts.refreshTokenTtlSec * 1000, ...idFields };
    this.store.setAccess(accessToken, accessRec);
    this.store.setRefresh(refreshToken, refreshRec);
    void this.store.flush();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.opts.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }
```

7. `verifyAccessToken` returns `extra`; reads/sweeps via the store:

```ts
  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const a = this.store.getAccess(accessToken);
    if (!a) throw new InvalidTokenError('Invalid access token');
    if (a.expiresAt < nowSec()) {
      this.store.deleteAccess(accessToken);
      throw new InvalidTokenError('Access token expired');
    }
    const extra =
      a.zoteroKey && a.zoteroUserId !== undefined
        ? { zoteroKey: a.zoteroKey, zoteroUserId: a.zoteroUserId, username: a.username ?? String(a.zoteroUserId) }
        : undefined;
    return {
      token: accessToken,
      clientId: a.clientId,
      scopes: a.scopes,
      expiresAt: a.expiresAt,
      resource: a.resource ? new URL(a.resource) : undefined,
      extra,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.deleteAccess(request.token);
    this.store.deleteRefresh(request.token);
    void this.store.flush();
  }
```

8. `sweep` + `capClients` operate via the store for clients/access/refresh; keep pending/codes local:

```ts
  private sweep(): void {
    const ms = Date.now();
    const sec = nowSec();
    for (const [k, v] of this.pending) if (v.expiresAt < ms) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt < ms) this.codes.delete(k);
    this.store.sweepExpired(sec, ms);
  }

  private capClients(): void {
    const ids = this.store.clientIds();
    let i = 0;
    while (this.store.clientIds().length - i >= MAX_CLIENTS && i < ids.length) {
      this.store.deleteClient(ids[i]!);
      i += 1;
    }
  }
```

Keep `completeConsent`, `challengeForAuthorizationCode`, `sendConsent`, `timingSafeEqualStr`, and the constants (`CONSENT_TTL_MS`, `CODE_TTL_MS`, `MAX_CONSENT_ATTEMPTS`, `MAX_CLIENTS`, `newToken`, `nowSec`, `hostOf`) exactly as in M10. `completeConsent` continues to mint a code with **no** `identity` (operator/passcode tenant).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/auth/provider.test.ts`
Expected: PASS (M10 cases + new zotero-mode cases).

- [ ] **Step 5: Commit**

```bash
git add src/auth/provider.ts tests/auth/provider.test.ts
git commit -m "M11: provider gains store injection, zotero consent bridge, per-user identity in tokens"
```

---

## Task 5: Router — build provider from mode + mount the Zotero callback

**Files:**
- Modify: `src/auth/router.ts`
- Test: covered by Task 4 (provider) + Task 11 (integration); no new unit test here.

- [ ] **Step 1: Implement** — update `src/auth/router.ts`:

Add imports:

```ts
import { MemoryStore, FileStore, type OAuthStore } from './store.js';
import { join } from 'node:path';
```

Change `buildOAuth` to be async (it may open a FileStore) and build the provider per mode. Replace the body after the early-return guards:

```ts
export async function buildOAuth(config: ZoteusConfig): Promise<BuiltOAuth | undefined> {
  if (!config.oauth.enabled) return undefined;
  if (!config.oauth.publicUrl) {
    throw new Error('OAuth enabled but ZOTEUS_PUBLIC_URL missing');
  }

  const issuerUrl = new URL(config.oauth.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const allowedHosts = [...new Set([issuerUrl.host, ...config.oauth.allowedHosts])];

  let store: OAuthStore;
  if (config.oauth.store === 'file') {
    if (!config.oauth.tokenSecret) throw new Error('store=file requires ZOTEUS_OAUTH_TOKEN_SECRET');
    store = await FileStore.open(join(config.dataDir, 'oauth-store.json'), config.oauth.tokenSecret);
  } else {
    store = new MemoryStore();
  }

  const provider = new ZoteusOAuthProvider({
    mode: config.oauth.mode,
    passcode: config.oauth.passcode,
    accessTokenTtlSec: config.oauth.accessTokenTtlSec,
    refreshTokenTtlSec: config.oauth.refreshTokenTtlSec,
    store,
    zotero:
      config.oauth.mode === 'zotero'
        ? {
            clientKey: config.oauth.zoteroClientKey!,
            clientSecret: config.oauth.zoteroClientSecret!,
            callbackUrl: new URL('/oauth/zotero/callback', issuerUrl).href,
            readOnly: config.readOnly,
          }
        : undefined,
  });
```

Keep the `consentLimiter` as-is. In the returned `mount`, register the Zotero callback (zotero mode only) before the SDK router, alongside `/consent`:

```ts
    mount(app: Express): void {
      // Passcode consent (passcode mode). Harmless to leave mounted in zotero mode.
      app.post('/consent', consentLimiter, express.urlencoded({ extended: false }), (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const authId = typeof body.auth_id === 'string' ? body.auth_id : '';
        const passcode = typeof body.passcode === 'string' ? body.passcode : '';
        void provider.completeConsent(authId, passcode, res);
      });
      // Zotero OAuth 1.0a callback (zotero mode). No CORS — it's a top-level browser redirect.
      if (config.oauth.mode === 'zotero') {
        app.get('/oauth/zotero/callback', consentLimiter, (req, res) => {
          const oauthToken = typeof req.query.oauth_token === 'string' ? req.query.oauth_token : '';
          const verifier = typeof req.query.oauth_verifier === 'string' ? req.query.oauth_verifier : '';
          void provider.completeZoteroCallback(oauthToken, verifier, res);
        });
      }
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl,
          resourceServerUrl,
          scopesSupported: ['zoteus'],
          resourceName: 'Zoteus Zotero MCP server',
        }),
      );
    },
```

Note: the early-return guard previously required `config.oauth.passcode`; remove that requirement here (passcode is validated in `loadConfig` only for passcode mode).

- [ ] **Step 2: Typecheck** (callers updated next task)

Run: `npm run typecheck`
Expected: errors only at `buildOAuth` call sites (now async) in `src/index.ts` and tests — fixed in Tasks 9/11. If you want a clean checkpoint, proceed to Task 6 first, then typecheck after Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/auth/router.ts
git commit -m "M11: buildOAuth builds provider per mode, opens store, mounts /oauth/zotero/callback"
```

---

## Task 6: Server — split buildContext/createServer, context cache, per-user index path

**Files:**
- Modify: `src/server.ts`
- Modify: `src/registry/registry.ts` (add `searchIndexPath` to `ToolContext`)
- Test: `tests/integration/server.test.ts` (existing — must stay green)

- [ ] **Step 1: Add `searchIndexPath` to `ToolContext`** — in `src/registry/registry.ts`, inside `interface ToolContext`, after `logger: Logger;`:

```ts
  /** Absolute path to this context's semantic-search index file (per-user in multi-tenant mode). */
  searchIndexPath: string;
```

- [ ] **Step 2: Rewrite `src/server.ts`** to split building a context from creating a server, and add a per-user cache:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ZoteusConfig } from './config.js';
import { createLogger, type Logger } from './lib/logger.js';
import { RateLimitedFetcher } from './api/http.js';
import { WebApiClient } from './api/web-client.js';
import { LocalApiClient } from './api/local-client.js';
import { probeCapabilities } from './router/capabilities.js';
import { LibraryRouter } from './router/library-router.js';
import { SchemaService } from './schema/schema-service.js';
import { join } from 'node:path';
import { StyleResolver } from './features/citation/styles.js';
import { TranslationServerClient } from './features/citation/translation-server.js';
import { SearchIndex } from './features/search/index-manager.js';
import { createEmbeddingProvider } from './features/search/embeddings.js';
import { loadIndex } from './features/search/persistence.js';
import { ScholarGraph } from './features/scholar/graph.js';
import { registerAllTools, type ToolContext, type ToolDefinition } from './registry/registry.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { tools } from './tools/index.js';

const VERSION = '0.10.0';

export interface ContextOverrides {
  /** Per-user Zotero API key (multi-tenant); defaults to config.apiKey. */
  apiKey?: string;
  /** Per-user Zotero userID; scopes the search index file and is the cache key. */
  zoteroUserId?: number;
}

/** Tools exposed for this config: read-only mode hides mutating tools (plus zotero_index, which only touches local files). */
function selectActiveTools(config: ZoteusConfig): ToolDefinition[] {
  return config.readOnly
    ? tools.filter((t) => t.annotations?.readOnlyHint === true || t.name === 'zotero_index')
    : tools;
}

/**
 * Build the (expensive) per-context state: Zotero clients, capability probe, router,
 * schema, search index, etc. With no overrides this is the operator/shared context
 * (identical to M10). With a per-user apiKey it is that tenant's context.
 */
export async function buildContext(config: ZoteusConfig, overrides: ContextOverrides = {}): Promise<ToolContext> {
  const logger = createLogger(config.logLevel);
  const apiKey = overrides.apiKey ?? config.apiKey;
  const perUser = overrides.apiKey !== undefined;
  const fetcher = new RateLimitedFetcher({ maxConcurrency: 4, logger });
  const web = new WebApiClient({ apiKey, fetcher, contactEmail: config.contactEmail, logger });
  // Per-user (hosted) contexts never touch the operator's desktop local API.
  const local = !perUser && config.local !== 'off' ? new LocalApiClient({ port: config.localPort, fetcher }) : undefined;

  const capabilities = await probeCapabilities(config, { web, local, logger });
  const router = new LibraryRouter({ config, capabilities, web, local });
  const schema = new SchemaService({ web });
  const styles = new StyleResolver();
  const translation = new TranslationServerClient(config.translationServerUrl, fetcher);
  const search = new SearchIndex({ embedder: createEmbeddingProvider(config, logger), logger });

  const searchIndexPath = join(
    config.dataDir,
    overrides.zoteroUserId !== undefined ? `search-index-${overrides.zoteroUserId}.json` : 'search-index.json',
  );
  await loadIndex(search, searchIndexPath).catch(() => false);
  const scholar = new ScholarGraph({ fetcher, mailto: config.contactEmail });

  const ctx: ToolContext = {
    config, capabilities, router, schema, web, local, styles, translation, search, scholar, logger, searchIndexPath,
  };
  ctx.toolCatalog = selectActiveTools(config).map((t) => ({
    name: t.name, title: t.title, description: t.description, deferLoading: t.deferLoading,
  }));
  return ctx;
}

/** Create a fresh McpServer bound to a (possibly per-user) ToolContext. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'zoteus', version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions:
        'Zoteus exposes your Zotero library. Call zotero_whoami first to resolve identity. Prefer zotero_search_items for discovery and zotero_get_item for full records. Use zotero_schema before constructing items.',
    },
  );
  registerAllTools(server, selectActiveTools(ctx.config), ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

export interface BuiltServer {
  server: McpServer;
  ctx: ToolContext;
  createServer: () => McpServer;
}

/** Operator/shared server (stdio + the no-auth HTTP path). Preserves the M10 signature. */
export async function buildServer(config: ZoteusConfig): Promise<BuiltServer> {
  const ctx = await buildContext(config);
  if (config.readOnly) {
    ctx.logger.info(`Read-only mode: exposing ${selectActiveTools(config).length}/${tools.length} tools.`);
  }
  return { server: createServer(ctx), ctx, createServer: () => createServer(ctx) };
}

/**
 * Resolves a ToolContext per authenticated user (keyed by zoteroUserId), caching the
 * expensive build. Sessions without a per-user Zotero key fall back to the operator context.
 * Eviction only drops the cache entry; live sessions keep the ctx they already closed over.
 */
export class ContextCache {
  private readonly entries = new Map<number, { ctx: ToolContext; lastUsed: number }>();
  private order = 0;

  constructor(
    private readonly config: ZoteusConfig,
    private readonly operatorCtx: ToolContext,
    private readonly maxEntries = 50,
  ) {}

  async resolve(authInfo?: AuthInfo): Promise<ToolContext> {
    const extra = authInfo?.extra as { zoteroKey?: string; zoteroUserId?: number; username?: string } | undefined;
    const zoteroKey = extra?.zoteroKey;
    const zoteroUserId = extra?.zoteroUserId;
    if (!zoteroKey || zoteroUserId === undefined) return this.operatorCtx;

    const hit = this.entries.get(zoteroUserId);
    if (hit) {
      hit.lastUsed = ++this.order;
      return hit.ctx;
    }
    const ctx = await buildContext(this.config, { apiKey: zoteroKey, zoteroUserId });
    this.entries.set(zoteroUserId, { ctx, lastUsed: ++this.order });
    this.evictIfNeeded();
    return ctx;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: number | undefined;
      let oldest = Infinity;
      for (const [k, v] of this.entries) if (v.lastUsed < oldest) ((oldest = v.lastUsed), (oldestKey = k));
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

export type { Logger };
```

- [ ] **Step 3: Run existing server/integration tests**

Run: `npx vitest run tests/integration/server.test.ts`
Expected: PASS (the `buildServer` contract is unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/server.ts src/registry/registry.ts
git commit -m "M11: split buildContext/createServer, add ContextCache + per-user index path"
```

---

## Task 7: index-tool persists/loads via the per-user index path

**Files:**
- Modify: `src/tools/index-tool.ts`
- Test: existing search tests stay green; add no new test (covered by integration).

- [ ] **Step 1: Implement** — in `src/tools/index-tool.ts`, replace the hardcoded path. Change the import line:

```ts
import { saveIndex } from '../features/search/persistence.js';
```

remains, but remove the now-unused `join` import only if `join` is used nowhere else (it is used for the path — so replace its use). Change the persist call inside the handler:

```ts
    await saveIndex(ctx.search, ctx.searchIndexPath).catch((e) =>
      ctx.logger.warn(`Could not persist index: ${e instanceof Error ? e.message : String(e)}`),
    );
```

and delete the now-unused `import { join } from 'node:path';` line at the top.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS for this file (other call sites handled in later tasks).

- [ ] **Step 3: Commit**

```bash
git add src/tools/index-tool.ts
git commit -m "M11: zotero_index uses the per-context search index path"
```

---

## Task 8: HTTP transport — auth-aware per-session factory

**Files:**
- Modify: `src/transports/http.ts`
- Test: `tests/integration/http-sessions.test.ts` (existing — must stay green)

- [ ] **Step 1: Change the factory type and call** — in `src/transports/http.ts`:

Add an import:

```ts
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
```

Change the factory type:

```ts
/** A factory that produces a fresh McpServer per MCP session, given the session's AuthInfo (if any). */
export type McpServerFactory = (authInfo?: AuthInfo) => McpServer | Promise<McpServer>;
```

In the factory branch (`else` of `typeof serverOrFactory !== 'function'`), pass `req.auth` when constructing the server. Change the line `const server = await factory();` to:

```ts
        const server = await factory((req as express.Request & { auth?: AuthInfo }).auth);
```

Everything else stays. (Bearer middleware runs before this route in OAuth mode, so `req.auth` is populated; in the no-auth path it is `undefined` and the factory uses the operator context.)

- [ ] **Step 2: Run the per-session test**

Run: `npx vitest run tests/integration/http-sessions.test.ts`
Expected: PASS (the existing test passes `() => makePing()`, an arity-0 function — still valid).

- [ ] **Step 3: Commit**

```bash
git add src/transports/http.ts
git commit -m "M11: per-session factory receives req.auth for per-user context resolution"
```

---

## Task 9: CLI wiring — context cache + auth-aware factory + async buildOAuth

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement** — rewrite the body of `main()` in `src/index.ts`:

```ts
import { loadConfig } from './config.js';
import { buildServer, createServer, ContextCache } from './server.js';
import { startStdio } from './transports/stdio.js';
import { startHttp } from './transports/http.js';
import { buildOAuth } from './auth/router.js';
import { createLogger } from './lib/logger.js';

// ...flag() unchanged...

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel);
  const { server, ctx } = await buildServer(config);

  const httpFlag = flag('http');
  if (httpFlag !== undefined) {
    const port = Number(flag('port') ?? process.env.PORT ?? 3939);
    const oauth = await buildOAuth(config);
    const host = flag('host') ?? process.env.HOST ?? (oauth ? '0.0.0.0' : '127.0.0.1');
    const cache = new ContextCache(config, ctx);
    // Per-session factory: resolve the per-user context from the session's bearer auth.
    await startHttp(
      async (authInfo) => createServer(await cache.resolve(authInfo)),
      {
        port,
        host,
        logger,
        oauth,
        enableDnsRebindingProtection: Boolean(oauth),
        allowedHosts: oauth?.allowedHosts,
        allowInsecureBind: process.env.ZOTEUS_ALLOW_INSECURE_HTTP === 'true' || process.env.ZOTEUS_ALLOW_INSECURE_HTTP === '1',
      },
    );
  } else {
    await startStdio(server);
    logger.info('Zoteus MCP server started on stdio.');
  }
}
```

(Keep the existing `flag()` helper and the `main().catch(...)` tail.)

- [ ] **Step 2: Full typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — all M10 tests + new unit tests green. (The integration multi-tenant test is added next.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "M11: wire ContextCache + auth-aware factory; buildOAuth is async"
```

---

## Task 10: Two-user integration test (mocked Zotero)

**Files:**
- Create: `tests/integration/multitenant.test.ts`

This test stubs `globalThis.fetch` with a discriminator: requests to `www.zotero.org` / `api.zotero.org` are served by an in-process mock; everything else (the local `/mcp` server, the MCP client transport) hits the real `fetch`. Two users complete the bridged flow; we assert each bearer token resolves to a different identity via `zotero_whoami`.

- [ ] **Step 1: Write the test** (`tests/integration/multitenant.test.ts`):

```ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import pkceChallenge from 'pkce-challenge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { buildOAuth } from '../../src/auth/router.js';
import { buildServer, createServer, ContextCache } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

let httpServer: Server | undefined;
const realFetch = globalThis.fetch;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
  vi.unstubAllGlobals();
});

// Two Zotero users, addressed by the request token issued in /oauth/request.
const USERS: Record<string, { key: string; userId: number; username: string }> = {
  REQTOK_A: { key: 'KEY_ALICE', userId: 111, username: 'alice' },
  REQTOK_B: { key: 'KEY_BOB', userId: 222, username: 'bob' },
};
const KEY_TO_USER: Record<string, { userId: number; username: string }> = {
  KEY_ALICE: { userId: 111, username: 'alice' },
  KEY_BOB: { userId: 222, username: 'bob' },
};

function installMockZotero(nextReqToken: () => string): void {
  const form = (s: string) =>
    new Response(s, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('www.zotero.org/oauth/request')) {
      const tok = nextReqToken();
      return form(`oauth_token=${tok}&oauth_token_secret=SEC_${tok}&oauth_callback_confirmed=true`);
    }
    if (url.includes('www.zotero.org/oauth/access')) {
      // identify the user from the oauth_token in the Authorization header
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      const m = /oauth_token="([^"]+)"/.exec(auth);
      const u = USERS[m?.[1] ?? ''];
      if (!u) return new Response('unknown token', { status: 401 });
      return form(`oauth_token=AT&oauth_token_secret=${u.key}&userID=${u.userId}&username=${u.username}`);
    }
    if (url.includes('api.zotero.org/keys/current')) {
      const key = String((init?.headers as Record<string, string>)?.['Zotero-API-Key'] ?? '');
      const u = KEY_TO_USER[key];
      if (!u) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ userID: u.userId, username: u.username, access: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // everything else (the local /mcp server + MCP client) goes to the real fetch
    return realFetch(input as any, init);
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
}

async function authorizeUser(base: string, reqTokenForThisUser: string): Promise<string> {
  // DCR
  const reg = await realFetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:45999/cb'], token_endpoint_auth_method: 'none', client_name: 'Test' }),
  });
  const client = await reg.json();
  const { code_verifier, code_challenge } = await pkceChallenge();

  // /authorize → provider calls /oauth/request (mock returns reqTokenForThisUser) → 302 to zotero.org
  const authUrl = new URL(`${base}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'http://localhost:45999/cb',
    code_challenge,
    code_challenge_method: 'S256',
    state: `st-${reqTokenForThisUser}`,
    scope: 'zoteus',
  }).toString();
  const authRes = await realFetch(authUrl, { redirect: 'manual' });
  expect(authRes.status).toBe(302);
  const zoteroLoc = new URL(authRes.headers.get('location')!);
  expect(zoteroLoc.searchParams.get('oauth_token')).toBe(reqTokenForThisUser);

  // simulate the user approving on zotero.org → browser hits our callback
  const cbRes = await realFetch(`${base}/oauth/zotero/callback?oauth_token=${reqTokenForThisUser}&oauth_verifier=VERIF`, {
    redirect: 'manual',
  });
  expect(cbRes.status).toBe(302);
  const back = new URL(cbRes.headers.get('location')!);
  const code = back.searchParams.get('code')!;

  // token exchange
  const tokRes = await realFetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier, client_id: client.client_id, redirect_uri: 'http://localhost:45999/cb',
    }),
  });
  const tokens = await tokRes.json();
  expect(tokens.access_token).toBeTruthy();
  return tokens.access_token as string;
}

async function whoamiUserId(base: string, accessToken: string): Promise<number> {
  const c = new Client({ name: 'mt-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await c.connect(transport);
  const res = (await c.callTool({ name: 'zotero_whoami', arguments: {} })) as {
    structuredContent?: { userID?: number };
  };
  await c.close();
  return res.structuredContent?.userID ?? -1;
}

describe('multi-tenant: two Zotero users resolve to different libraries', () => {
  let reqTokens: string[];
  beforeEach(() => {
    reqTokens = ['REQTOK_A', 'REQTOK_B'];
  });

  it('each bearer token reports its own Zotero identity', async () => {
    installMockZotero(() => reqTokens.shift()!);

    const config = loadConfig({
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_OAUTH_MODE: 'zotero',
      ZOTEUS_PUBLIC_URL: 'http://127.0.0.1',
      ZOTERO_OAUTH_CLIENT_KEY: 'ck',
      ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
      ZOTEUS_READ_ONLY: 'true',
    } as NodeJS.ProcessEnv);

    const oauth = await buildOAuth(config);
    const { ctx } = await buildServer(config);
    const cache = new ContextCache(config, ctx);
    httpServer = await startHttp(async (authInfo) => createServer(await cache.resolve(authInfo)), {
      port: 0,
      host: '127.0.0.1',
      oauth,
    });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const tokenA = await authorizeUser(base, 'REQTOK_A');
    const tokenB = await authorizeUser(base, 'REQTOK_B');
    expect(tokenA).not.toBe(tokenB);

    const idA = await whoamiUserId(base, tokenA);
    const idB = await whoamiUserId(base, tokenB);
    expect(idA).toBe(111);
    expect(idB).toBe(222);
    expect(idA).not.toBe(idB);
  }, 30_000);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/integration/multitenant.test.ts`
Expected: PASS. If `zotero_whoami` returns `userID` undefined, confirm the capability probe ran with the per-user key (the mock `keys/current` keys off the `Zotero-API-Key` header) and that `ContextCache.resolve` reads `authInfo.extra.zoteroKey`/`zoteroUserId`.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/multitenant.test.ts
git commit -m "M11: integration test — two Zotero users resolve to distinct identities/libraries"
```

---

## Task 11: Dependencies, version bump, full gate

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version** — in `package.json` set `"version": "0.10.0"`. No new dependencies (everything uses `node:crypto`).

- [ ] **Step 2: Full gate**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: all green. Capture the test count (should be M10 count + the new files).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "M11: bump version to 0.10.0"
```

---

## Task 12: Docs, Dockerfile, .env, runbook

**Files:**
- Modify: `.env.example`, `docs/configuration.md`, `docs/remote-oauth.md`, `Dockerfile`, `README.md`

- [ ] **Step 1: `.env.example`** — append after the existing OAuth block:

```bash
# --- Multi-tenant (per-user Zotero accounts) — see docs/remote-oauth.md ---
# passcode (default, single operator key) | zotero (each user logs into their own Zotero)
ZOTEUS_OAUTH_MODE=passcode
# Register a Zotero app at https://www.zotero.org/oauth/apps; required when mode=zotero.
# ZOTERO_OAUTH_CLIENT_KEY=
# ZOTERO_OAUTH_CLIENT_SECRET=
# Persist clients/tokens/per-user keys across restarts: memory (default) | file
ZOTEUS_OAUTH_STORE=memory
# AES-256-GCM key material to encrypt stored Zotero keys at rest; required when store=file.
# Generate with: openssl rand -base64 32
# ZOTEUS_OAUTH_TOKEN_SECRET=
```

- [ ] **Step 2: `docs/configuration.md`** — add rows to the Remote OAuth table:

```markdown
| `ZOTEUS_OAUTH_MODE` | `passcode` | `passcode` (single operator key, M10) or `zotero` (per-user Zotero login, multi-tenant). |
| `ZOTERO_OAUTH_CLIENT_KEY` / `ZOTERO_OAUTH_CLIENT_SECRET` | — | Zotero app credentials (https://www.zotero.org/oauth/apps). Required when `mode=zotero`. |
| `ZOTEUS_OAUTH_STORE` | `memory` | `memory` or `file` (persist clients/tokens/per-user keys under the data dir). |
| `ZOTEUS_OAUTH_TOKEN_SECRET` | — | AES-256-GCM key material encrypting stored Zotero keys at rest. Required when `store=file` (`openssl rand -base64 32`). |
```

- [ ] **Step 3: `docs/remote-oauth.md`** — add a "Multi-tenant (per-user Zotero accounts)" section: how zotero mode bridges Zotero OAuth 1.0a under the OAuth 2.1 connector; the new env vars; that `store=file` + a mounted volume keeps users signed in across restarts; per-user semantic index; and the **two-account verification runbook**:

```markdown
## Multi-tenant: per-user Zotero accounts (M11)

By default Zoteus runs **single-tenant** (`ZOTEUS_OAUTH_MODE=passcode`): every connected
client uses the one operator `ZOTERO_API_KEY`, gated by a shared passcode.

Set `ZOTEUS_OAUTH_MODE=zotero` to make Zoteus **multi-tenant** — each user who adds the
connector logs into **their own Zotero account**, and every call runs against that user's
library. Zoteus stays its own OAuth 2.1 server for claude.ai; during consent it performs
Zotero's OAuth 1.0a on the user's behalf and binds the resulting per-user Zotero key to the
issued bearer token.

### Setup

1. Register a Zotero app at https://www.zotero.org/oauth/apps. Set the callback to
   `https://<your-host>/oauth/zotero/callback`. Note the **Client Key** and **Client Secret**.
2. Configure:
   ```bash
   ZOTEUS_OAUTH_ENABLED=true
   ZOTEUS_OAUTH_MODE=zotero
   ZOTEUS_PUBLIC_URL=https://<your-host>
   ZOTERO_OAUTH_CLIENT_KEY=<client key>
   ZOTERO_OAUTH_CLIENT_SECRET=<client secret>
   ZOTEUS_OAUTH_STORE=file
   ZOTEUS_OAUTH_TOKEN_SECRET="$(openssl rand -base64 32)"
   ZOTEUS_READ_ONLY=true
   ZOTEUS_DATA_DIR=/data        # mount a volume so the store + per-user indexes persist
   ```
   No `ZOTERO_API_KEY` and no `ZOTEUS_OAUTH_PASSCODE` are needed in zotero mode.
3. Deploy behind HTTPS (Fly/Render/Railway/VPS+Caddy/named cloudflared) exactly as for
   single-tenant, mounting a volume at `ZOTEUS_DATA_DIR`.

### Verifying two accounts (operator runbook)

1. In **Account A**'s claude.ai: Settings → Connectors → Add custom connector →
   `https://<your-host>/mcp` → Connect → you are redirected to **zotero.org**, sign in,
   approve → tools load. Run `zotero_whoami`; confirm it reports **Account A**'s userID.
2. Repeat in **Account B** (or a second browser/profile). `zotero_whoami` must report
   **Account B**'s userID — not A's, and not the operator's.
3. Restart the server; reconnect from both — neither user is forced back through Zotero
   (the encrypted file store kept their keys).

### Notes

- **Encryption at rest:** stored Zotero keys are AES-256-GCM encrypted with
  `ZOTEUS_OAUTH_TOKEN_SECRET`. Losing/rotating the secret invalidates the store (users
  simply re-authorize). The store file lives under `ZOTEUS_DATA_DIR` (git-ignored).
- **Per-user index:** `zotero_index` builds a separate semantic index per user
  (`search-index-<userID>.json`).
- **Single instance:** the file store is local; run one instance (no shared-replica state).
```

Also update the "Security notes & v1 limitations" bullet that says multi-tenant is a future milestone to point at the new section.

- [ ] **Step 4: `Dockerfile`** — update the configuration comment block to mention zotero mode + the volume:

```dockerfile
# Single-tenant (default) OR multi-tenant per-user Zotero accounts:
#   ZOTEUS_OAUTH_MODE=zotero
#   ZOTERO_OAUTH_CLIENT_KEY=... ZOTERO_OAUTH_CLIENT_SECRET=...   (https://www.zotero.org/oauth/apps)
#   ZOTEUS_OAUTH_STORE=file  ZOTEUS_OAUTH_TOKEN_SECRET=...        (openssl rand -base64 32)
#   ZOTEUS_DATA_DIR=/data    + mount a volume at /data so the encrypted store + indexes persist
VOLUME ["/data"]
```

(Place the `VOLUME` line before `EXPOSE`.)

- [ ] **Step 5: `README.md`** — in the roadmap, add `- [x] **11** Multi-tenant per-user Zotero accounts (claude.ai connector)`. In the claude.ai connector section, add one line: "Zoteus also supports **multi-tenant** mode (`ZOTEUS_OAUTH_MODE=zotero`) where each user authorizes their own Zotero account — see [docs/remote-oauth.md](docs/remote-oauth.md)."

- [ ] **Step 6: Commit**

```bash
git add .env.example docs/configuration.md docs/remote-oauth.md Dockerfile README.md
git commit -m "M11: docs, .env, Dockerfile volume, and two-account runbook for zotero mode"
```

---

## Task 13: Final verification + tag

**Files:** none (verification only)

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: all green.

- [ ] **Step 2: Docker build sanity** (if Docker available)

Run: `docker build -t zoteus:0.10.0 .`
Expected: image builds. (Skip with a noted reason if Docker is unavailable in the environment.)

- [ ] **Step 3: Delete the handoff brief** (it must not stay committed)

```bash
git rm docs/superpowers/NEXT-AGENT-m11-multitenant.md
git commit -m "M11: remove handoff brief (implemented)"
```

- [ ] **Step 4: Tag**

```bash
git tag v0.10.0
```

(Push — `git push origin main --tags` — only when the operator confirms; see verification handoff.)

- [ ] **Step 5: Operator live verification** (cannot be done by the implementing agent)

Hand off the two-account runbook in `docs/remote-oauth.md` §"Verifying two accounts". The automated `tests/integration/multitenant.test.ts` covers the equivalent logic against a mock; the real claude.ai check requires the Zotero app credentials, two accounts, and a public host.

---

## Self-Review

**Spec coverage:**
- Bridged Zotero OAuth 1.0a under OAuth 2.1 → Tasks 2, 4, 5. ✓
- `ZOTEUS_OAUTH_MODE=passcode|zotero` (default passcode) → Task 1, 4, 5. ✓
- `authorize()` starts Zotero 1.0a + `/oauth/zotero/callback` → Task 4 (`authorizeViaZotero`, `completeZoteroCallback`), Task 5 (route). ✓
- Token records carry `{zoteroKey,zoteroUserId,username}`; `verifyAccessToken` → `AuthInfo.extra` → Task 4. ✓
- Per-user `ToolContext`, cache by `zoteroUserId`, `buildContext`/`createServer` split → Task 6. ✓
- Auth-aware per-session factory reads `req.auth` → Task 8, 9. ✓
- Persistent encrypted store (durable only; AES-256-GCM; fail-fast secret) → Tasks 1 (validation), 3 (store), 5 (wiring). ✓
- Per-user semantic index → Task 6 (`searchIndexPath`), Task 7 (index-tool). ✓
- OAuth 1.0a signing unit-tested against a canonical vector → Task 2. ✓
- Two-user integration test (mock Zotero) → Task 10. ✓
- Config additions + validation → Task 1. ✓
- Deployment + runbook (Dockerfile/docs) → Task 12. ✓
- M10 passcode mode unchanged + regression guard → Tasks 4/8 keep existing tests; provider/http/server tests stay green. ✓
- Version 0.10.0, delete brief, tag → Tasks 11, 13. ✓
- CIMD explicitly out of scope (noted in spec non-goals). ✓

**Placeholder scan:** none — every code step contains full code; commands have expected output.

**Type consistency:** `StoredAccess`/`StoredRefresh` defined once in `store.ts` and imported by `provider.ts` (M10's local copies deleted). `OAuthStore` methods (`getClient/setClient/deleteClient/clientIds/getAccess/setAccess/deleteAccess/getRefresh/setRefresh/deleteRefresh/sweepExpired/flush`) match between interface, `MemoryStore`, `FileStore`, and provider usage. `buildContext(config, overrides)` / `createServer(ctx)` / `ContextCache.resolve(authInfo)` signatures match their call sites in `index.ts` and the integration test. `McpServerFactory = (authInfo?) => ...` matches both call sites (`() => makePing()` in the existing test is still assignable). `buildOAuth` is async at all call sites (`index.ts`, multitenant test). `zotero-oauth` exports (`percentEncode/buildSignatureBaseString/signHmacSha1/requestToken/accessToken/buildAuthorizeUrl`) match the provider import and the unit test.

## Risks / notes

- **OAuth 1.0a vector:** the Twitter "Creating a signature" constants are authoritative; if a literal mismatches on first red run, fix the test literal (not the algorithm) against the published doc.
- **`req.auth` propagation:** confirmed `requireBearerAuth` sets `req.auth = authInfo` (full `AuthInfo`, incl. `extra`) before the route runs; the factory reads it synchronously in the route handler.
- **Eviction safety:** `ContextCache` eviction only removes the map entry; live sessions already closed over their `ctx`, so eviction never breaks an in-flight session.
- **Store flush timing:** `issueTokens`/`revoke`/`refresh` call `void this.store.flush()` (fire-and-forget, debounced + atomic rename). Tests that assert persistence call `await store.flush()` explicitly.
- **No new deps:** HMAC-SHA1 + AES-256-GCM via `node:crypto`; keeps the lean-deps house style and the `engines: node >=18` floor.
