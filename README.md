<div align="center">

# ⚡ Zoteus

### The everything **Zotero MCP server** — your research library, fully wired into Claude.

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents (Claude Code, Claude Desktop, and any MCP client) complete, **safe** access to your [Zotero](https://www.zotero.org) library: search, read, write, cite, import-by-DOI, semantic search, and a scholarly-context graph — local-first and privacy-preserving.

[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-active%20development-orange.svg)](#-status--roadmap)
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

> Zoteus is in active development. Install instructions below are the target UX and will work as milestones land — see the [roadmap](#-status--roadmap).

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

The complete design lives in [`docs/superpowers/specs/2026-05-29-zoteus-design.md`](./docs/superpowers/specs/2026-05-29-zoteus-design.md). Per-topic guides (architecture, tool reference, resources, prompts, citation pipeline, semantic search, scholarly context, code-execution, security) land under [`docs/`](./docs) as features ship.

## 🗺️ Status & roadmap

Active development. Milestones:

- [x] **0** Scaffold + CI
- [x] **1** Zotero API clients (cloud + local) + capability probe
- [x] **2** MCP core + read tools + resources (stdio)
- [ ] **3** Safe writes
- [ ] **4** Files / full-text / sync / groups / export
- [ ] **5** Citation pipeline (add-by-identifier + CSL formatting)
- [ ] **6** Hybrid semantic search
- [ ] **7** Scholarly-context graph
- [ ] **8** Code-execution layer + Prompts
- [ ] **9** HTTP transport + DXT + MCP registry + docs polish

## 🤝 Contributing

Contributions are welcome! See [`CONTRIBUTING.md`](./CONTRIBUTING.md). This is an open-source project under the [MIT License](./LICENSE).

## 🙏 Acknowledgements

Built on the [Model Context Protocol](https://modelcontextprotocol.io), the [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics), [citeproc-js](https://citeproc-js.readthedocs.io), and the [Citation Style Language](https://citationstyles.org) project.
