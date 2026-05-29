# M10 — OAuth 2.1 + hosted remote (claude.ai connector) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zoteus usable as a claude.ai (web) custom connector by turning its Streamable HTTP endpoint into an OAuth 2.1 + PKCE protected resource backed by Zoteus's own minimal authorization server, and ship a public-HTTPS deployment story.

**Architecture:** Zotero's API is OAuth 1.0a, so Zoteus acts as its **own OAuth 2.1 Authorization Server** (single-tenant gating). It issues short-lived opaque bearer tokens after a one-step passcode consent; the deployed instance holds one operator `ZOTERO_API_KEY`. We build on the MCP SDK's Express-based auth helpers (`mcpAuthRouter`, `requireBearerAuth`, DCR/token/authorize handlers) and implement an `OAuthServerProvider` with in-memory stores. The HTTP transport is rewritten on Express so the SDK auth routers and bearer middleware mount cleanly; OAuth is opt-in (`ZOTEUS_OAUTH_ENABLED`), so the existing unauthenticated localhost path is preserved.

**Tech Stack:** TypeScript NodeNext ESM, `@modelcontextprotocol/sdk@^1.29` (auth helpers), `express@5`, `cors`, `pkce-challenge` (test-only), Vitest. Token store is in-memory (single instance); opaque random tokens (no JWT/signing secret needed).

---

## Key contracts discovered (verified against installed SDK 1.29)

- `mcpAuthRouter({ provider, issuerUrl, baseUrl?, resourceServerUrl?, scopesSupported?, resourceName? })` returns an Express `RequestHandler` that mounts `/authorize`, `/token`, `/register` (if `clientsStore.registerClient`), `/revoke` (if `provider.revokeToken`), `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource<rsPath>`.
- `checkIssuerUrl` requires the issuer to be **https** OR hostname `localhost`/`127.0.0.1` (else throws). Issuer must have no query/fragment.
- `authorizationHandler` validates `client_id`, `redirect_uri` (via `redirectUriMatches`, RFC 8252 loopback port-agnostic), `response_type=code`, `code_challenge`, `code_challenge_method=S256`, optional `scope`/`state`/`resource`, then calls `provider.authorize(client, { state, scopes, redirectUri, codeChallenge, resource }, res)`. **The passcode is NOT passed through** — consent must be handled by our own endpoint.
- `tokenHandler` runs `authenticateClient` (so public clients need `token_endpoint_auth_method: 'none'`), then for `authorization_code`: calls `provider.challengeForAuthorizationCode(client, code)` and verifies PKCE locally via `verifyChallenge(code_verifier, challenge)`, then `provider.exchangeAuthorizationCode(client, code, undefined, redirect_uri, resource)`. For `refresh_token`: `provider.exchangeRefreshToken(...)`.
- `requireBearerAuth({ verifier, requiredScopes?, resourceMetadataUrl? })` requires `Authorization: Bearer`, calls `verifier.verifyAccessToken(token)`, and **requires `authInfo.expiresAt` to be a finite number** (rejects otherwise). On 401 it emits `WWW-Authenticate: Bearer ..., resource_metadata="<url>"`.
- `clientRegistrationHandler` (DCR) generates `client_id` (UUID) and a `client_secret` unless `token_endpoint_auth_method === 'none'`, then calls `clientsStore.registerClient(info)`.
- `StreamableHTTPServerTransport` options include `enableDnsRebindingProtection` + `allowedHosts` (exact full Host-header match, **including port**). Rejection = HTTP **403**, JSON-RPC `-32000`.
- SDK auth errors importable from `@modelcontextprotocol/sdk/server/auth/errors.js`: `InvalidGrantError`, `InvalidTokenError`, `InvalidClientError`, etc.
- Client transport `StreamableHTTPClientTransport(url, { requestInit })` accepts `requestInit.headers` → used in tests to inject `Authorization`.
- `pkce-challenge` default export: `await pkceChallenge()` → `{ code_verifier, code_challenge }` (S256).

---

## Hardening amendments (from the 4-lens plan-hardening review)

A read-only adversarial review (SDK-contract, claude.ai-spec, security, ESM/TS-build) ran before implementation. The design was confirmed sound against SDK 1.29; the following **amendments supersede** the corresponding inline task code below. Confidence-ranked, all folded into the implementation:

1. **[CRITICAL build] Install Express/cors types first.** Express 5 ships no `.d.ts`; `@types/express`/`@types/cors` are not present → `tsc` fails with TS7016. Add `@types/express@^5.0.0` + `@types/cors@^2.8.17` to **devDependencies** and `npm install` **before the first typecheck** (do this in Task 1, not Task 7). `express-rate-limit` ships its own types (no @types needed).

2. **[MAJOR test] `registerClient` must self-generate `client_id`.** The SDK's DCR handler pre-generates it, but the provider unit test calls the store directly. Implementation:
   ```ts
   registerClient: (info) => {
     const existing = (info as Partial<OAuthClientInformationFull>).client_id;
     const client_id = existing ?? randomUUID();
     const full = {
       ...info,
       client_id,
       client_id_issued_at: (info as Partial<OAuthClientInformationFull>).client_id_issued_at ?? nowSec(),
     } as OAuthClientInformationFull;
     this.capClients();
     this.clients.set(client_id, full);
     return full;
   },
   ```

