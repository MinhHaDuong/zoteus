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
- **Built for agents.** ~24 consolidated, well-described tools (not 70 thin endpoint mirrors), `zotero_*`-namespaced, with structured outputs and a generated TypeScript tool tree for the [code-execution-with-MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern.

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

Runs on a trusted network or behind your own auth proxy (OAuth is on the roadmap). **Claude Desktop one-click:** build the [Desktop Extension](./dxt/manifest.json) (`dist/` + `dxt/manifest.json`) and double-click the `.dxt`.

**Claude.ai (web) — custom connector**

claude.ai connects to remote MCP servers from the cloud, so it needs a **public HTTPS URL** (not `localhost`) and, for secure access, **OAuth 2.1 + PKCE** ([docs](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). A static API key or `Authorization` header cannot be entered in the connector UI.

- **Status:** Zoteus serves the right transport (Streamable HTTP) but does **not yet implement OAuth**, so it is not a turn-key claude.ai connector. OAuth support is tracked on the roadmap.
- **Quick personal test (no OAuth):** expose the local server with a tunnel and paste the resulting URL into *Settings → Connectors → Add custom connector*:

  ```bash
  zoteus --http --host 127.0.0.1 --port 3939
  ngrok http 3939          # → https://<id>.ngrok-free.app  (use URL + "/mcp")
  ```

  ⚠️ This endpoint is **unauthenticated** — anyone with the URL can use your library (including writes). Only do this briefly, keep `ZOTEUS_ALLOW_DELETE=false`, prefer `ZOTEUS_READ_ONLY=true` if you only need reads, and stop the tunnel when done.
- **Proper deployment:** host behind HTTPS with OAuth (roadmap) — see [`docs/configuration.md`](./docs/configuration.md).

## ⚙️ Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (writes/sync/groups; optional for local-only reads) |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop local API |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Add-by-identifier/URL (optional) |
| `ZOTEUS_EMBEDDINGS` | `local` | `local\|openai\|gemini\|off` for semantic search |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent deletion |

Full table in [`docs/configuration.md`](./docs/configuration.md).

## 📚 Documentation

- [Architecture](./docs/architecture.md) · [Configuration](./docs/configuration.md)
- [Writing (safe writes)](./docs/writing.md) · [Files, full-text & sync](./docs/files-and-sync.md)
- [Citations](./docs/citations.md) · [Semantic search](./docs/semantic-search.md) · [Scholarly context](./docs/scholar.md)
- [Prompts](./docs/prompts.md) · [Code execution with MCP](./docs/code-execution.md)
- Full design spec: [`docs/superpowers/specs/2026-05-29-zoteus-design.md`](./docs/superpowers/specs/2026-05-29-zoteus-design.md)

### Publishing (maintainers)

```bash
npm run build && npm publish --access public   # npm
# MCP registry: edit server.json, then `mcp-publisher login github && mcp-publisher publish`
```

## 🗺️ Status & roadmap

**Feature-complete** — all 10 milestones implemented, 24 tools, 7 prompts, ~120 tests, CI green. (`npm publish` to make it installable for everyone is the only remaining step.)

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

## 🤝 Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](./CONTRIBUTING.md). This is an open-source project under the [MIT License](./LICENSE).

## 🙏 Acknowledgements

Built on the [Model Context Protocol](https://modelcontextprotocol.io), the [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics), [citeproc-js](https://citeproc-js.readthedocs.io), and the [Citation Style Language](https://citationstyles.org) project.
