# Handoff brief — M13: Production deployment, persistence & operational hardening

**Status going in (expected):** This milestone runs **after M11** (multi-tenant per-user Zotero OAuth + persistent/encrypted token store — `NEXT-AGENT-m11-multitenant.md`) and **M12** (read-path grounding/full-text/writes — `NEXT-AGENT-m12-read-grounding.md`) have landed. As of writing, M10 (OAuth 2.1 remote) shipped at **v0.9.1** and the connector has only ever run on an **ephemeral ngrok tunnel on a laptop**, with **in-memory state** — so every server restart drops all OAuth sessions and forces every user to re-authenticate, and the connector URL is not stable. That is the gap M13 closes.

**Goal:** Stand up Zoteus as a **real, always-on, hardened hosted service** at a **stable HTTPS domain**, with **persistent state that survives restarts/redeploys**, observability, secrets management, graceful lifecycle, and a repeatable deploy. The payoff: a claude.ai (or Claude Code) connection, once authorized, **keeps working across restarts and redeploys** — no re-auth, no changing URL.

## Why this is the natural next step
- The connector URL must be **stable**: claude.ai stores the connector URL; an ngrok-free hostname (or any ephemeral tunnel) changes and breaks it. A fixed domain is required for a durable connector.
- M11 makes state **persistable**; M13 makes it **actually persisted in production** (volume/managed store) and **operable** (health, logs, metrics, backups, rotation).
- You cannot responsibly submit to a connector directory or invite real users (M14) without this.

