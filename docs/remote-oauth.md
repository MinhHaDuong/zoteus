# Remote OAuth — using Zoteus as a claude.ai (web) custom connector

claude.ai connects to remote MCP servers **from the cloud**, so a connector must be reachable at a **public HTTPS URL** and protected by **OAuth 2.1 + PKCE** (a static API key or `Authorization` header cannot be entered in the connector UI). Since **v0.9.0**, Zoteus can be that connector: it runs its own OAuth 2.1 authorization server in front of the Streamable HTTP `/mcp` endpoint.

## How it works (single-tenant gating)

Zotero's own API uses OAuth 1.0a, which can't be proxied to satisfy claude.ai's OAuth 2.1. So Zoteus acts as **its own OAuth 2.1 authorization server** and gates *who may connect* — it does not federate Zotero accounts:

- The deployed instance holds **one** operator `ZOTERO_API_KEY` (single tenant).
- claude.ai self-registers via **Dynamic Client Registration** (RFC 7591), runs the **authorization-code + PKCE (S256)** flow, and exchanges the code for a short-lived **opaque bearer token**.
- Issuance is gated by a single **operator passcode** (`ZOTEUS_OAUTH_PASSCODE`): during consent the browser shows a one-field passcode page; only a correct passcode mints an authorization code.
- `/mcp` then requires a valid bearer token (`requireBearerAuth`).

Standards served automatically by the MCP SDK auth helpers:

| Endpoint | Spec |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 (AS metadata) |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 (protected-resource metadata) |
| `/register` | RFC 7591 (Dynamic Client Registration) |
| `/authorize` → consent → `/token` | OAuth 2.1 auth-code + PKCE S256 |
| `/revoke` | RFC 7009 |

Discovery is driven by the `WWW-Authenticate: Bearer ..., resource_metadata="…"` header returned from an unauthenticated `/mcp` request, so claude.ai never has to guess paths.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | yes | The operator's Zotero key (the library every connected client uses). |
| `ZOTEUS_OAUTH_ENABLED` | yes | Set `true` to turn on the OAuth-protected remote. |
| `ZOTEUS_PUBLIC_URL` | yes | Public HTTPS origin claude.ai reaches, e.g. `https://zoteus.example.com` (no trailing slash). Becomes the OAuth issuer; **must be HTTPS** in production. |
| `ZOTEUS_OAUTH_PASSCODE` | yes | Consent passcode, **≥ 12 chars**. Generate with `openssl rand -base64 24`. |
| `ZOTEUS_READ_ONLY` | recommended | `true` exposes only non-mutating tools — strongly recommended for a public connector. |
| `ZOTEUS_OAUTH_ACCESS_TTL` | no | Access-token lifetime in seconds (default `3600`). |
| `ZOTEUS_OAUTH_REFRESH_TTL` | no | Refresh-token lifetime in seconds (default `2592000`, 30 days). |
| `ZOTEUS_ALLOWED_HOSTS` | no | Comma-separated extra `Host` values accepted by DNS-rebinding protection, merged with the `ZOTEUS_PUBLIC_URL` host. Use only if your proxy rewrites `Host` (see below). |

When OAuth is enabled, `zoteus --http` binds `0.0.0.0` (so a reverse proxy/tunnel can reach it) and enables DNS-rebinding protection with `allowedHosts = [<public host>, …ZOTEUS_ALLOWED_HOSTS]`.

> **Safety guard:** without OAuth, Zoteus refuses to bind a non-loopback host (it would be an open, unauthenticated relay to your library). Override only for a deliberate trusted-network setup with `ZOTEUS_ALLOW_INSECURE_HTTP=true`.

## Run it

```bash
ZOTERO_API_KEY=zzz \
ZOTEUS_OAUTH_ENABLED=true \
ZOTEUS_PUBLIC_URL=https://zoteus.example.com \
ZOTEUS_OAUTH_PASSCODE="$(openssl rand -base64 24)" \
ZOTEUS_READ_ONLY=true \
node dist/index.js --http --port 3939 --host 0.0.0.0
```