3. **[CRITICAL security] Throttle `/consent` (the single passcode gate).** Add three layers:
   - IP rate-limit via `express-rate-limit` on `POST /consent` (`windowMs: 15*60_000, max: 10`).
   - Per-`auth_id` attempt cap: `PendingConsent.attempts`; after 5 wrong passcodes delete the pending consent (force a fresh `/authorize`).
   - Enforce a **minimum passcode length of 12** in `loadConfig` validation; document generating it with `openssl rand -base64 24`.

4. **[MAJOR security] Guard against an open unauthenticated public relay.** If the resolved bind host is **non-loopback** (not `127.0.0.1`/`localhost`/`::1`) AND OAuth is disabled, `startHttp` throws unless `allowInsecureBind` is set (wired from new env `ZOTEUS_ALLOW_INSECURE_HTTP`). This makes the "localhost-only" claim enforced, not aspirational.

5. **[claude.ai-spec/security] `ZOTEUS_ALLOWED_HOSTS` override.** Some TLS proxies rewrite the `Host` header (DNS-rebinding does exact host:port match). Add optional comma-separated `ZOTEUS_ALLOWED_HOSTS`, merged with the issuer host. Document that the proxy MUST forward the public `Host` verbatim.

6. **[deps] Declare direct deps used by first-party code:** `express`, `cors`, `express-rate-limit` → `dependencies`; `pkce-challenge` (tests), `@types/express`, `@types/cors` → `devDependencies`.

7. **[security] CORS scoping.** Do **not** apply blanket `app.use(cors())`. The SDK already CORS-enables `/token`, `/register`, and the `.well-known` metadata routes. Apply `cors()` only to the `/mcp` route (`app.use(path, cors())`, which also auto-answers OPTIONS preflight before bearer auth). `/consent` gets no CORS.

8. **[security] Harden the consent page against client-name phishing.** `client_name` from DCR is attacker-controlled and unbounded. Sanitize before render: strip control/bidi chars, truncate to 64 chars, and **display the redirect_uri host** next to the name so the operator sees where the code will be sent. `esc()` stays (XSS is already covered).

9. **[security] Bound in-memory growth.** Opportunistic `sweep()` of expired `pending`/`codes`/`access`/`refresh` on each write, and FIFO `capClients()` (cap 1000) — no timers (avoids per-instance interval lifecycle issues in tests).

10. **[test strength] Strengthen the integration test.** Bind to a pre-resolved free port and set `ZOTEUS_PUBLIC_URL=http://127.0.0.1:<port>` so the test **follows the metadata-advertised absolute endpoints verbatim** (verifies host-consistency claude.ai depends on), enable DNS-rebinding (`allowedHosts=[host:port]`) to cover the **accept** path end-to-end, and add a **non-loopback `https://claude.ai/api/mcp/auth_callback`** redirect_uri case (exact-match accept + mismatch reject).

11. **[docs] Document accepted single-tenant v1 limitations** in `docs/remote-oauth.md`: one shared stateful transport ⇒ concurrent independent MCP sessions are not isolated (M11); access tokens live to TTL regardless of refresh rotation; in-memory store (no restart/replica persistence); proxy must forward `Host`.

12. **[style] New tests cast env objects `as NodeJS.ProcessEnv`** to match existing `tests/config.test.ts` style.

Helper used throughout the provider: `const nowSec = () => Math.floor(Date.now() / 1000);`.

---

## File Structure

- **Create** `src/auth/provider.ts` — `ZoteusOAuthProvider` implementing `OAuthServerProvider` + `OAuthRegisteredClientsStore`, with in-memory Maps for clients, pending consents, auth codes, access tokens, refresh tokens; opaque-token minting; passcode consent completion. One responsibility: OAuth logic + state.
- **Create** `src/auth/consent.ts` — `renderConsentPage(opts)` returns a small self-contained HTML consent/passcode page (and error variant). One responsibility: the human-facing consent UI.
- **Create** `src/auth/router.ts` — `buildOAuth(config)` factory → `BuiltOAuth { provider, issuerUrl, resourceServerUrl, resourceMetadataUrl, allowedHosts, mount(app) }`. `mount` installs `mcpAuthRouter(...)` and the custom `POST /consent` route. One responsibility: wiring SDK routers + consent endpoint.
- **Modify** `src/config.ts` — add `oauth` config block + env parsing + cross-field validation (publicUrl+passcode required when enabled).
- **Modify** `src/transports/http.ts` — rewrite on Express; add `oauth?`, `enableDnsRebindingProtection?`, `allowedHosts?` options; mount OAuth + bearer auth on `/mcp` when enabled; keep unauthenticated path otherwise. Returns `http.Server` (unchanged signature).
- **Modify** `src/index.ts` — build oauth from config and pass to `startHttp`; derive `allowedHosts`/rebinding.
- **Modify** `src/server.ts` — bump `VERSION` to `0.9.0`.
- **Modify** `package.json` — declare `express` + `cors` as direct deps; bump version to `0.9.0`.
- **Create** `tests/auth/provider.test.ts` — provider unit tests.
- **Create** `tests/integration/oauth-flow.test.ts` — end-to-end auth-code + PKCE flow over real HTTP.
- **Create** `tests/integration/dns-rebinding.test.ts` — Host-header rejection.
- **Modify** `tests/config.test.ts` — oauth config cases.
- **Create** `Dockerfile` + **Create** `docs/remote-oauth.md`; **Modify** `README.md`, `docs/configuration.md`, `.env.example`.

---

## Task 1: Config — OAuth settings + validation

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing tests** — append to `tests/config.test.ts`:

