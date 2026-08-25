# Configuration

Zoteus is configured via environment variables (see [`.env.example`](../.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (sync, group libraries, and writes when the desktop app is unavailable; optional otherwise). Create one at https://www.zotero.org/settings/keys |
| `ZOTEUS_LOCAL_API_KEY` | — | Optional pre-provisioned Zotero 10+ desktop local-API key for writes against the running app. When unset, Zoteus requests one via Zotero’s grant dialog on the first write (choose “Always Allow”). |
| `ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` | auto | Pin a library; otherwise resolved automatically from the key. |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop app (reads, and personal-library writes). `off` forces everything through the cloud. |
| `ZOTERO_LOCAL_PORT` | `23119` | Desktop local server port. |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Optional Zotero translation-server for `zotero_import`. Without it, DOI and arXiv ids still resolve via built-in fallbacks; ISBN/PMID/bibcode and URLs need the server. See [`resolver.md`](./resolver.md). |
| `ZOTEUS_EMBEDDINGS` | `local` | Semantic-search embeddings provider (`local` model, `openai`, `gemini`, or `off`). |
| `ZOTEUS_TRANSFORMERS_PATH` | — | Where to resolve `@huggingface/transformers` from when the install cannot see it itself (notably a `.mcpb` bundle). Point it at the directory `npm root -g` prints. See [`semantic-search.md`](./semantic-search.md). |
| `ZOTEUS_INDEX_FULLTEXT` | `false` | Also index the body text of item attachments (what Zotero extracted from each PDF), so semantic search matches claims inside a paper and not only its title and abstract. Opt-in because it is expensive: roughly 9× the passages, index size, and embedding time. Can be set per build with `zotero_index fulltext:true`. See [`semantic-search.md`](./semantic-search.md#full-text-indexing-opt-in). |
| `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` | `40000` | Cap on indexed full-text characters per item (~13 pages of dense text); `0` means no cap. The main dial for the cost above. |
| `ZOTEUS_SCHOLAR_PROVIDERS` | `openalex` | Comma list of scholarly-graph providers (`openalex`, `crossref`, `semanticscholar`). |
| `ZOTEUS_DATA_DIR` | OS data dir | Index + caches location. |
| `ZOTEUS_CONTACT_EMAIL` | — | Polite-pool contact for external scholarly APIs. |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose `zotero_delete_items` (permanent delete). Trash is always available. |
| `ZOTEUS_READ_ONLY` | `false` | Expose only non-mutating tools. Recommended for public/remote endpoints. |
| `ZOTEUS_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` (stderr only — stdout carries the JSON-RPC stream). |
| `ZOTEUS_UPDATE_CHECK` | `true` | Daily check of GitHub releases for a newer version; when one exists, `zotero_whoami` (and the stderr log) says so. Useful because manual installs such as the Claude desktop `.dxt` have no auto-update channel. The check is a single unauthenticated GET to the GitHub API, sends no user data, and caches the result for 24 h. Set `false` to disable. |
| `ZOTEUS_DIST` | — | Distribution-channel marker. The packaged desktop-extension manifest sets `mcpb` (older bundles set `dxt`) so the update notice tells users to download and reinstall the new bundle. Not usually set by hand. |

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

- **Desktop app** (`http://127.0.0.1:23119`, personal library `users/0`) — fast, key-free reads with full local PDFs and real saved-search execution. From Zotero 10 it serves **group libraries** it holds too, under `groups/<id>`; a group the app does not hold still reads from the cloud. It also takes **writes** for your personal library: local-API writes on Zotero 10+ (behind a key granted once in-app, or `ZOTEUS_LOCAL_API_KEY`), else the connector protocol. Preferred whenever the app is running. See [`writing.md`](./writing.md).
- **Cloud Web API v3** (`https://api.zotero.org`) — universal, and the fallback for writes; still required for sync, group-library writes, group libraries the desktop app does not hold, and personal-library writes with no desktop app.

At startup Zoteus probes both and logs the result, e.g.
`Capabilities: cloud=user 19552201, localApi=true, localGroups=2`
(`localGroups` counts the group libraries the desktop app is serving).

### Local API prerequisite

To use the fast, key-free desktop path, run Zotero 7 or newer and enable
**Settings → Advanced → "Allow other applications on this computer to communicate with Zotero."**
If the desktop app is not running or the toggle is off, Zoteus transparently falls back to the cloud Web API.