Or with Docker (see [`Dockerfile`](../Dockerfile)):

```bash
docker build -t zoteus:0.9.0 .
docker run -p 3939:3939 \
  -e ZOTERO_API_KEY=zzz \
  -e ZOTEUS_OAUTH_ENABLED=true \
  -e ZOTEUS_PUBLIC_URL=https://zoteus.example.com \
  -e ZOTEUS_OAUTH_PASSCODE="$(openssl rand -base64 24)" \
  -e ZOTEUS_READ_ONLY=true \
  zoteus:0.9.0
```

## Put it behind HTTPS

TLS is required. Any of these works; the key requirement is **the proxy must forward the public `Host` header verbatim** (DNS-rebinding protection does an exact `Host` match, including port):

- **VPS + Caddy** — `zoteus.example.com { reverse_proxy 127.0.0.1:3939 }` (Caddy auto-provisions TLS and preserves `Host`).
- **Cloudflare named tunnel** — `cloudflared tunnel run` mapped to a stable hostname (`https://zoteus.example.com`). Use a *named* tunnel so the hostname is stable; a quick tunnel's random hostname changes each run and won't match `ZOTEUS_PUBLIC_URL`.
- **Fly.io / Render / Railway** — deploy the Docker image; set the env vars above; set `ZOTEUS_PUBLIC_URL` to the platform-assigned HTTPS hostname. These terminate TLS and forward the public `Host`.

If your proxy rewrites `Host` to an internal value (causing every `/mcp` request to 403), add the forwarded value to `ZOTEUS_ALLOWED_HOSTS`.

## Connect from claude.ai

1. **Settings → Connectors → Add custom connector**.
2. URL: `https://<your-host>/mcp`. (No client id/secret needed — claude.ai self-registers via DCR.)
3. Click **Connect**. claude.ai opens the Zoteus consent page.
4. Enter your `ZOTEUS_OAUTH_PASSCODE` and authorize.
5. The tool list loads; try a read (e.g. `zotero_whoami` or `zotero_search_items`).

## Security notes & v1 limitations

- **The passcode is the trust boundary.** Use a high-entropy value and rotate it (restart with a new `ZOTEUS_OAUTH_PASSCODE`). `/consent` is rate-limited and locks a pending authorization after repeated wrong attempts.
- **Single tenant.** Every connected client acts as the one operator `ZOTERO_API_KEY`. Per-user Zotero accounts (multi-tenant) are a future milestone (M11).
- **In-memory state.** Registered clients and tokens live in memory only — they do not survive a restart and are not shared across replicas. Run a single instance. (After a restart, claude.ai transparently re-registers via DCR and re-runs consent.)
- **Per-session transports.** Each MCP session gets its own Streamable HTTP transport (keyed by `Mcp-Session-Id`), sharing one Zotero context — so multiple/reconnecting claude.ai sessions are isolated and do not collide.
- **Dynamic Client Registration.** Claude registers a fresh public client per connection; Zoteus caps the in-memory client store (FIFO) and sweeps expired state. For very high-traffic use, a Client ID Metadata Document (CIMD) flow would avoid per-connection registrations (future enhancement).
- **Token lifetime.** Refresh tokens are rotated on each use (the old one is invalidated in the same response); access tokens remain valid until their TTL even after rotation. Shorten `ZOTEUS_OAUTH_ACCESS_TTL` for tighter revocation, or use `/revoke`.
- **Proxy must forward `Host`.** DNS-rebinding protection matches the `Host` header exactly; your TLS proxy/tunnel must forward the public host verbatim (add extras via `ZOTEUS_ALLOWED_HOSTS` if not).
- Prefer `ZOTEUS_READ_ONLY=true` and keep `ZOTEUS_ALLOW_DELETE=false` for public connectors.