```ts
describe('oauth config', () => {
  it('defaults oauth.enabled to false', () => {
    const c = loadConfig({ ZOTERO_API_KEY: 'k' });
    expect(c.oauth.enabled).toBe(false);
  });

  it('parses oauth settings when enabled', () => {
    const c = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com',
      ZOTEUS_OAUTH_PASSCODE: 'hunter2',
    });
    expect(c.oauth.enabled).toBe(true);
    expect(c.oauth.publicUrl).toBe('https://zoteus.example.com');
    expect(c.oauth.passcode).toBe('hunter2');
    expect(c.oauth.accessTokenTtlSec).toBe(3600);
    expect(c.oauth.refreshTokenTtlSec).toBe(2592000);
  });

  it('throws when oauth enabled without public url or passcode', () => {
    expect(() => loadConfig({ ZOTERO_API_KEY: 'k', ZOTEUS_OAUTH_ENABLED: 'true' })).toThrow(/ZOTEUS_PUBLIC_URL/);
    expect(() =>
      loadConfig({ ZOTERO_API_KEY: 'k', ZOTEUS_OAUTH_ENABLED: 'true', ZOTEUS_PUBLIC_URL: 'https://x.example' }),
    ).toThrow(/ZOTEUS_OAUTH_PASSCODE/);
  });

  it('strips trailing slash from public url', () => {
    const c = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_PUBLIC_URL: 'https://zoteus.example.com/',
      ZOTEUS_OAUTH_PASSCODE: 'p',
    });
    expect(c.oauth.publicUrl).toBe('https://zoteus.example.com');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/config.test.ts -t "oauth config"`
Expected: FAIL (`oauth` undefined / no throw).

- [ ] **Step 3: Implement** — in `src/config.ts`:

Add to the `ZoteusConfig` interface (after `readOnly`):

```ts
  oauth: {
    enabled: boolean;
    publicUrl?: string;
    passcode?: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
  };
```

Add to the zod `schema` object (after `ZOTEUS_READ_ONLY`):

```ts
    ZOTEUS_OAUTH_ENABLED: bool(false),
    ZOTEUS_PUBLIC_URL: z.string().url().optional(),
    ZOTEUS_OAUTH_PASSCODE: z.string().min(1).optional(),
    ZOTEUS_OAUTH_ACCESS_TTL: z.coerce.number().int().positive().default(3600),
    ZOTEUS_OAUTH_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),
```

After `const parsed = schema.parse(env);`, add validation + normalization:

```ts
  const oauthEnabled = parsed.ZOTEUS_OAUTH_ENABLED;
  const publicUrl = parsed.ZOTEUS_PUBLIC_URL?.replace(/\/+$/, '');
  if (oauthEnabled) {
    if (!publicUrl) throw new Error('ZOTEUS_PUBLIC_URL is required when ZOTEUS_OAUTH_ENABLED=true');
    if (!parsed.ZOTEUS_OAUTH_PASSCODE) throw new Error('ZOTEUS_OAUTH_PASSCODE is required when ZOTEUS_OAUTH_ENABLED=true');
  }
```

Add to the returned object:

```ts
    oauth: {
      enabled: oauthEnabled,
      publicUrl,
      passcode: parsed.ZOTEUS_OAUTH_PASSCODE,
      accessTokenTtlSec: parsed.ZOTEUS_OAUTH_ACCESS_TTL,
      refreshTokenTtlSec: parsed.ZOTEUS_OAUTH_REFRESH_TTL,
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "M10: add OAuth config (enabled, public url, passcode, token TTLs)"
```

---

## Task 2: OAuth provider + in-memory stores (PKCE, codes, tokens, consent)

**Files:**
- Create: `src/auth/consent.ts`
- Create: `src/auth/provider.ts`
- Test: `tests/auth/provider.test.ts`

- [ ] **Step 1: Write the consent renderer** (`src/auth/consent.ts`) — no test of its own; exercised via provider/integration tests:

