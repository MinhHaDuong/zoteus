# Handoff brief — M11: Multi-tenant (per-user Zotero accounts) for the claude.ai connector

**Status going in:** Zoteus is at **v0.9.0** (repo `oscardvs/zoteus`, local checkout `/home/odesha/zoteus`, CI green). M10 shipped a working **claude.ai (web) custom connector**: Zoteus is its own **OAuth 2.1 + PKCE** authorization server (DCR, authorize, passcode consent, token + rotating refresh, bearer-protected `/mcp`, RFC 8414/9728 discovery) on an Express Streamable-HTTP transport with **per-session transports**, DNS-rebinding protection, and a non-loopback-bind guard. It was verified end-to-end in real claude.ai. **Today it is single-tenant:** the deployed instance holds **one operator `ZOTERO_API_KEY`** and OAuth only controls *who may connect* (a shared `ZOTEUS_OAUTH_PASSCODE`), not *whose* Zotero library is used. Token/client state is **in-memory**. Key M10 files: `src/auth/provider.ts` (`ZoteusOAuthProvider`), `src/auth/router.ts` (`buildOAuth` + `mcpAuthRouter` + `/consent`), `src/transports/http.ts` (per-session factory), `src/config.ts`, `src/server.ts` (`buildServer` → `{ server, ctx, createServer }`). See `docs/remote-oauth.md` and `docs/superpowers/plans/2026-05-29-zoteus-m10-oauth-remote.md`.

**Goal:** Make Zoteus **multi-tenant** — each user who adds the connector authorizes **their own Zotero account**, and every MCP call runs against *that user's* library, not the operator's. This requires actually performing **Zotero's OAuth 1.0a** per user (the thing M10 deliberately deferred) and binding the resulting per-user Zotero key to the Zoteus-issued bearer token.

## Verified facts — Zotero OAuth 1.0a (source: https://www.zotero.org/support/dev/web_api/v3/oauth)
- It is **OAuth 1.0a, 3-legged, HMAC-SHA1** signed. Register a Zotero app at `https://www.zotero.org/oauth/apps` to get a **Client Key + Client Secret** (operator-level, one app).
- Endpoints: request token `https://www.zotero.org/oauth/request` → user authorize `https://www.zotero.org/oauth/authorize?oauth_token=<request_token>` → access token `https://www.zotero.org/oauth/access`.
- The access-token exchange returns **`userID`** and an **`oauth_token_secret` that IS the user's permanent Zotero API key** ("the token and secret are just the same Zotero API key"). Store that key; use it exactly like a `ZOTERO_API_KEY`.
- Permission GET params on the authorize step pre-set the key scopes: `name`, `library_access` (0/1), `notes_access` (0/1), `write_access` (0/1), `all_groups` (none/read/write), `identity=1`. For a read-only connector request `library_access=1&write_access=0&all_groups=read` (or `none`).

## Key design decision (recommended)
Keep Zoteus's **OAuth 2.1** server as the claude.ai-facing layer (unchanged for the client). Replace the single passcode consent with a **bridged Zotero OAuth 1.0a login**, and bind the issued bearer token to the resulting per-user Zotero key:

