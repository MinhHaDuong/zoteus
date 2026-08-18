<div align="center">

# ⚡ Zoteus

### Your Zotero library, inside every AI conversation — with real citations, not hallucinations.

The **everything Zotero MCP server**. Give Claude, Cursor, and any [MCP](https://modelcontextprotocol.io) client complete, **safe** access to your [Zotero](https://www.zotero.org) library — search papers, add by DOI, format bibliographies in ~2,800 styles, run semantic search over your library's metadata and abstracts, pull exact passages from your PDFs, and ground every answer in a source you actually own. **Local-first. Private. One command.**

[![npm](https://img.shields.io/npm/v/@oscardvs/zoteus.svg?color=2ea44f)](https://www.npmjs.com/package/@oscardvs/zoteus)
[![npm downloads](https://img.shields.io/npm/dm/@oscardvs/zoteus.svg)](https://www.npmjs.com/package/@oscardvs/zoteus)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-6E56CF.svg)](https://modelcontextprotocol.io)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-listed-6E56CF.svg)](https://registry.modelcontextprotocol.io)

<!-- TODO(launch): swap to the demo GIF once recorded → ![Zoteus demo — ask Claude to find papers in your Zotero library and cite them](https://zoteus.com/demo.gif) -->
[![Zoteus — your Zotero library, inside every AI conversation](https://zoteus.com/og/home/image.png)](https://zoteus.com)

```bash
npx -y @oscardvs/zoteus
```

</div>

---

## Install in 30 seconds

For normal use there is **nothing to download or unzip from GitHub** — your AI app fetches Zoteus automatically when it first runs. New to this? Follow the no-code getting-started guide → [`docs/getting-started.md`](./docs/getting-started.md)

| Client | Command |
|---|---|
| **Claude Desktop (one-click)** | download `zoteus.mcpb` from the [latest release](https://github.com/oscardvs/zoteus/releases/latest) → double-click |
| **Claude Code** | `claude mcp add --transport stdio zoteus -- npx -y @oscardvs/zoteus` |
| **Cursor / VS Code / Claude Desktop / Codex / Zed…** | `npx add-mcp @oscardvs/zoteus` |
| **claude.ai (web)** | Add custom connector → your hosted URL (OAuth) |

Add your cloud key for sync, group libraries, and writes without the desktop app (optional — reads *and* personal-library writes work key-free against a running Zotero):

```bash
claude mcp add --transport stdio zoteus -e ZOTERO_API_KEY=xxxxx -- npx -y @oscardvs/zoteus
```

> Get a key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). For key-free local reads and writes, enable **Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"** in the desktop app.

---

## Why Zoteus?

There are several Zotero MCP servers now. Zoteus is the one that does **everything** — and adds the parts everyone else skips. The difference that matters: **Zoteus treats your library as the source of truth, not a search index.** When you ask Claude to "draft a methods paragraph citing the five most relevant papers in my collection," it runs that against *your verified, already-curated references* — no invented citations, no Python stack, nothing leaves your machine.

| | **Zoteus** | Other Zotero MCP servers | Web AI (Elicit/SciSpace) |
|---|:---:|:---:|:---:|
| Operates on **your own** library | ✅ | ✅ (varies) | ❌ (web-wide) |
| Complete Web API v3 **+** desktop local API | ✅ | partial | n/a |
| **Safe** transactional writes (reversible, gated) | ✅ | rare | ❌ |
| CSL bibliographies (~2,800 styles) | ✅ | rare | ❌ |
| Local hybrid semantic search + full-text PDF retrieval | ✅ | some (cloud) | varies |
| No Python — TypeScript, one `npx` | ✅ | varies | n/a |
| MCP Resources + Prompts + code-execution | ✅ | ❌ | n/a |
| Local-first / private · Open-source (MIT) | ✅ | varies | ❌ |

## What you can do

- **Find anything in your own work.** *"Find papers in my library that argue against X"* — hybrid keyword + semantic search over your library's titles, abstracts, creators, and tags, plus full-text keyword search inside your PDFs and notes, with the matching passage returned **with the page number**.
- **Cite without hallucinating.** Zoteus surfaces *your* Zotero citation data and formats it with [citeproc-js](https://citeproc-js.readthedocs.io) in any [CSL](https://citationstyles.org) style — it never invents a reference.
- **Add a paper by identifier.** Drop in a DOI or arXiv id and Zoteus fetches the metadata and files it — works out of the box via built-in resolvers, no extra services needed (a Zotero translation-server extends this to ISBN/PMID/URLs; see [`docs/resolver.md`](./docs/resolver.md)).
- **Write back, safely.** Create items, edit, tag, organize — versioned with optimistic-locking retries, reversible trash by default, permanent delete opt-in and confirmation-gated.
- **Write straight to the desktop app.** Personal-library writes go to your running Zotero — **no cloud API key needed**. On Zotero 9+ that's the local API behind a key you grant once ("Always Allow"); on older builds it's the same connector protocol the browser extensions use. The cloud Web API is the fallback for group libraries and for when the app isn't running.
- **Annotate PDFs and attach files.** `zotero_annotate` adds real highlights, underlines, and notes — the same objects the Zotero PDF reader creates, positioned on the page — and `zotero_attach_file` stores a local file or a URL as an attachment under any item.
- **Ground claims in the PDF.** `zotero_get_fulltext` returns the relevant passage with character offsets, nearest heading, and a page locator — extracting the text on the fly when Zotero hasn't indexed the PDF.
- **Follow the scholarship.** A scholarly-context graph over OpenAlex / Crossref / Semantic Scholar.
- **Built for agents.** 30 consolidated, well-described tools (not 70 thin endpoint mirrors), `zotero_*`-namespaced, structured outputs, and a generated tool tree for the [code-execution-with-MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern.

## How it works

1. **Install** — one `npx` command (or the one-click `.mcpb`).
2. **Connect** — just run the desktop app for key-free local access, or paste your Zotero API key.
3. **Ask** — your AI can now search, cite, add, and organize your library.

Zoteus auto-detects your running Zotero desktop app and talks to it directly: its fast, key-free **local API** for reads (full PDFs, real saved-search results), and the desktop app itself for personal-library writes (imports, annotations, attachments, trash). The cloud **Web API v3** is the fallback — and stays required for sync, group libraries, and writes when the app isn't running. Details: [`docs/writing.md`](./docs/writing.md).

> **Semantic search — one-time setup.** The first `zotero_semantic_search` builds the library index automatically in the background (auto-build). On very large libraries you can also run `zotero_index` (action:"build") yourself, then poll action:"status" until done.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (sync, groups, writes without the desktop app; optional otherwise) |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop app (reads + personal-library writes) |
| `ZOTEUS_LOCAL_API_KEY` | — | Pre-provision the Zotero 9+ desktop write key (else granted once, in-app) |
| `ZOTEUS_EMBEDDINGS` | `local` | `local\|openai\|gemini\|off` for semantic search |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent deletion |

Full table in [`docs/configuration.md`](./docs/configuration.md). Running a shared/remote instance? See [`docs/remote-oauth.md`](./docs/remote-oauth.md) (self-host the OAuth remote on loopback or behind your own proxy).

## Documentation

📚 **[zoteus.com/docs](https://zoteus.com/docs)** · [Getting started](./docs/getting-started.md) · [Configuration](./docs/configuration.md) · [Import & resolver](./docs/resolver.md) · [Architecture](./docs/architecture.md) · [Safe writes](./docs/writing.md) · [Citations](./docs/citations.md) · [Semantic search](./docs/semantic-search.md) · [Scholarly context](./docs/scholar.md) · [Code execution](./docs/code-execution.md) · [Deployment](./docs/deployment.md)

## Contributing

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). MIT licensed.

## Acknowledgements

Built on the [Model Context Protocol](https://modelcontextprotocol.io), the [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics), [citeproc-js](https://citeproc-js.readthedocs.io), and the [Citation Style Language](https://citationstyles.org). Not affiliated with or endorsed by the Corporation for Digital Scholarship / Zotero.