```ts
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export interface ConsentPageOptions {
  authId: string;
  clientName: string;
  error?: string;
}

/** Minimal self-contained HTML consent/passcode page; posts to /consent. */
export function renderConsentPage({ authId, clientName, error }: ConsentPageOptions): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect to Zoteus</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 26rem; margin: 4rem auto; padding: 0 1rem; }
  h1 { font-size: 1.25rem; } .muted { opacity: .7; font-size: .9rem; }
  form { display: grid; gap: .75rem; margin-top: 1.5rem; }
  input[type=password] { padding: .6rem; font-size: 1rem; border: 1px solid #8888; border-radius: .4rem; }
  button { padding: .6rem; font-size: 1rem; border: 0; border-radius: .4rem; background: #6E56CF; color: #fff; cursor: pointer; }
  .err { color: #c0392b; font-size: .9rem; }
</style></head>
<body>
  <h1>Connect <strong>${esc(clientName)}</strong> to Zoteus</h1>
  <p class="muted">Enter the access passcode for this Zoteus server to authorize the connection to your Zotero library.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="consent">
    <input type="hidden" name="auth_id" value="${esc(authId)}" />
    <input type="password" name="passcode" placeholder="Access passcode" autofocus required autocomplete="off" />
    <button type="submit">Authorize</button>
  </form>
</body></html>`;
}
```

- [ ] **Step 2: Write failing provider tests** (`tests/auth/provider.test.ts`):

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import pkceChallenge from 'pkce-challenge';
import { ZoteusOAuthProvider } from '../../src/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

function makeProvider() {
  return new ZoteusOAuthProvider({ passcode: 'secret', accessTokenTtlSec: 3600, refreshTokenTtlSec: 2592000 });
}

async function registerClient(p: ZoteusOAuthProvider, redirect = 'http://localhost:7777/callback') {
  return (await p.clientsStore.registerClient!({
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
    client_name: 'Test Client',
  })) as OAuthClientInformationFull;
}

// Minimal express Response double that records redirect/HTML output.
function fakeRes() {
  const r: any = { statusCode: 200, headers: {}, body: '', redirectedTo: undefined };
  r.setHeader = (k: string, v: string) => { r.headers[k] = v; };
  r.set = r.setHeader;
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.send = (b: string) => { r.body = b; return r; };
  r.type = () => r;
  r.redirect = (codeOrUrl: number | string, maybeUrl?: string) => {
    r.redirectedTo = typeof codeOrUrl === 'number' ? maybeUrl : codeOrUrl;
    r.statusCode = typeof codeOrUrl === 'number' ? codeOrUrl : 302;
    return r;
  };
  return r as Response & { body: string; redirectedTo?: string; statusCode: number };
}

describe('ZoteusOAuthProvider', () => {
  let p: ZoteusOAuthProvider;
  beforeEach(() => { p = makeProvider(); });

  it('registers and retrieves clients (public client has no secret)', async () => {
    const c = await registerClient(p);
    expect(c.client_id).toBeTruthy();
    expect(c.client_secret).toBeUndefined();
    expect(await p.clientsStore.getClient(c.client_id)).toMatchObject({ client_id: c.client_id });
  });

  it('authorize renders the consent page with a hidden auth_id', async () => {
    const c = await registerClient(p);
    const res = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'abc', state: 'st', scopes: [] }, res);
    expect(res.body).toContain('name="auth_id"');
    expect(res.body).toContain('Test Client');
  });

  it('rejects consent with wrong passcode (re-renders, no redirect)', async () => {
    const c = await registerClient(p);
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: 'abc', state: 'st', scopes: [] }, res1);
    const authId = /name="auth_id" value="([^"]+)"/.exec(res1.body)![1];
    const res2 = fakeRes();
    await p.completeConsent(authId, 'wrong', res2);
    expect(res2.redirectedTo).toBeUndefined();
    expect(res2.statusCode).toBe(401);
    expect(res2.body).toContain('Incorrect');
  });

  it('full PKCE S256 flow: consent -> code -> token -> verify', async () => {
    const c = await registerClient(p);
    const { code_verifier, code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, state: 'xyz', scopes: ['zoteus'] }, res1);
    const authId = /name="auth_id" value="([^"]+)"/.exec(res1.body)![1];

    const res2 = fakeRes();
    await p.completeConsent(authId, 'secret', res2);
    expect(res2.statusCode).toBe(302);
    const loc = new URL(res2.redirectedTo!);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // SDK token handler verifies PKCE using this challenge:
    expect(await p.challengeForAuthorizationCode(c, code)).toBe(code_challenge);

    const tokens = await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBe(3600);

    const info = await p.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(c.client_id);
    expect(typeof info.expiresAt).toBe('number');
  });

  it('authorization codes are single-use', async () => {
    const c = await registerClient(p);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const authId = /name="auth_id" value="([^"]+)"/.exec(res1.body)![1];
    const res2 = fakeRes();
    await p.completeConsent(authId, 'secret', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    await expect(p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0])).rejects.toThrow();
  });

  it('verifyAccessToken rejects unknown and expired tokens', async () => {
    await expect(p.verifyAccessToken('nope')).rejects.toThrow();
    const short = new ZoteusOAuthProvider({ passcode: 's', accessTokenTtlSec: -1, refreshTokenTtlSec: 10 });
    const c = await registerClient(short);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await short.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const authId = /name="auth_id" value="([^"]+)"/.exec(res1.body)![1];
    const res2 = fakeRes();
    await short.completeConsent(authId, 's', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    const t = await short.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    await expect(short.verifyAccessToken(t.access_token)).rejects.toThrow();
  });

  it('refresh token mints a new access token; revoke invalidates', async () => {
    const c = await registerClient(p);
    const { code_challenge } = await pkceChallenge();
    const res1 = fakeRes();
    await p.authorize(c, { redirectUri: c.redirect_uris[0], codeChallenge: code_challenge, scopes: [] }, res1);
    const authId = /name="auth_id" value="([^"]+)"/.exec(res1.body)![1];
    const res2 = fakeRes();
    await p.completeConsent(authId, 'secret', res2);
    const code = new URL(res2.redirectedTo!).searchParams.get('code')!;
    const t1 = await p.exchangeAuthorizationCode(c, code, undefined, c.redirect_uris[0]);
    const t2 = await p.exchangeRefreshToken(c, t1.refresh_token!);
    expect(t2.access_token).toBeTruthy();
    expect(t2.access_token).not.toBe(t1.access_token);
    await p.revokeToken!(c, { token: t2.access_token });
    await expect(p.verifyAccessToken(t2.access_token)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/auth/provider.test.ts`
Expected: FAIL (`ZoteusOAuthProvider` not found).

- [ ] **Step 4: Implement** (`src/auth/provider.ts`):

