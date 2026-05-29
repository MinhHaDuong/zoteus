# Configuration

Zoteus is configured via environment variables (see [`.env.example`](../.env.example)).

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (writes/sync/groups; optional for local-only reads). Create one at https://www.zotero.org/settings/keys |
| `ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` | auto | Pin a library; otherwise resolved automatically from the key. |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop local API for reads. |
| `ZOTERO_LOCAL_PORT` | `23119` | Desktop local server port. |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Add-by-identifier/URL (later milestone). |
| `ZOTEUS_EMBEDDINGS` | `local` | Semantic-search embeddings provider (later milestone). |
| `ZOTEUS_SCHOLAR_PROVIDERS` | `openalex` | Comma list of scholarly-graph providers (later milestone). |
| `ZOTEUS_DATA_DIR` | OS data dir | Index + caches location. |
| `ZOTEUS_CONTACT_EMAIL` | — | Polite-pool contact for external scholarly APIs. |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent delete (later milestone). |
| `ZOTEUS_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` (stderr only — stdout carries the JSON-RPC stream). |

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
