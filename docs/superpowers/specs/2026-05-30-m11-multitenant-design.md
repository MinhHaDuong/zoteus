# M11 — Multi-tenant (per-user Zotero accounts) for the claude.ai connector — Design

**Status:** approved design, ready for implementation planning.
**Target tag:** `v0.10.0` (reserve `v1.0.0` for the npm publish).
**Supersedes nothing; extends M10** (`docs/superpowers/plans/2026-05-29-zoteus-m10-oauth-remote.md`). Source brief: `docs/superpowers/NEXT-AGENT-m11-multitenant.md`.

## Goal

Make Zoteus **multi-tenant**: each user who adds the connector authorizes **their own Zotero account**, and every MCP call runs against *that user's* library — not the operator's. Today (v0.9.0) the deployed instance holds one operator `ZOTERO_API_KEY` and OAuth only gates *who may connect* (a shared passcode). M11 performs **Zotero's OAuth 1.0a** per user and binds the resulting per-user Zotero key to the Zoteus-issued bearer token, while keeping the entire M10 OAuth 2.1 surface (which claude.ai already speaks) unchanged for the client.

## Non-goals (v1)

- Replacing the M10 passcode mode — it stays the **default** and the regression guard.
- Multi-replica / horizontal scale (the file store is single-instance, like M10's memory store).
- CIMD (`client_id_metadata_document_supported`) — noted as a future enhancement, not built here.
- Local desktop API in hosted multi-tenant mode — irrelevant on a hosted deploy; cloud per-user key handles everything.

## Verified facts — Zotero OAuth 1.0a

Source: https://www.zotero.org/support/dev/web_api/v3/oauth

- **OAuth 1.0a, 3-legged, HMAC-SHA1** signed. One operator-level Zotero app (Client Key + Client Secret), registered at https://www.zotero.org/oauth/apps.
- Endpoints: request token `https://www.zotero.org/oauth/request` → authorize `https://www.zotero.org/oauth/authorize?oauth_token=<request_token>` → access token `https://www.zotero.org/oauth/access`.
- The access-token exchange returns **`userID`** and an **`oauth_token_secret` that IS the user's permanent Zotero API key** ("the token and secret are just the same Zotero API key"). Store that key; use it exactly like a `ZOTERO_API_KEY`.
- Authorize-step permission GET params pre-set the key scopes: `name`, `library_access` (0/1), `notes_access` (0/1), `write_access` (0/1), `all_groups` (none/read/write), `identity=1`. A read-only connector requests `library_access=1&write_access=0&all_groups=read`.

## Architecture

Zoteus remains its **own OAuth 2.1 authorization server** facing claude.ai (DCR, authorize, token, rotating refresh, bearer-protected `/mcp`, RFC 8414/9728 discovery — all from M10, unchanged). The single change is the **consent strategy**: a config-selected mode swaps the passcode page for a **bridged Zotero OAuth 1.0a login**, and the issued bearer token is bound to the resulting per-user Zotero key.

```
claude.ai ──OAuth2.1 (DCR/authorize/token/bearer)──▶ Zoteus AS
                                                       │
                          consent strategy = zotero ───┤
                                                       ▼
   browser ◀─302─ /authorize ──▶ zotero.org/oauth/authorize?oauth_token=…
   browser ──▶ /oauth/zotero/callback?oauth_token&oauth_verifier
                                                       │ exchange at /oauth/access
                                                       ▼  → {zoteroKey, zoteroUserId, username}
                          mint one-time auth code bound to user ──302──▶ claude.ai redirect_uri
   claude.ai ──/token──▶ access+refresh tokens carrying {zoteroKey,zoteroUserId,username}
   claude.ai ──Bearer /mcp initialize──▶ getOrCreateContext(authInfo) → per-user ToolContext
```

### Consent modes

`ZOTEUS_OAUTH_MODE = passcode | zotero` (default `passcode`).

- **`passcode`** (M10): `authorize()` renders the passcode page; `POST /consent` verifies it; behavior is byte-for-byte identical to today. Issued tokens carry **no** Zotero key → resolve to the shared operator context.
- **`zotero`** (M11): `authorize()` starts Zotero OAuth 1.0a and redirects to zotero.org; `GET /oauth/zotero/callback` completes it. Issued tokens carry the per-user `{zoteroKey, zoteroUserId, username}`.

### Bridged Zotero OAuth 1.0a flow (`zotero` mode)

1. **`authorize(client, params, res)`** — instead of rendering the passcode page:
   - Call Zotero `/oauth/request` (signed request, `oauth_callback=<publicUrl>/oauth/zotero/callback`) → `{ oauth_token, oauth_token_secret }`.
   - Store a **`PendingConsent`** (existing shape: `clientId/clientName/redirectUri/codeChallenge/state/scopes/resource`) **plus the Zotero request `oauth_token_secret`**, keyed by the **Zotero request `oauth_token`** (so the callback can recover it; this token is the OAuth 1.0a equivalent of the M10 `authId`).
   - 302-redirect the browser to `https://www.zotero.org/oauth/authorize?oauth_token=<request_token>&library_access=1&write_access=<0|1>&all_groups=<read|write>&identity=1&name=Zoteus`.
2. **`GET /oauth/zotero/callback?oauth_token&oauth_verifier`** (new route, no CORS, like `/consent`):
   - Recover the pending consent by `oauth_token`; if missing/expired → friendly error page.
   - Call Zotero `/oauth/access` (signed with the request token + its secret + the verifier) → `{ userID, username, oauth_token_secret }`. **`oauth_token_secret` is the user's permanent Zotero API key.**
   - Complete exactly like `completeConsent`: mint a one-time auth code bound to the pending request **and to `{zoteroKey, zoteroUserId, username}`**; 302 back to the client `redirect_uri` with `code` (+`state`).
3. **Token records** (`StoredCode` → `StoredAccess`/`StoredRefresh`) gain optional `zoteroKey/zoteroUserId/username`, carried through `exchangeAuthorizationCode` and `exchangeRefreshToken`.
4. **`verifyAccessToken`** returns them in **`AuthInfo.extra`**: `{ zoteroKey, zoteroUserId, username }`. (Must keep returning a finite numeric `expiresAt` — `requireBearerAuth` rejects tokens without it.)

### Per-user ToolContext

`buildServer` is factored into two functions:

- **`buildContext(config, overrides?: { apiKey?; zoteroUserId?; searchIndexPath? }): Promise<ToolContext>`** — the expensive part: per-user `WebApiClient` (with that user's key), capability probe, `LibraryRouter`, `SearchIndex`, etc. Overrides default to the operator config (so `passcode`/stdio/no-auth are unchanged).
- **`createServer(ctx): McpServer`** — unchanged registration of tools/resources/prompts.

A **context cache** `getOrCreateContext(authInfo)` keyed by `zoteroUserId` (LRU, capped, idle-evicted) makes reconnects cheap — only the first connection per user pays the probe cost. No `zoteroUserId` in `authInfo.extra` (passcode/stdio/no-auth) → the **shared operator context** (built once at startup as today).

`startHttp`'s per-session factory becomes **auth-aware**: on `initialize`, read `req.auth` (the `AuthInfo` attached by `requireBearerAuth`) → `getOrCreateContext(authInfo)` → `createServer(ctx)`. Sessions without auth (no OAuth) use the operator context, preserving the M10 local path.

Because reads route through `ctx.router` → `ctx.web` (built with the per-user key), **`zotero_whoami` and every read/write automatically act as that tenant** with no per-tool changes.

### Per-user semantic index

`ToolContext` gains `searchIndexPath: string`. `buildContext` sets it to `search-index-<zoteroUserId>.json` for per-user contexts and `search-index.json` for the operator context, both under `dataDir`. `tools/index-tool.ts` reads `ctx.searchIndexPath` instead of the hardcoded `join(dataDir, 'search-index.json')`; `buildContext` loads that path at startup. Each tenant gets an isolated index; no cross-tenant leakage.

### OAuth 1.0a signing module — `src/auth/zotero-oauth.ts`

Self-contained, no new heavy dependency (HMAC-SHA1 via `node:crypto`). Responsibilities:

- `percentEncode`, `buildSignatureBaseString(method, baseUrl, params)`, `sign(baseString, consumerSecret, tokenSecret?)` (RFC 5849 §3.4: sorted percent-encoded params, `&`-joined key with empty token secret when none).
- `requestToken({clientKey, clientSecret, callbackUrl})` → `{ oauth_token, oauth_token_secret }`.
- `accessToken({clientKey, clientSecret, oauthToken, oauthTokenSecret, verifier})` → `{ userID, username, oauthTokenSecret }`.
- `buildAuthorizeUrl({ oauthToken, readOnly, name })`.
- Zotero base URL + API base injectable (constructor/param default to real hosts) so tests point at a local mock. Parses both `application/x-www-form-urlencoded` (request/access) responses.

**Unit-tested first, in isolation,** against the published RFC 5849 / OAuth 1.0a example signature vector (deterministic base string + signature) — signing is fiddly (percent-encoding, sorted params, base string) and must be correct before the flow is wired.

### Persistent store — `src/auth/store.ts`

One interface, two implementations behind it:

```
interface OAuthStore {
  // clients
  getClient(id): OAuthClientInformationFull | undefined
  setClient(info): void
  allClientIds(): string[]              // for FIFO cap
  deleteClient(id): void
  // access tokens
  getAccess(token): StoredAccess | undefined
  setAccess(token, rec): void
  deleteAccess(token): void
  // refresh tokens
  getRefresh(token): StoredRefresh | undefined
  setRefresh(token, rec): void
  deleteRefresh(token): void
}
```

- **`MemoryStore`** (default; `ZOTEUS_OAUTH_STORE=memory`) — the M10 in-memory Maps, refactored behind the interface. No behavior change.
- **`FileStore`** (`ZOTEUS_OAUTH_STORE=file`) — persists **durable state only**: clients + access tokens + refresh tokens (the records carry the per-user Zotero key). Short-lived `pending`-consents and 60-second auth codes stay **in-memory** (a mid-flow restart just re-prompts; persisting sub-10-min state buys nothing). Writes are debounced/atomic (write temp + rename). The whole JSON file is **encrypted with AES-256-GCM** (random IV per write, auth tag stored) using a key derived from `ZOTEUS_OAUTH_TOKEN_SECRET`. On load, expired entries are swept.
- **Fail-fast:** when `ZOTEUS_OAUTH_STORE=file`, a valid `ZOTEUS_OAUTH_TOKEN_SECRET` is **required** — `loadConfig` throws with a clear message + `openssl rand -base64 32` hint. Real Zotero keys are never written to disk unencrypted.

The provider takes an `OAuthStore` (default `new MemoryStore()`), so all existing provider tests pass unchanged.

### Config additions (`src/config.ts`)

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_OAUTH_MODE` | `passcode` | `passcode \| zotero`. `zotero` enables per-user Zotero login. |
| `ZOTERO_OAUTH_CLIENT_KEY` | — | Zotero app Client Key. **Required when mode=zotero.** |
| `ZOTERO_OAUTH_CLIENT_SECRET` | — | Zotero app Client Secret. **Required when mode=zotero.** |
| `ZOTEUS_OAUTH_STORE` | `memory` | `memory \| file`. `file` persists clients/tokens/keys across restarts. |
| `ZOTEUS_OAUTH_TOKEN_SECRET` | — | AES-256-GCM key material for at-rest encryption. **Required when store=file.** |

Cross-field validation: `mode=zotero` requires the Zotero client key+secret (and OAuth enabled + a public URL); `store=file` requires `ZOTEUS_OAUTH_TOKEN_SECRET`. `passcode` is still required in `passcode` mode but **not** in `zotero` mode (Zotero login replaces it).

## Data flow (zotero mode, happy path)

1. claude.ai → DCR `/register` → `/authorize` (PKCE S256).
2. `authorize()` → Zotero `/oauth/request` → store pending (keyed by Zotero request token) → 302 to zotero.org authorize.
3. User approves on zotero.org → browser → `GET /oauth/zotero/callback?oauth_token&oauth_verifier`.
4. Callback → Zotero `/oauth/access` → `{userID, username, key}` → mint code bound to user → 302 to claude.ai with `code`+`state`.
5. claude.ai `/token` (code+verifier) → access+refresh carrying `{zoteroKey,zoteroUserId,username}`.
6. claude.ai `Bearer /mcp initialize` → `getOrCreateContext(authInfo)` builds/reuses the user's context → `createServer(ctx)`.
7. `zotero_whoami` / reads → `ctx.web` (user key) → that user's identity & library.

## Error handling

- Zotero `/oauth/request` or `/oauth/access` failure → friendly HTML error page (reuse the consent error variant) + logged server-side; no token minted.
- Callback with unknown/expired `oauth_token` → "Session expired — please reconnect" error page (mirrors `completeConsent` expiry).
- `verifyAccessToken` unchanged contract: finite numeric `expiresAt`, throws `InvalidTokenError` on unknown/expired.
- FileStore decrypt failure (wrong/rotated secret) → log a clear error and start with an empty store (clients re-register, users re-auth) rather than crashing; never silently serve garbage.
- `getOrCreateContext` probe failure for a user → surfaced as a connect-time error; not cached.

## Testing strategy (TDD, Vitest)

1. **`tests/auth/zotero-oauth.test.ts`** — signature base string + HMAC-SHA1 signature against a known RFC 5849 / published vector; percent-encoding edge cases; request/access response parsing (mock fetch).
2. **`tests/auth/store.test.ts`** — `FileStore` round-trips clients/tokens; AES-GCM encrypt→decrypt; wrong secret fails closed (empty store); expiry sweep; atomic write. `MemoryStore` parity.
3. **`tests/auth/provider.test.ts`** (extend) — `zotero` mode: `authorize()` redirects to zotero.org (mock 1.0a) and stores pending by request token; callback exchanges and mints a user-bound code; `verifyAccessToken` returns `extra.{zoteroKey,zoteroUserId,username}`. **All existing passcode-mode tests stay green unchanged.**
4. **`tests/integration/multitenant.test.ts`** — full HTTP flow with a **local mock Zotero** (`/oauth/request|authorize|access` + `api.zotero.org/keys/current` per key). Simulate **two distinct users**; assert their two bearer tokens resolve to **different `zoteroUserId`** and that `zotero_whoami` over `/mcp` returns each user's own identity (not the operator's, not each other's).
5. **Regression:** the entire M10 suite (`oauth-flow`, `http-sessions`, `dns-rebinding`, `config`, provider) must stay green — `passcode` mode is the guard.

The Zotero API base + OAuth base become injectable (default real hosts) purely to enable the mock; production is unaffected.

## Deployment

- `Dockerfile` / `docs/remote-oauth.md` updated for `zotero` mode + file store: mount a volume for `dataDir`, set `ZOTEUS_OAUTH_MODE=zotero`, `ZOTERO_OAUTH_CLIENT_KEY/SECRET`, `ZOTEUS_OAUTH_STORE=file`, `ZOTEUS_OAUTH_TOKEN_SECRET`.
- A **runbook** in `docs/remote-oauth.md`: register the Zotero app, choose a stable HTTPS host (Fly/Render/Railway/VPS+Caddy/named cloudflared), set the callback to `<publicUrl>/oauth/zotero/callback`, and the **two-account verification** procedure in real claude.ai.
- **Live two-account verification is performed by the operator** (needs the Zotero app creds, two accounts, and a host — not available to the implementing agent). The automated two-user integration test provides equivalent coverage against the mock.

## House style / constraints

- TDD with Vitest; keep `npm run typecheck && npm run lint && npm run build && npm test` green throughout.
- TypeScript NodeNext ESM — relative imports end in `.js`.
- **Commits: no co-authoring/attribution trailers.**
- Real Zotero keys live only in git-ignored `.env`; user keys encrypted at rest in the file store; the store file lives under `dataDir` (already git-ignored).
- `passcode` mode default + all M10 tests unchanged.
- Tag `v0.10.0` when the gate is green and docs/runbook are in.

## File-level change list

**New**
- `src/auth/zotero-oauth.ts` — OAuth 1.0a signing + request/access helpers.
- `src/auth/store.ts` — `OAuthStore` interface + `MemoryStore` + encrypted `FileStore`.
- `tests/auth/zotero-oauth.test.ts`, `tests/auth/store.test.ts`, `tests/integration/multitenant.test.ts`.

**Modified**
- `src/config.ts` — `ZOTEUS_OAUTH_MODE`, `ZOTERO_OAUTH_CLIENT_KEY/SECRET`, `ZOTEUS_OAUTH_STORE`, `ZOTEUS_OAUTH_TOKEN_SECRET` + cross-field validation.
- `src/auth/provider.ts` — pluggable consent strategy; `OAuthStore` injection; token records carry Zotero identity; `verifyAccessToken` → `AuthInfo.extra`; new `completeZoteroCallback`.
- `src/auth/router.ts` — mount `GET /oauth/zotero/callback` in `zotero` mode; pass mode + Zotero creds + store to the provider.
- `src/auth/consent.ts` — reuse the error page for Zotero-flow failures (minor).
- `src/server.ts` — split into `buildContext(config, overrides)` + `createServer(ctx)`; export `getOrCreateContext(authInfo)` cache; bump `VERSION` to `0.10.0`.
- `src/transports/http.ts` — auth-aware per-session factory (resolve per-user context from `req.auth`).
- `src/index.ts` — wire the context cache + auth-aware factory.
- `src/registry/registry.ts` — `ToolContext.searchIndexPath`.
- `src/tools/index-tool.ts` — use `ctx.searchIndexPath`.
- `package.json` — version `0.10.0`.
- `Dockerfile`, `docs/remote-oauth.md`, `docs/configuration.md`, `.env.example`, `README.md` — zotero mode + file store + runbook.

## Open risks / watch-outs

- OAuth 1.0a signing correctness — mitigated by isolated vector test before wiring.
- `AuthInfo.extra` propagation — confirm `requireBearerAuth` attaches the full `AuthInfo` (incl. `extra`) to `req.auth` (SDK 1.29). Verify during implementation; fall back to a token→identity lookup via the provider if `extra` is stripped.
- Context cache eviction must not close an in-use session's server; evict by idle time, not hard cap mid-session.
- Don't break `passcode` mode — it's the default and the regression guard.