```ts
import { randomUUID, randomBytes } from 'node:crypto';
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

export interface ZoteusOAuthProviderOptions {
  passcode: string;
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
}

interface PendingConsent {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
}
interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
}
interface StoredAccess {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // seconds (matches AuthInfo)
}
interface StoredRefresh {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number; // ms
}

const CONSENT_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const token = () => randomBytes(32).toString('base64url');

export class ZoteusOAuthProvider implements OAuthServerProvider {
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly pending = new Map<string, PendingConsent>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly access = new Map<string, StoredAccess>();
  private readonly refresh = new Map<string, StoredRefresh>();

  constructor(private readonly opts: ZoteusOAuthProviderOptions) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => this.clients.get(id),
    registerClient: (info) => {
      const full = info as OAuthClientInformationFull;
      this.clients.set(full.client_id, full);
      return full;
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const authId = randomUUID();
    this.pending.set(authId, {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.href,
      expiresAt: Date.now() + CONSENT_TTL_MS,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(renderConsentPage({ authId, clientName: client.client_name ?? client.client_id }));
  }

  /** Custom (non-SDK) endpoint: verify the passcode and complete or re-prompt. */
  async completeConsent(authId: string, passcode: string, res: Response): Promise<void> {
    const pc = this.pending.get(authId);
    if (!pc || pc.expiresAt < Date.now()) {
      this.pending.delete(authId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send(renderConsentPage({ authId, clientName: 'this client', error: 'Session expired — please reconnect from claude.ai.' }));
      return;
    }
    if (!timingSafeEqualStr(passcode, this.opts.passcode)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(401).send(renderConsentPage({ authId, clientName: pc.clientName, error: 'Incorrect passcode. Please try again.' }));
      return;
    }
    this.pending.delete(authId);
    const code = token();
    this.codes.set(code, {
      clientId: pc.clientId,
      redirectUri: pc.redirectUri,
      codeChallenge: pc.codeChallenge,
      scopes: pc.scopes,
      resource: pc.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(pc.redirectUri);
    target.searchParams.set('code', code);
    if (pc.state !== undefined) target.searchParams.set('state', pc.state);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const c = this.codes.get(authorizationCode);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return c.codeChallenge;
  }

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
    this.codes.delete(authorizationCode); // one-time use
    return this.issueTokens(c.clientId, c.scopes, c.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const r = this.refresh.get(refreshToken);
    if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    this.refresh.delete(refreshToken); // rotate
    const grantScopes = scopes && scopes.length ? scopes : r.scopes;
    return this.issueTokens(r.clientId, grantScopes, r.resource);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const a = this.access.get(accessToken);
    if (!a) throw new InvalidTokenError('Invalid access token');
    if (a.expiresAt < Date.now() / 1000) {
      this.access.delete(accessToken);
      throw new InvalidTokenError('Access token expired');
    }
    return {
      token: accessToken,
      clientId: a.clientId,
      scopes: a.scopes,
      expiresAt: a.expiresAt,
      resource: a.resource ? new URL(a.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.access.delete(request.token);
    this.refresh.delete(request.token);
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const accessToken = token();
    const refreshToken = token();
    const expiresAtSec = Math.floor(Date.now() / 1000) + this.opts.accessTokenTtlSec;
    this.access.set(accessToken, { clientId, scopes, resource, expiresAt: expiresAtSec });
    this.refresh.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: Date.now() + this.opts.refreshTokenTtlSec * 1000,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.opts.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope: scopes.length ? scopes.join(' ') : undefined,
    };
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  // both equal length → constant-time compare
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { timingSafeEqual } = require('node:crypto') as typeof import('node:crypto');
  return timingSafeEqual(ab, bb);
}
```

NOTE: replace the `require` shim with a top-of-file `import { timingSafeEqual } from 'node:crypto';` and call it directly — ESM has no `require`. Final helper:

```ts
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
// ...
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/auth/provider.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/auth/provider.ts src/auth/consent.ts tests/auth/provider.test.ts
git commit -m "M10: OAuth provider with PKCE S256, passcode consent, opaque tokens"
```

---

## Task 3: OAuth router factory (`buildOAuth`) + `/consent` wiring

**Files:**
- Create: `src/auth/router.ts`
- (Tested via the integration test in Task 6.)

- [ ] **Step 1: Implement** (`src/auth/router.ts`):

```ts
import express, { type Express } from 'express';
import cors from 'cors';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { ZoteusConfig } from '../config.js';
import { ZoteusOAuthProvider } from './provider.js';

export interface BuiltOAuth {
  provider: ZoteusOAuthProvider;
  issuerUrl: URL;
  resourceServerUrl: URL;
  resourceMetadataUrl: string;
  allowedHosts: string[];
  mount(app: Express): void;
}

/** Build the OAuth subsystem from config, or undefined if OAuth is disabled. */
export function buildOAuth(config: ZoteusConfig): BuiltOAuth | undefined {
  if (!config.oauth.enabled) return undefined;
  if (!config.oauth.publicUrl || !config.oauth.passcode) {
    throw new Error('OAuth enabled but ZOTEUS_PUBLIC_URL/ZOTEUS_OAUTH_PASSCODE missing');
  }

  const issuerUrl = new URL(config.oauth.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const provider = new ZoteusOAuthProvider({
    passcode: config.oauth.passcode,
    accessTokenTtlSec: config.oauth.accessTokenTtlSec,
    refreshTokenTtlSec: config.oauth.refreshTokenTtlSec,
  });

  return {
    provider,
    issuerUrl,
    resourceServerUrl,
    resourceMetadataUrl,
    allowedHosts: [issuerUrl.host],
    mount(app: Express): void {
      app.use(cors());
      // Custom consent endpoint must be registered before the SDK router so it
      // is not shadowed; the SDK router only owns /authorize, /token, etc.
      app.post('/consent', express.urlencoded({ extended: false }), (req, res) => {
        const authId = typeof req.body?.auth_id === 'string' ? req.body.auth_id : '';
        const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
        void provider.completeConsent(authId, passcode, res);
      });
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
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/auth/router.ts
git commit -m "M10: buildOAuth factory wiring mcpAuthRouter + /consent"
```

