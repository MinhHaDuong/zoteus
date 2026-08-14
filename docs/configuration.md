# Configuration

Zoteus is configured via environment variables (see [`.env.example`](../.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (writes/sync/groups; optional for local-only reads). Create one at https://www.zotero.org/settings/keys |
| `ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` | auto | Pin a library; otherwise resolved automatically from the key. |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop local API for reads. |
| `ZOTERO_LOCAL_PORT` | `23119` | Desktop local server port. |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Optional Zotero translation-server for `zotero_import`. Without it, DOI and arXiv ids still resolve via built-in fallbacks; ISBN/PMID/bibcode and URLs need the server. See [`resolver.md`](./resolver.md). |
| `ZOTEUS_EMBEDDINGS` | `local` | Semantic-search embeddings provider (`local` model, `openai`, `gemini`, or `off`). |
| `ZOTEUS_SCHOLAR_PROVIDERS` | `openalex` | Comma list of scholarly-graph providers (`openalex`, `crossref`, `semanticscholar`). |
| `ZOTEUS_DATA_DIR` | OS data dir | Index + caches location. |
| `ZOTEUS_CONTACT_EMAIL` | — | Polite-pool contact for external scholarly APIs. |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose `zotero_delete_items` (permanent delete). Trash is always available. |
| `ZOTEUS_READ_ONLY` | `false` | Expose only non-mutating tools. Recommended for public/remote endpoints. |
| `ZOTEUS_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` (stderr only — stdout carries the JSON-RPC stream). |

## Remote OAuth (claude.ai web connector)

Turn the Streamable HTTP `/mcp` endpoint into an OAuth 2.1 + PKCE protected resource so it can be added as a claude.ai custom connector. See [`remote-oauth.md`](./remote-oauth.md) for the full walkthrough.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_OAUTH_ENABLED` | `false` | Enable the built-in OAuth 2.1 authorization server + bearer-auth on `/mcp`. |
| `ZOTEUS_PUBLIC_URL` | — | Public HTTPS origin claude.ai reaches (OAuth issuer), e.g. `https://zoteus.example.com`. Required when enabled; must be HTTPS in production. |
| `ZOTEUS_OAUTH_PASSCODE` | — | Operator passcode gating consent (≥ 12 chars; `openssl rand -base64 24`). Required when enabled. |
| `ZOTEUS_OAUTH_ACCESS_TTL` | `3600` | Access-token lifetime (seconds). |
| `ZOTEUS_OAUTH_REFRESH_TTL` | `2592000` | Refresh-token lifetime (seconds). |
| `ZOTEUS_ALLOWED_HOSTS` | — | Comma-separated extra `Host` values for DNS-rebinding protection (merged with the public host); use if a proxy rewrites `Host`. |
| `ZOTEUS_ALLOW_INSECURE_HTTP` | `false` | Override the guard that forbids binding a non-loopback host without OAuth. Trusted networks only. |
| `ZOTEUS_OAUTH_MODE` | `passcode` | `passcode` (single operator key) or `zotero` (per-user Zotero login, multi-tenant). |
| `ZOTERO_OAUTH_CLIENT_KEY` / `ZOTERO_OAUTH_CLIENT_SECRET` | — | Zotero app credentials (https://www.zotero.org/oauth/apps). Required when `mode=zotero`. |
| `ZOTEUS_OAUTH_STORE` | `memory` | `memory` or `file` (persist clients/tokens/per-user keys under the data dir, encrypted at rest). |
| `ZOTEUS_OAUTH_TOKEN_SECRET` | — | AES-256-GCM key material encrypting stored Zotero keys at rest. Required when `store=file` (`openssl rand -base64 32`). |

When OAuth is enabled, `--http` binds `0.0.0.0` and enables DNS-rebinding protection (`allowedHosts` = public host + `ZOTEUS_ALLOWED_HOSTS`). Put TLS (Caddy / cloudflared / Fly) in front; the proxy must forward the public `Host` header verbatim.

## Connector directory / CIMD

Client ID Metadata Document support — resolve a URL `client_id` to a registered client without per-connection Dynamic Client Registration. Required only to list the hosted connector in the claude.ai directory; off by default, so OSS self-host is unaffected. See [`distribution.md`](./distribution.md) §7.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_CIMD_ENABLED` | `false` | Resolve a URL `client_id` via its metadata document and advertise `client_id_metadata_document_supported`. DCR keeps working in parallel. |
| `ZOTEUS_CIMD_CACHE_TTL_SEC` | `3600` | How long a fetched CIMD document is cached (seconds). |
| `ZOTEUS_CIMD_MAX_BYTES` | `16384` | Max bytes accepted for a CIMD document (enforced while streaming). |
| `ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES` | `https` | Comma-separated `redirect_uri` schemes permitted in a CIMD document. |
| `ZOTEUS_CIMD_ALLOWED_HOSTS` | — | SSRF guard: comma-separated host allowlist for `client_id` (exact or `.suffix`). Empty = any **public** host (private/loopback/link-local/reserved IPs are always rejected). Set to the directory host (e.g. `claude.ai`) for a directory connector. |

## Ops / production

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_LOG_FORMAT` | `text` | `text` (human-readable) or `json` (structured, for log aggregators). Never logs tokens, keys, or the passcode. |
| `ZOTEUS_METRICS_ENABLED` | `false` | Expose `/metrics` in Prometheus text format (no auth). Enable only behind a proxy/WAF in production. |
| `ZOTEUS_READYZ_CHECK_ZOTERO` | `true` | Whether `/readyz` pings the Zotero API (HEAD) to report upstream reachability. |
| `ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC` | `60` | Sliding window length (seconds) for the per-IP rate limiter on `/mcp`. |
| `ZOTEUS_MCP_RATE_LIMIT_MAX` | `120` | Max requests per IP per window on `/mcp`. Set to `0` to disable. |

## Optional dependencies

**Exact full-text page locators** — `zotero_get_fulltext precise_pages:true` re-extracts the PDF for exact page numbers using `pdfjs-dist`, which is declared as an `optionalDependency`. Without it, the tool returns approximate (proportional) page numbers with a notice; no error is thrown:

```bash
npm i pdfjs-dist
```

**Better BibTeX export** — `zotero_export format:"better-biblatex"` calls the Better BibTeX plugin running in your local desktop Zotero instance. It is desktop-local only: when desktop Zotero or the plugin is unavailable (e.g. the hosted connector), the tool automatically degrades to Zotero's built-in stock `biblatex` translator. See [`grounding.md`](./grounding.md) for details.

## Library backends

Zoteus uses both Zotero backends and chooses per request:

- **Desktop local API** (`http://127.0.0.1:23119/api`, library `users/0`) — fast, key-free, full local PDFs, and it can execute saved searches. **Read-only.** Preferred for reads of your personal library when available.
- **Cloud Web API v3** (`https://api.zotero.org`) — universal, and the path for writes, sync, and group libraries.

At startup Zoteus probes both and logs the result, e.g.
`Capabilities: cloud=user 19552201, localApi=true`.

### Local API prerequisite

To use the fast, key-free local read path, run Zotero 7 or newer and enable
**Settings → Advanced → "Allow other applications on this computer to communicate with Zotero."**
If the desktop app is not running or the toggle is off, Zoteus transparently falls back to the cloud Web API.