## Deliverables
1. **Deployment target + IaC.** Pick one and commit its config (don't leave it manual):
   - **Recommended: Fly.io** — always-on Node service, attachable **volume** for the file/SQLite store, free TLS, simple secrets, single-region single-instance fits the single-tenant store model. Deliver a `fly.toml` + volume + `flyctl` notes.
   - Alternatives to document: Render/Railway (managed, easy), or **VPS + Caddy** (full control, auto-TLS, `reverse_proxy` preserving `Host`), or a **Cloudflare *named* tunnel** to a small always-on box. All must forward the public `Host` header verbatim (DNS-rebinding does exact-match; see M10).
2. **Stable domain + TLS.** A real domain (e.g. `zoteus.<you>.dev`) terminated by the platform/proxy. Set `ZOTEUS_PUBLIC_URL` to it; `ZOTEUS_ALLOWED_HOSTS` only if the proxy rewrites `Host`.
3. **Persistent state in prod.** Use M11's persistent store (`ZOTEUS_OAUTH_STORE=file` + `ZOTEUS_OAUTH_TOKEN_SECRET` for at-rest encryption) on a mounted volume, OR add a managed-store adapter (SQLite-on-volume for single instance; Redis/Postgres if you ever run >1 replica — the in-memory/file maps are **not** shared across replicas, so document single-instance unless a shared store is added). Verify tokens + per-user Zotero keys survive a redeploy.
4. **Health & readiness endpoints.** Add `GET /healthz` (liveness, no auth, no secrets) and `GET /readyz` (checks store + Zotero API reachability) to the HTTP server. Keep them outside the `/mcp` bearer guard. Wire to the platform's health checks.
5. **Observability.** Structured JSON request logging (method, path, status, latency, client id, session id — **never tokens/keys/passcode/API keys**); counters for token issuance, auth failures, tool calls, errors; optionally a `/metrics` endpoint or ship to the platform's metrics. Confirm the existing `src/lib/logger.ts` emits to stderr/structured and that nothing logs secrets.
6. **Graceful shutdown.** Handle `SIGTERM`/`SIGINT`: stop accepting new requests, close active Streamable HTTP transports, flush/close the store, exit 0. Important so redeploys don't drop in-flight tool calls or corrupt the store.
7. **Secrets management.** All secrets via platform secret store / env injection, **never baked into the image** (`.dockerignore` already excludes `.env`). Document the full secret set: `ZOTERO_API_KEY` (single-tenant) or `ZOTERO_OAUTH_CLIENT_KEY/SECRET` (multi-tenant), `ZOTEUS_OAUTH_PASSCODE` (passcode mode), `ZOTEUS_OAUTH_TOKEN_SECRET`, `ZOTEUS_PUBLIC_URL`.
8. **Abuse / rate-limit tuning for the open internet.** Review the SDK limiters (authorize/token/register) + the `/consent` limiter for production thresholds; consider a global per-IP limit and basic bot filtering at the proxy/WAF. Ensure `trust proxy` is set so limits key on the real client IP (already handled when OAuth is enabled).
9. **CI/CD deploy.** Extend `.github/workflows/ci.yml` (or add a deploy workflow) to build + deploy on tag/release (guarded by the green test gate). Keep deploy creds in GitHub secrets.
10. **Backups.** If using a volume-backed store, schedule snapshots/backup of the (encrypted) store; document restore.
11. **`docs/deployment.md` runbook.** End-to-end: provision, set secrets, deploy, set the domain, add the connector, rotate `ZOTEUS_OAUTH_PASSCODE`/`ZOTEUS_OAUTH_TOKEN_SECRET`, redeploy safely, read logs/metrics, scale considerations, and an incident checklist (revoke tokens, rotate the operator Zotero key).

## Implementation pointers
- HTTP server / health endpoints / graceful shutdown: `src/transports/http.ts` (post-M11 shape) and `src/index.ts` (process signal handling, top-level lifecycle).
- Store: whatever interface M11 introduced for clients/tokens/per-user keys — add the production adapter behind it; do not reach into the provider's maps directly.
- Logging: `src/lib/logger.ts`. Add a request-logging middleware in the Express app (skip on `/healthz`).
- Build/deploy: existing `Dockerfile` (multi-stage, already verified to build/boot) + `.dockerignore`; add `fly.toml`/platform config and the CI deploy job.
- Config: `src/config.ts` already has `ZOTEUS_OAUTH_STORE`/`ZOTEUS_OAUTH_TOKEN_SECRET`/mode — reuse; add any new ops env (e.g. `ZOTEUS_LOG_FORMAT=json`, health bind) consistently.

## Constraints / house style (match the repo)
- **TDD with Vitest** for the testable units (health/readyz handlers, graceful-shutdown drain, store-persistence round-trip, request-logger secret redaction). Keep `npm run typecheck && npm run lint && npm run build && npm test` green. (Deployment itself is verified by the live check below, not unit tests.)
- TypeScript **NodeNext ESM** — relative imports end in `.js`.
- **Commits: never include co-authoring/attribution trailers.**
- Secrets only in `.env` (git-ignored) locally and in the platform secret store in prod — never commit them.
- Use the superpowers skills: **writing-plans** → implement (TDD) → **verification-before-completion**; plan doc under `docs/superpowers/plans/`. Bump the **minor** version (coordinate with M11/M12 numbering); **reserve `v1.0.0` for the npm publish** (M14, below).
- **Verify end-to-end (the acceptance test):** deploy to the real platform + domain; add the connector in claude.ai; authorize; then **redeploy / restart the service** and confirm the **same** connection still works **without re-authenticating** (proves persistence) and that a tool read still returns data (proves the M12 read path survives prod). Capture logs showing no secret leakage.

## What comes after (M14 — for the brief after this one)
**Public distribution & directory listing:** `npm publish` (this is the long-reserved **`v1.0.0`**) + MCP registry update (`server.json`) + DXT refresh; and pursue the **claude.ai connector directory** — per Claude's auth docs, directory connectors use a single shared app via **CIMD (Client ID Metadata Document)** or **Anthropic-held credentials** (contact `mcp-review@anthropic.com`), not per-connection DCR. CIMD support was flagged as a future enhancement in the M10/M12 briefs and is the prerequisite for directory submission.