---

## Task 4: Rewrite HTTP transport on Express (bearer auth + DNS rebinding; preserve no-auth path)

**Files:**
- Modify: `src/transports/http.ts`
- Test: `tests/integration/http.test.ts` (existing — must stay green)
- Test: `tests/integration/dns-rebinding.test.ts` (new)

- [ ] **Step 1: Write failing DNS-rebinding test** (`tests/integration/dns-rebinding.test.ts`):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';

let httpServer: Server | undefined;
afterEach(() => { httpServer?.close(); httpServer = undefined; });

describe('DNS rebinding protection', () => {
  it('rejects requests whose Host header is not allow-listed', async () => {
    const server = new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } });
    httpServer = await startHttp(server, {
      port: 0,
      host: '127.0.0.1',
      enableDnsRebindingProtection: true,
      allowedHosts: ['zoteus.test'], // request Host will be 127.0.0.1:<port> → rejected
    });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run both transport tests to see DNS test fail, http test still passing**

Run: `npx vitest run tests/integration/http.test.ts tests/integration/dns-rebinding.test.ts`
Expected: `http.test.ts` PASS (old impl), `dns-rebinding.test.ts` FAIL (option ignored).

- [ ] **Step 3: Rewrite** `src/transports/http.ts`:

```ts
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../lib/logger.js';
import type { BuiltOAuth } from '../auth/router.js';

export interface HttpOptions {
  port?: number;
  host?: string;
  path?: string;
  logger?: Logger;
  oauth?: BuiltOAuth;
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
}

/**
 * Start the server on a Streamable HTTP transport (stateless JSON responses) via Express.
 * When `oauth` is provided, OAuth 2.1 metadata/DCR/token/authorize endpoints are mounted and
 * `/mcp` is protected by bearer-token auth; otherwise `/mcp` is unauthenticated (localhost only).
 * Resolves with the underlying http.Server (its address().port is useful when port=0).
 */
export async function startHttp(server: McpServer, opts: HttpOptions = {}): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    enableDnsRebindingProtection: opts.enableDnsRebindingProtection ?? false,
    allowedHosts: opts.allowedHosts,
  });
  await server.connect(transport);

  const app = express();
  app.disable('x-powered-by');

  if (opts.oauth) opts.oauth.mount(app);

  const guards = opts.oauth
    ? [requireBearerAuth({ verifier: opts.oauth.provider, resourceMetadataUrl: opts.oauth.resourceMetadataUrl })]
    : [];

  const handle = async (req: express.Request, res: express.Response): Promise<void> => {
    await transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
  };
  const wrap = (req: express.Request, res: express.Response): void => {
    handle(req, res).catch((err) => {
      opts.logger?.error('HTTP request failed:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  };

  app.post(path, ...guards, express.json({ limit: '8mb' }), wrap);
  app.get(path, ...guards, wrap);
  app.delete(path, ...guards, wrap);
  app.use((_req, res) => res.status(404).json({ error: `Not found. MCP endpoint is ${path}.` }));

  const httpServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(opts.port ?? 0, host, () => resolve(s));
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  opts.logger?.info(
    `Zoteus MCP server listening on http://${host}:${port}${path}${opts.oauth ? ' (OAuth 2.1 enabled)' : ''}`,
  );
  return httpServer;
}
```

- [ ] **Step 4: Run transport tests**

Run: `npx vitest run tests/integration/http.test.ts tests/integration/dns-rebinding.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transports/http.ts tests/integration/dns-rebinding.test.ts
git commit -m "M10: Express HTTP transport with bearer auth + DNS-rebinding protection"
```

---

## Task 5: CLI wiring (`--http` builds OAuth from config)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Implement** — update the `httpFlag` branch in `src/index.ts`:

```ts
  const httpFlag = flag('http');
  if (httpFlag !== undefined) {
    const port = Number(flag('port') ?? process.env.PORT ?? 3939);
    const host = flag('host') ?? process.env.HOST ?? (config.oauth.enabled ? '0.0.0.0' : '127.0.0.1');
    const oauth = buildOAuth(config);
    await startHttp(server, {
      port,
      host,
      logger,
      oauth,
      enableDnsRebindingProtection: Boolean(oauth),
      allowedHosts: oauth?.allowedHosts,
    });
  } else {
    await startStdio(server);
    logger.info('Zoteus MCP server started on stdio.');
  }
```

Add the import near the top:

```ts
import { buildOAuth } from './auth/router.js';
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "M10: enable OAuth on --http when configured; bind 0.0.0.0 behind TLS"
```

---

## Task 6: Integration test — full auth-code + PKCE flow over real HTTP

**Files:**
- Create: `tests/integration/oauth-flow.test.ts`

- [ ] **Step 1: Write the test:**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import pkceChallenge from 'pkce-challenge';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { buildOAuth } from '../../src/auth/router.js';
import { loadConfig } from '../../src/config.js';

let httpServer: Server | undefined;
afterEach(() => { httpServer?.close(); httpServer = undefined; });

function pingServer() {
  const server = new McpServer({ name: 'zoteus-oauth-test', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('ping', { description: 'ping', inputSchema: { msg: z.string() } }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong:${msg}` }],
  }));
  return server;
}