1. Add a config mode `ZOTEUS_OAUTH_MODE=passcode|zotero` (default `passcode` to preserve M10). In `zotero` mode, set new config `ZOTERO_OAUTH_CLIENT_KEY` / `ZOTERO_OAUTH_CLIENT_SECRET`.
2. In `ZoteusOAuthProvider.authorize(...)` (today it renders the passcode page), instead **start Zotero OAuth 1.0a**: fetch a request token, stash the pending Zoteus authorization (the existing `pending` map already holds `clientId/redirectUri/codeChallenge/state/scopes`) keyed so it can be recovered, and redirect the browser to Zotero's authorize URL.
3. Add a **Zotero callback** route (e.g. `GET /oauth/zotero/callback`) — analogous to today's `/consent` — that receives `oauth_token` + `oauth_verifier`, exchanges for the **per-user Zotero key + userID**, then completes the Zoteus flow exactly like `completeConsent` does today (mint a one-time auth code bound to the pending request **and to the user's Zotero key/userID**, 302 back to the client `redirect_uri` with `code`+`state`).
4. At token exchange, carry the user's Zotero key/userID into the access-token record so **`verifyAccessToken` returns it in `AuthInfo.extra`** (e.g. `extra: { zoteroKey, zoteroUserId, username }`). `requireBearerAuth` already attaches `AuthInfo` to the request.
5. **Per-user server/context.** Today `startHttp` takes a `() => McpServer` factory sharing one `ctx`. Change the per-session creation to receive the authenticated `AuthInfo` (it's available on the initialize request via `req.auth`) and build/look-up a **per-user `ToolContext`** whose `WebApiClient` uses that user's Zotero key. Cache contexts by `zoteroUserId` (LRU, evict idle) so reconnects are cheap — `buildContext` (capability probe) is the expensive part; factor `buildServer` into `buildContext(config, { apiKey })` + `createServer(ctx)`.

This delivers true multi-tenant access while reusing the entire M10 OAuth 2.1 surface claude.ai already speaks.

## Sub-deliverables
- **Persistent store** (replaces in-memory Maps): registered clients, auth codes, access/refresh tokens, **and per-user Zotero keys** must survive restarts (otherwise every restart forces all users back through Zotero OAuth). A small SQLite (or a single JSON file via the existing `dataDir`) store behind the `OAuthRegisteredClientsStore` + token interfaces. **Encrypt the stored Zotero keys at rest** (they are real credentials) — e.g. AES-GCM with a `ZOTEUS_OAUTH_TOKEN_SECRET`.
- **Per-user search index** (`zotero_semantic_search`/`zotero_index`): the index is per-library. Either scope index files by `zoteroUserId` under `dataDir`, or disable semantic tools in `zotero` mode for v1 and note it. Flag clearly.
- **CIMD (optional, recommended by Claude for scale):** advertise `client_id_metadata_document_supported` and accept a URL `client_id` resolving to a client-metadata document, to avoid registering a fresh DCR client per connection. Lower priority than multi-tenant itself.
- **Local API**: irrelevant on a hosted multi-tenant deploy (no desktop); keep `ZOTEUS_LOCAL=off` for cloud and route everything through the per-user cloud key.

## Implementation pointers
- New `src/auth/zotero-oauth.ts`: OAuth 1.0a request/authorize/access helpers (HMAC-SHA1 signing via `node:crypto`; no new heavy dep needed). Unit-test the signature base string + signing against the RFC 5849 example vectors.
- Extend `ZoteusOAuthProvider` (`src/auth/provider.ts`): pluggable consent strategy (passcode vs zotero); token records gain `zoteroKey`/`zoteroUserId`; `verifyAccessToken` returns them in `AuthInfo.extra`.
- `src/auth/router.ts`: in `zotero` mode mount `GET /oauth/zotero/callback` (no CORS, like `/consent`); keep the passcode path for `passcode` mode.
- `src/server.ts`: split `buildServer` into `buildContext(config, overrides)` + `createServer(ctx)`; export a `getOrCreateContext(authInfo)` cache for the HTTP path.
- `src/transports/http.ts`: per-session factory becomes auth-aware — on `initialize`, read `req.auth` → resolve the per-user context → `createServer(ctx)`.
- `src/config.ts`: add `ZOTEUS_OAUTH_MODE`, `ZOTERO_OAUTH_CLIENT_KEY`, `ZOTERO_OAUTH_CLIENT_SECRET`, `ZOTEUS_OAUTH_TOKEN_SECRET` (for at-rest encryption / persistence), `ZOTEUS_OAUTH_STORE` (memory|sqlite|file). Validate that `zotero` mode requires the Zotero client credentials.

## Deployment deliverable
- Update `Dockerfile`/`docs/remote-oauth.md` for `zotero` mode + persistent store (mount a volume for the store/encryption). The M10 verification used an **ephemeral ngrok tunnel (now down)** — M11 should also stand up a **stable hosted instance** (Fly/Render/Railway/VPS+Caddy/named cloudflared) so multi-user testing is real.

## Constraints / house style (match the repo)
- **TDD with Vitest.** Unit-test the OAuth 1.0a signing + the bridged flow; add an integration test that simulates two distinct Zotero users and asserts each bearer token resolves to a different `zoteroUserId` and library. Keep `npm run typecheck && npm run lint && npm run build && npm test` green.
- TypeScript **NodeNext ESM** — relative imports end in `.js`.
- **Commits: never include co-authoring/attribution trailers.**
- Real Zotero keys live in the git-ignored `.env` — never commit them; encrypt user keys at rest in the store.
- Use the superpowers skills: **writing-plans** → implement (TDD) → **verification-before-completion**. Add a plan doc under `docs/superpowers/plans/`. Tag **`v0.10.0`** when done (reserve `v1.0.0` for the npm publish).
- **Verify end-to-end before claiming done:** deploy/tunnel a stable HTTPS instance, connect **two different Zotero accounts** in claude.ai, and confirm each `zotero_whoami` + a read returns that user's own identity/library (not the operator's, and not each other's).

## Watch-outs
- Don't break M10: `passcode` mode must stay the default and keep working (its tests are the regression guard).
- `verifyAccessToken` must keep returning a numeric `expiresAt` (the SDK `requireBearerAuth` rejects tokens without it).
- Per-user context build is expensive — cache by `zoteroUserId` and cap/evict; never build a context per request.
- Zotero OAuth 1.0a signing is fiddly (percent-encoding, sorted params, base string) — test it in isolation first.
