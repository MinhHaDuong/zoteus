<div align="center">

# ⚡ Zoteus

### The everything **Zotero MCP server** — your research library, fully wired into Claude.

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents (Claude Code, Claude Desktop, and any MCP client) complete, **safe** access to your [Zotero](https://www.zotero.org) library: search, read, write, cite, import-by-DOI, semantic search, and a scholarly-context graph — local-first and privacy-preserving.

[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-feature--complete-brightgreen.svg)](#-status--roadmap)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-6E56CF.svg)](https://modelcontextprotocol.io)
[![Made for Zotero](https://img.shields.io/badge/Zotero-Web%20API%20v3%20%2B%20Local%20API-CC2936.svg)](https://www.zotero.org/support/dev/web_api/v3/basics)

</div>

> **Keywords:** Zotero MCP server · Zotero Model Context Protocol · Zotero for Claude · Zotero AI · reference manager MCP · citations MCP · bibliography · Zotero Web API v3 · Zotero local API.

---

## Why Zoteus?

There are several Zotero MCP servers. Zoteus is the one that combines **everything** — and adds the parts everyone else skips.

| Capability | Most existing servers | **Zoteus** |
|---|:---:|:---:|
| Complete Web API v3 coverage (items, collections, tags, search, files, sync, groups, schema) | partial | ✅ |
| **Local-first** reads + full PDFs (no API key needed) | some | ✅ auto-detected |
| **Safe transactional writes** (versioned, 412-retry, reversible trash, gated delete) | rare / hacky | ✅ |
| **Citation pipeline** — add by DOI/ISBN/PMID/arXiv + format in ~2,800 CSL styles | export-only | ✅ |
| **Hybrid semantic search** — BM25 + *local* embeddings, page-cited | rare, often cloud-only | ✅ local-default |
| **Scholarly-context graph** — OpenAlex / Crossref / Semantic Scholar | almost none | ✅ |
| **MCP Resources + Prompts** (not just tools) | nobody | ✅ |
| **Code-execution pattern** ([Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)) | nobody | ✅ |
| Tests, CI, releases, MCP Inspector | few | ✅ |

## ✨ Highlights

- **Local + cloud, automatically.** Zoteus probes your running Zotero desktop app and uses its fast, key-free [local API](https://www.zotero.org/support/dev/web_api/v3/basics) for reads (full PDFs, real saved-search results), falling back to the cloud [Web API v3](https://www.zotero.org/support/dev/web_api/v3/basics) for writes, sync, and group libraries.
- **Safe by default.** Reversible trash is the default; permanent deletion is opt-in and confirmation-gated. Optimistic-locking conflicts, rate limits, 50-item batch chunking, and partial-success parsing are handled *in the client* so the model never has to.
- **Cite anything.** Add a paper by DOI/ISBN/PMID/arXiv and format a bibliography in any CSL style — no account required for the import → format path.
- **Find anything.** Hybrid keyword + semantic search across metadata, full text, and annotations, with results that cite the page.
- **Ground claims with page locators.** `zotero_get_fulltext` retrieves relevant passages from a PDF with character offsets, nearest section heading, and a page number (approximate by default; exact with the optional `pdfjs-dist` dependency).
- **Audit your tag vocabulary.** `zotero_tag_audit` checks all library tags against a controlled vocabulary with required tiers, flags off-taxonomy and auto-applied tags, and reports items missing a required-tier tag — optionally scoped per collection.
- **Better BibTeX export.** `zotero_export` now supports `format:"better-biblatex"` (applies your BBT citation-key and export options; requires desktop Zotero + the Better BibTeX plugin; degrades to built-in `biblatex` otherwise).
- **Built for agents.** ~28 consolidated, well-described tools (not 70 thin endpoint mirrors), `zotero_*`-namespaced, with structured outputs and a generated TypeScript tool tree for the [code-execution-with-MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern.

## 🚀 Quickstart

> Zoteus is feature-complete. The `npx`/registry commands below work once it's published to npm; until then, clone the repo and run `npm install && npm run build`, then point your client at `node /path/to/zoteus/dist/index.js`.

**Claude Code**

```bash
claude mcp add --transport stdio zoteus -- npx -y @oscardvs/zoteus
# add your cloud key for writes/sync/groups:
claude mcp add --transport stdio zoteus -e ZOTERO_API_KEY=xxxxx -- npx -y @oscardvs/zoteus
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "zoteus": {
      "command": "npx",
      "args": ["-y", "@oscardvs/zoteus"],
      "env": { "ZOTERO_API_KEY": "xxxxx" }
    }
  }
}
```

Get a Zotero API key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). For local-API reads, enable **Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"** in the desktop app.

**Remote / team (Streamable HTTP)**

```bash
zoteus --http --port 3939        # serves MCP at http://127.0.0.1:3939/mcp
```

Runs on loopback for a trusted network or behind your own auth proxy. For a public, authenticated remote (claude.ai web), enable OAuth — see below. **Claude Desktop one-click:** build the [Desktop Extension](./dxt/manifest.json) (`dist/` + `dxt/manifest.json`) and double-click the `.dxt`.

**Claude.ai (web) — custom connector**

claude.ai connects to remote MCP servers from the cloud, so it needs a **public HTTPS URL** (not `localhost`) and **OAuth 2.1 + PKCE** ([docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). Since **v0.9.0** Zoteus ships its own OAuth 2.1 authorization server in front of `/mcp`, so it is a turn-key connector — claude.ai self-registers (Dynamic Client Registration) and runs the auth-code + PKCE flow; a one-step **passcode** gates the consent.

**Single- or multi-tenant.** The default (`ZOTEUS_OAUTH_MODE=passcode`) shares one operator Zotero key behind a passcode. For a multi-user hosted connector, set `ZOTEUS_OAUTH_MODE=zotero` so each user logs into **their own Zotero account** — the issued token carries that user's per-user key (encrypted at rest with `ZOTEUS_OAUTH_STORE=file` + `ZOTEUS_OAUTH_TOKEN_SECRET`), and every call runs against their own library. See [`docs/remote-oauth.md`](./docs/remote-oauth.md).

```bash
ZOTERO_API_KEY=zzz \
ZOTEUS_OAUTH_ENABLED=true \
ZOTEUS_PUBLIC_URL=https://zoteus.example.com \
ZOTEUS_OAUTH_PASSCODE="$(openssl rand -base64 24)" \
ZOTEUS_READ_ONLY=true \
zoteus --http --port 3939 --host 0.0.0.0      # put HTTPS (Caddy / cloudflared / Fly) in front
```

Then in claude.ai: **Settings → Connectors → Add custom connector** → URL `https://<host>/mcp` → **Connect** → enter the passcode → the tools appear. A [`Dockerfile`](./Dockerfile) is included for deployment.

The same OAuth remote also works from the **Claude Code CLI** — `claude mcp add --transport http zoteus https://<host>/mcp`, then `/mcp` → **Authenticate** (enter the passcode in the browser).

Full walkthrough (deploy options, TLS/tunnel, Claude Code remote, security notes): [`docs/remote-oauth.md`](./docs/remote-oauth.md).

> Without OAuth, `--http` stays on `127.0.0.1` and Zoteus **refuses** to bind a public interface (an unauthenticated MCP endpoint would expose your library). For a brief local-only test you can still tunnel the loopback port, but prefer the OAuth path above. Keep `ZOTEUS_ALLOW_DELETE=false` and prefer `ZOTEUS_READ_ONLY=true`.

## ⚙️ Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (writes/sync/groups; optional for local-only reads) |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop local API |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Add-by-identifier/URL (optional) |
| `ZOTEUS_EMBEDDINGS` | `local` | `local\|openai\|gemini\|off` for semantic search |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent deletion |
| `ZOTEUS_OAUTH_ENABLED` | `false` | Turn `/mcp` into an OAuth 2.1 + PKCE protected remote (claude.ai) |
| `ZOTEUS_PUBLIC_URL` | — | Public HTTPS origin (OAuth issuer); required when OAuth is enabled |
| `ZOTEUS_OAUTH_PASSCODE` | — | Consent passcode (≥ 12 chars); required when OAuth is enabled |

Full table in [`docs/configuration.md`](./docs/configuration.md); remote-OAuth walkthrough in [`docs/remote-oauth.md`](./docs/remote-oauth.md).

## Deploy (hosted connector)

Run Zoteus as an always-on connector at a stable HTTPS domain with persistent, encrypted
state. See **[docs/deployment.md](docs/deployment.md)** for the end-to-end runbook
(free-tier VM + Caddy, secrets, health checks, backups, rotation, and the connector test).

## 📚 Documentation

- [Architecture](./docs/architecture.md) · [Configuration](./docs/configuration.md)
- [Writing (safe writes)](./docs/writing.md) · [Files, full-text & sync](./docs/files-and-sync.md)
- [Citations](./docs/citations.md) · [Semantic search](./docs/semantic-search.md) · [Scholarly context](./docs/scholar.md)
- [Full-text grounding, tag audit, BBT export](./docs/grounding.md) (M12)
- [Prompts](./docs/prompts.md) · [Code execution with MCP](./docs/code-execution.md)
- Full design spec: [`docs/superpowers/specs/2026-05-29-zoteus-design.md`](./docs/superpowers/specs/2026-05-29-zoteus-design.md)

### Publishing (maintainers)

```bash
npm run build && npm publish --access public   # npm
# MCP registry: edit server.json, then `mcp-publisher login github && mcp-publisher publish`
```

## 🗺️ Status & roadmap

**Feature-complete + production-hardened.** 28 tools, 7 prompts, ~235 tests, CI green. The remaining step to make it installable for everyone is the public `npm publish` (the long-reserved `v1.0.0`).

New in **v0.12.0 (M13 — production deploy & ops):** `/healthz` + `/readyz` probes, graceful `SIGTERM`/`SIGINT` shutdown (drain sessions → flush the encrypted store + indexes), structured **secret-redacted** JSON logging, request logging + `/metrics` counters, per-IP `/mcp` rate limiting, a volume-backed persistent store, backups, a CI image publish, and an end-to-end [deploy runbook](./docs/deployment.md).

New in **v0.11.0 (M12):** `zotero_get_fulltext` (passage retrieval with page locators), `zotero_tag_audit` (controlled-vocabulary hygiene), `zotero_list_tags`, `zotero_list_collections`, `zotero_export format:"better-biblatex"` (local BBT with degrade), `zotero_update_item dry_run` (before→after diff), and query-centred search snippets.

- [x] **0** Scaffold + CI
- [x] **1** Zotero API clients (cloud + local) + capability probe
- [x] **2** MCP core + read tools + resources (stdio)
- [x] **3** Safe writes
- [x] **4** Files / full-text / sync / groups / export
- [x] **5** Citation pipeline (add-by-identifier + CSL formatting)
- [x] **6** Hybrid semantic search
- [x] **7** Scholarly-context graph
- [x] **8** Code-execution layer + Prompts
- [x] **9** HTTP transport + DXT + MCP registry + docs polish
- [x] **10** OAuth 2.1 + PKCE + hosted remote (claude.ai connector)
- [x] **11** Read+grounding path — full-text passages, tag audit, BBT export, dry-run diff
- [x] **＋** Multi-tenant — per-user Zotero login for hosted connectors (`ZOTEUS_OAUTH_MODE=zotero`), encrypted at-rest token/key store
- [x] **＋** Production deploy & ops — health/readiness, graceful shutdown, structured logging, metrics, `/mcp` rate limiting, backups, CI image publish (v0.12.0)
- [ ] **next** Public distribution — `npm publish` (`v1.0.0`) + MCP registry + DXT refresh

## 🤝 Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](./CONTRIBUTING.md). This is an open-source project under the [MIT License](./LICENSE).

## 🙏 Acknowledgements

Built on the [Model Context Protocol](https://modelcontextprotocol.io), the [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics), [citeproc-js](https://citeproc-js.readthedocs.io), and the [Citation Style Language](https://citationstyles.org) project.