describe('OAuth 2.1 auth-code + PKCE flow', () => {
  it('discovers metadata, registers, consents, exchanges, and serves /mcp with a bearer token', async () => {
    const config = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_PUBLIC_URL: 'http://127.0.0.1', // localhost issuer is allowed; we hit the real bound port directly
      ZOTEUS_OAUTH_PASSCODE: 'open-sesame',
    });
    const oauth = buildOAuth(config)!;
    httpServer = await startHttp(pingServer(), { port: 0, host: '127.0.0.1', oauth });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    // 1. AS metadata
    const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(asMeta.code_challenge_methods_supported).toContain('S256');
    expect(asMeta.response_types_supported).toContain('code');
    expect(asMeta.registration_endpoint).toBeTruthy();

    // 2. Protected-resource metadata (path-specific per RFC 9728)
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.authorization_servers?.length).toBeGreaterThan(0);

    // 3. Unauthenticated /mcp → 401 with WWW-Authenticate resource_metadata
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toMatch(/resource_metadata=/);

    // 4. Dynamic Client Registration (public client)
    const redirectUri = 'http://localhost:45999/callback';
    const reg = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', client_name: 'Test' }),
    });
    expect(reg.status).toBe(201);
    const client = await reg.json();
    expect(client.client_id).toBeTruthy();

    // 5. PKCE
    const { code_verifier, code_challenge } = await pkceChallenge();

    // 6. Authorize (GET) → consent HTML
    const authUrl = new URL(`${base}/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      scope: 'zoteus',
    }).toString();
    const consentHtml = await (await fetch(authUrl)).text();
    const authId = /name="auth_id" value="([^"]+)"/.exec(consentHtml)![1];
    expect(authId).toBeTruthy();

    // 7. Wrong passcode → no redirect
    const bad = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_id: authId, passcode: 'nope' }),
      redirect: 'manual',
    });
    expect(bad.status).toBe(401);

    // 8. Correct passcode → 302 redirect with code + state
    const ok = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_id: authId, passcode: 'open-sesame' }),
      redirect: 'manual',
    });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get('location')!);
    expect(loc.searchParams.get('state')).toBe('state-123');
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 9. Token exchange
    const tokRes = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier,
        client_id: client.client_id,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokRes.status).toBe(200);
    const tokens = await tokRes.json();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();

    // 10. Authenticated MCP client works
    const client2 = new Client({ name: 'oauth-test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    await client2.connect(transport);
    const { tools } = await client2.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');
    const callRes: any = await client2.callTool({ name: 'ping', arguments: { msg: 'hi' } });
    expect(callRes.content[0].text).toBe('pong:hi');
    await client2.close();

    // 11. Wrong PKCE verifier is rejected at the token endpoint
    const { code_challenge: cc2 } = await pkceChallenge();
    const authUrl2 = new URL(`${base}/authorize`);
    authUrl2.search = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      code_challenge: cc2, code_challenge_method: 'S256',
    }).toString();
    const html2 = await (await fetch(authUrl2)).text();
    const authId2 = /name="auth_id" value="([^"]+)"/.exec(html2)![1];
    const ok2 = await fetch(`${base}/consent`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ auth_id: authId2, passcode: 'open-sesame' }), redirect: 'manual',
    });
    const code2 = new URL(ok2.headers.get('location')!).searchParams.get('code')!;
    const badTok = await fetch(`${base}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: code2, code_verifier: 'wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        client_id: client.client_id, redirect_uri: redirectUri,
      }),
    });
    expect(badTok.status).toBe(400);
  }, 30_000);
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run tests/integration/oauth-flow.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/oauth-flow.test.ts
git commit -m "M10: integration test for auth-code + PKCE flow end to end"
```

---

## Task 7: Dependencies + version bump

**Files:**
- Modify: `package.json`
- Modify: `src/server.ts`

- [ ] **Step 1: Declare direct deps + bump version** — in `package.json` set `"version": "0.9.0"` and add to `dependencies` (resolve exact installed versions with `npm ls express cors`):

```json
    "cors": "^2.8.5",
    "express": "^5.2.1",
```

Run: `npm install` (writes lockfile; express/cors already present transitively).

- [ ] **Step 2: Bump server VERSION** — in `src/server.ts`:

```ts
const VERSION = '0.9.0';
```

- [ ] **Step 3: Verify full gate**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: PASS, ~+ new tests, none failing.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/server.ts
git commit -m "M10: declare express/cors deps; bump version to 0.9.0"
```

---

## Task 8: Deployment + docs

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Create: `docs/remote-oauth.md`
- Modify: `README.md` (Claude.ai section + roadmap), `docs/configuration.md`, `.env.example`

- [ ] **Step 1: `Dockerfile`** (multi-stage, build then prune to prod deps):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# OAuth + public bind are supplied via env at deploy time:
#   ZOTERO_API_KEY, ZOTEUS_OAUTH_ENABLED=true, ZOTEUS_PUBLIC_URL=https://<host>,
#   ZOTEUS_OAUTH_PASSCODE=<secret>, ZOTEUS_READ_ONLY=true (recommended)
EXPOSE 3939
ENTRYPOINT ["node", "dist/index.js", "--http", "--port", "3939", "--host", "0.0.0.0"]
```

`.dockerignore`:

```
node_modules
dist
.env
.git
tests
docs
*.log
```

- [ ] **Step 2: `docs/remote-oauth.md`** — write the full walkthrough: architecture (single-tenant gating), required env vars, deploy options (Fly.io / Render / Railway / VPS+Caddy / Cloudflare named tunnel) all behind HTTPS, the claude.ai connect steps (Settings → Connectors → Add custom connector → paste `https://<host>/mcp` → Connect → passcode consent → tools appear), and security notes (`ZOTEUS_READ_ONLY=true` recommended, rotate passcode, single ZOTERO_API_KEY tenant model, M11 multi-tenant note). Include a local end-to-end verification recipe using a Cloudflare quick/named tunnel.

