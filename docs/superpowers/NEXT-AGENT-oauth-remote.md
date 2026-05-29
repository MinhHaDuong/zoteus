# Handoff brief — M10: OAuth 2.1 + hosted remote so Zoteus works as a claude.ai connector

**Status going in:** Zoteus is feature-complete through **v0.8.2** (repo `oscardvs/zoteus`, local checkout `/home/odesha/zoteus`, CI green on Node 18/20/22). It has 24 tools, 7 prompts, ~124 tests, and **both stdio and Streamable HTTP transports** (`src/transports/http.ts`, `zoteus --http`). The HTTP endpoint is currently **unauthenticated** and binds to `127.0.0.1`. A `ZOTEUS_READ_ONLY=true` mode already exists.

**Goal:** Make Zoteus usable as a **claude.ai (web) custom connector** — i.e. reachable at a public HTTPS URL and protected by **OAuth 2.1** so claude.ai can perform its authorization-code + PKCE flow. Today this is the only missing piece (OAuth was a documented v1 non-goal).

## Verified requirements (claude.ai custom connectors)
- Server must be **public over HTTPS** (Anthropic egress IPs connect to it). `localhost` does not work.
- **OAuth 2.1 authorization-code flow with PKCE `S256`** (Claude always sends `code_challenge_method=S256`).
- The connector "Advanced settings" accepts an **OAuth client id/secret**, OR the server supports **Dynamic Client Registration (RFC 7591)** so Claude self-registers. **Static API keys / `Authorization` headers are NOT accepted** by the connector UI.
- Authorization-server **discovery metadata** must be served at `/.well-known/oauth-authorization-server` (RFC 8414) and protected-resource metadata at `/.well-known/oauth-protected-resource` (RFC 9728).
- Redirect/callback must accept `http://localhost/callback` and `http://127.0.0.1/callback` with **port-agnostic matching** (port varies per session).
- **No access token in the URL query string** (prohibited by the MCP auth spec).
- Sources: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp · https://claude.com/docs/connectors/building/authentication · https://modelcontextprotocol.io/docs/develop/connect-remote-servers

## Key design decision (recommended)
Zotero's own API uses **OAuth 1.0a**, so you can't simply proxy Zotero's OAuth to satisfy claude.ai's OAuth 2.1. Recommended **single-tenant gating** model for v1:
- Zoteus acts as its **own OAuth 2.1 Authorization Server** (issues short-lived bearer tokens).
- The deployed server holds **one** `ZOTERO_API_KEY` (the operator's) in env; OAuth only controls **who may connect**, not which Zotero account is used.
- A minimal consent/login step (e.g. a single configured passcode `ZOTEUS_OAUTH_PASSCODE`, or an allowlist) gates issuance.
- This satisfies claude.ai's OAuth requirement and secures the public endpoint without a full multi-tenant Zotero-OAuth-1.0a implementation. (Note multi-tenant per-user Zotero keys as a future M11.)

## Implementation pointers
- The SDK (`@modelcontextprotocol/sdk@^1.29`) ships OAuth helpers under `@modelcontextprotocol/sdk/server/auth/*`: `mcpAuthRouter`, `ProxyOAuthServerProvider`, `OAuthServerProvider`, `requireBearerAuth`, and metadata routers. Build on these rather than hand-rolling.
- Add OAuth endpoints + metadata to the HTTP server in `src/transports/http.ts` (or a new `src/transports/oauth.ts`), and wrap the `/mcp` handler with bearer-auth middleware.
- Implement DCR so claude.ai self-registers; persist clients/tokens in memory (single instance) or a small store.
- Enable **DNS-rebinding protection** (`allowedHosts`) on `StreamableHTTPServerTransport` once a fixed public host is known, and bind `0.0.0.0` behind TLS.
- New config (in `src/config.ts`): `ZOTEUS_PUBLIC_URL` (issuer), `ZOTEUS_OAUTH_PASSCODE` or allowlist, token-signing secret, `ZOTEUS_OAUTH_ENABLED`.
- CLI: extend `src/index.ts` `--http` path to enable OAuth when configured.

## Deployment deliverable
- A **Dockerfile** + deploy notes for a public HTTPS host (Fly.io / Render / Railway / VPS+Caddy / Cloudflare named tunnel). TLS is required.
- `docs/remote-oauth.md` with the full claude.ai connect walkthrough; update the README "Claude.ai (web)" section from "not implemented" to "implemented" with steps.

## Constraints / house style (match the existing repo)
- TDD with **Vitest**; unit-test the OAuth endpoints (metadata, DCR, token, PKCE S256 verification) and add an integration test simulating the auth-code+PKCE flow against the in-process server. Keep CI green.
- TypeScript **NodeNext ESM** — relative imports end in `.js`. `npm run typecheck && npm run lint && npm run build && npm test` must pass.
- **Commits: never include co-authoring/attribution trailers.**
- The real Zotero API key is in the git-ignored `.env` (`ZOTERO_API_KEY`) — never commit it.
- Use the superpowers skills: **writing-plans** → implement (TDD) → **verification-before-completion**. Add this as milestone **M10** with a plan doc under `docs/superpowers/plans/`. Tag `v0.9.0` when done (reserve `v1.0.0` for the npm publish).
- Verify the real flow end-to-end before claiming done: deploy (or tunnel with a stable host), add the connector in claude.ai, complete the OAuth consent, and confirm tools list + a read call work.