- [ ] **Step 3: README Claude.ai section** — replace the "Status: …does not yet implement OAuth" block (README.md around lines 80–93) with a working walkthrough: run with OAuth env vars, expose via HTTPS, add as a custom connector, complete passcode consent. Link `docs/remote-oauth.md`. Update the roadmap line to add `- [x] **10** OAuth 2.1 + PKCE + hosted remote (claude.ai connector)`.

- [ ] **Step 4: `.env.example`** — add an OAuth block:

```bash
# --- Remote OAuth (claude.ai web custom connector) ---
# Turn Zoteus's HTTP endpoint into an OAuth 2.1 + PKCE protected resource.
ZOTEUS_OAUTH_ENABLED=false
# Public HTTPS origin claude.ai will reach (no trailing slash). Required when enabled.
# ZOTEUS_PUBLIC_URL=https://zoteus.example.com
# Shared passcode that gates the consent step. Required when enabled.
# ZOTEUS_OAUTH_PASSCODE=
# Optional token lifetimes (seconds).
# ZOTEUS_OAUTH_ACCESS_TTL=3600
# ZOTEUS_OAUTH_REFRESH_TTL=2592000
```

- [ ] **Step 5: `docs/configuration.md`** — document the five new env vars in the config table/section, matching existing style.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docs/remote-oauth.md README.md docs/configuration.md .env.example
git commit -m "M10: Dockerfile + remote-oauth docs + README/.env/config updates"
```

---

## Task 9: Final verification gate + end-to-end + tag

**Files:** none (verification only)

- [ ] **Step 1: Full local gate**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: all green. Capture the test count.

- [ ] **Step 2: Docker build sanity**

Run: `docker build -t zoteus:0.9.0 .` (or `podman build`). Expected: image builds.

- [ ] **Step 3: Real claude.ai end-to-end** (per verification-before-completion skill — do NOT claim done without this):
  1. Start a public HTTPS instance: either deploy the image, or run locally `ZOTERO_API_KEY=… ZOTEUS_OAUTH_ENABLED=true ZOTEUS_PUBLIC_URL=https://<tunnel-host> ZOTEUS_OAUTH_PASSCODE=… ZOTEUS_READ_ONLY=true node dist/index.js --http --host 0.0.0.0 --port 3939` behind a **stable named tunnel** (`cloudflared tunnel run` mapped to a fixed hostname; the `ZOTEUS_PUBLIC_URL` must equal the tunnel hostname so `allowedHosts` matches).
  2. In claude.ai → Settings → Connectors → Add custom connector → URL `https://<host>/mcp` → Connect.
  3. Complete the OAuth consent (enter the passcode).
  4. Confirm the tool list loads and a read call (e.g. `zotero_whoami` or `zotero_search_items`) succeeds.
  5. Record the result in the PR/commit notes.

- [ ] **Step 4: Tag**

```bash
git tag v0.9.0
git push origin main --tags
```

---

## Self-Review (run before execution)

- **Spec coverage:** OAuth metadata (RFC 8414 + 9728) → Task 3/6; DCR (RFC 7591) → Task 3/6; authorization endpoint + PKCE S256 → Task 2/6; passcode consent gate → Task 2/3/6; token endpoint → Task 2/6; `requireBearerAuth` on `/mcp` → Task 4/6; loopback port-agnostic redirect → relies on SDK `redirectUriMatches` (covered by DCR redirect in Task 6); DNS-rebinding `allowedHosts` + `0.0.0.0` bind → Task 4/5; config/CLI touch points → Task 1/5; Dockerfile + docs + README → Task 8; tests green + integration → Task 6/7/9; end-to-end verify + tag → Task 9. ✅ All covered.
- **Placeholders:** none — every code step is concrete. The only intentional follow-up is M11 multi-tenant (out of scope, documented).
- **Type consistency:** `ZoteusOAuthProvider` methods match the SDK `OAuthServerProvider` interface (`authorize`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode`, `exchangeRefreshToken`, `verifyAccessToken`, `revokeToken`, `clientsStore`); `BuiltOAuth.provider` is the verifier passed to `requireBearerAuth`; `completeConsent(authId, passcode, res)` signature consistent across provider, router, and tests; config field `oauth.{enabled,publicUrl,passcode,accessTokenTtlSec,refreshTokenTtlSec}` consistent across config/router/index.

## Risks / notes

- **ESM:** all relative imports end in `.js`; `node:crypto` import for `timingSafeEqual` (no `require`).
- **Single instance only:** in-memory token store means tokens don't survive restart and don't share across replicas. Documented; fine for single-tenant v1. A persistent store is a future enhancement.
- **Issuer scheme:** production `ZOTEUS_PUBLIC_URL` must be `https://…`; the SDK only exempts `localhost`/`127.0.0.1`. Tests use `http://127.0.0.1`.
- **DNS rebinding in tests:** the full-flow test runs with protection off (issuer host has no port, real bound port differs); a dedicated test covers the rejection path. Production sets `allowedHosts=[publicHost]` which matches the proxied Host header.
- **Read-only:** recommend `ZOTEUS_READ_ONLY=true` for public connectors (already supported); not forced.
