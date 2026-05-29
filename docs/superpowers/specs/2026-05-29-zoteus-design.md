# Zoteus — Design Specification

> **Zoteus** — *The everything Zotero MCP server. Your research library, fully wired into Claude.*

- **Status:** Approved design — pending implementation plan
- **Date:** 2026-05-29
- **Author:** Oscar Devos ([@oscardvs](https://github.com/oscardvs))
- **Repo:** `oscardvs/zoteus`
- **License:** MIT

---

## 1. Summary

Zoteus is an open-source [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, written in **TypeScript (Node 18+, ESM)**, that exposes (nearly) the entire **Zotero Web API v3** plus the **Zotero desktop local API** to MCP-compatible AI hosts (Claude Code, Claude Desktop, and generic clients).

It is designed to be the most complete and best-engineered Zotero MCP server available, combining:

1. **Complete API coverage** — items, collections, saved searches, tags, full-text, attachments (full 5-step upload protocol), versioned delta sync, group libraries, schema/templates, and all 17 export formats.
2. **Local-first + cloud, auto-detecting** — fast, key-free, full-PDF reads via the Zotero desktop local API when available, with the cloud Web API as the universal fallback (and the only supported write path).
3. **Safe transactional writes** — versioned optimistic-locking, automatic 412 re-fetch/retry, 50-item auto-chunking, partial-success parsing; reversible trash as the default, permanent delete gated behind explicit opt-in.
4. **A citation pipeline** — account-free add-by-identifier (DOI/ISBN/PMID/arXiv/ADS Bibcode) and add-by-URL via a Zotero translation-server, and bibliography formatting in any of ~2,800 CSL styles via citeproc-js.
5. **Hybrid semantic search** — local-first (privacy-preserving) BM25 + vector retrieval over metadata, full text, and annotations, with page-cited results.
6. **A scholarly-context graph** — OpenAlex / Crossref / Semantic Scholar integration for references, citations, recommendations, retraction checks, and "find related work (in / not yet in) my library".
7. **MCP-native surface** — not just Tools, but **Resources** (`zotero://…` URIs) and **Prompts** (literature-review, citation-audit, …) that no existing Zotero MCP server ships.
8. **Anthropic's code-execution pattern** — the tool surface is also generated as a TypeScript module tree that an agent can import and call from a code-execution sandbox, keeping large intermediate data (full text, big exports) out of the model's context. Long-tail tools are deferred via Tool Search.
9. **Production engineering** — full test suite (unit + in-process integration + opt-in e2e), CI, tagged releases, MCP Inspector wiring, and graceful degradation when optional services are absent.

This document is the authoritative design. The implementation plan is derived from it separately.

---

## 2. Goals and non-goals

### Goals

- Encapsulate (nearly) all Zotero Web API v3 functionality behind a coherent, consolidated MCP tool surface.
- Follow Anthropic's published guidance for designing tools for agents and the code-execution-with-MCP pattern.
- Be safe by default: never lose data; make destructive operations explicit and opt-in.
- Be installable in one command (`npx`) and discoverable (web/GitHub/npm search front-loads "Zotero MCP server").
- Be exceptionally well documented for open-source contributors and users.

### Non-goals (v1)

- Multi-tenant hosted SaaS with full OAuth 2.1 (the Streamable HTTP transport ships, but OAuth is a later milestone — documented, not built in v1).
- Editing the local SQLite database directly (unsupported and risky while Zotero runs).
- Bundling/operating the translation-server or an embeddings server *for* the user — these are optional external services the server connects to and degrades gracefully without.
- Re-implementing Zotero's sync engine; Zoteus performs incremental version-based reads/writes, not a full bidirectional replica.

---

## 3. Key decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Language / runtime | TypeScript, Node 18+, ESM | First-class MCP SDK; same language as Anthropic's code-execution pattern; native citeproc-js. |
| Library access | Both (local + cloud), auto-detecting | Local API = fast, key-free, full PDFs, executes saved searches; cloud = universal + writes/sync/groups. |
| Write scope | Full write, safe-by-default | Create/update/trash everywhere; permanent delete gated behind opt-in + confirmation. |
| Power features (all in scope) | Citation pipeline, code-exec + Resources/Prompts, hybrid semantic search, scholarly graph | The combination is the differentiator; no existing server has all four. |
| Packaging | Single npm package, modular internals, optional/lazy heavy deps | One-command install; heavy deps (embeddings/vector index) don't bloat the core. |
| Name | **Zoteus** | Brandable; discoverability handled via description/keywords/topics/README. |
| Transport | stdio default; Streamable HTTP opt-in; OAuth later | Local desktop is the common case; HTTP for teams; OAuth deferred. |
| Zotero version target | Capability-probe (user is on Zotero 9) | Adapt to the running instance instead of hardcoding version assumptions. |

---

## 4. Architecture

### 4.1 Layered overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Transport         stdio (default) │ Streamable HTTP (--http)           │
│                                     (OAuth 2.1 = later milestone)       │
├──────────────────────────────────────────────────────────────────────┤
│ MCP Server (McpServer)   registers Tools · Resources · Prompts          │
├──────────────────────────────────────────────────────────────────────┤
│ Tool Registry  ← single source of truth (name, description, zod input   │
│                  schema, outputSchema, annotations, handler)            │
│                  → MCP tool registration                                │
│                  → generated codex/zotero/*.ts wrappers                 │
│                  → search_tools (Tool Search) catalog                   │
├──────────────────────────────────────────────────────────────────────┤
│ LibraryRouter  ← startup capability-probe; per-operation routing        │
│        reads  → LocalApiClient when present, else WebApiClient          │
│        writes → WebApiClient (or LocalWriteClient if enabled)           │
│        cite   → BetterBibTeXClient / TranslationServerClient            │
├──────────────────────────────────────────────────────────────────────┤
│ Clients:                                                                │
│   WebApiClient · LocalApiClient · BetterBibTeXClient · LocalWriteClient │
├──────────────────────────────────────────────────────────────────────┤
│ Feature modules:                                                        │
│   SchemaService · CitationPipeline · SemanticSearch · ScholarlyGraph    │
│   Codex (wrapper generation)                                            │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 Source layout (single package)

```
zoteus/
├── src/
│   ├── index.ts                 # CLI entry: parse args/env, pick transport, connect
│   ├── server.ts                # builds McpServer, runs capability probe, registers everything
│   ├── config.ts                # env/flag parsing → typed Config (zod-validated)
│   ├── transports/
│   │   ├── stdio.ts             # StdioServerTransport adapter
│   │   └── http.ts              # StreamableHTTPServerTransport (Express, 127.0.0.1, session)
│   ├── registry/
│   │   ├── registry.ts          # ToolDefinition type + register() + collection
│   │   └── tool-search.ts       # search_tools / defer_loading support
│   ├── router/
│   │   ├── capabilities.ts      # probe local API, Better BibTeX, write add-on, translation-server
│   │   └── library-router.ts    # per-op routing decisions
│   ├── api/
│   │   ├── web-client.ts        # cloud api.zotero.org v3 (auth, retries, versioning, pagination, chunking)
│   │   ├── local-client.ts      # localhost:23119/api (read-only, users/0)
│   │   ├── bbt-client.ts        # localhost:23119/better-bibtex (json-rpc, cayw) — optional
│   │   ├── local-write-client.ts# community write add-on (/write,/attach,/version) — optional
│   │   ├── http.ts              # shared fetch wrapper: concurrency semaphore, backoff, headers
│   │   └── errors.ts            # ZoteroApiError + actionable mapping (412/428/413/429/404/409)
│   ├── schema/
│   │   └── schema-service.ts    # fetch+cache api.zotero.org/schema; validate items; templates
│   ├── tools/                   # one file per tool; each default-exports a ToolDefinition
│   │   ├── index.ts             # registerTools(server, ctx)
│   │   ├── whoami.ts  search-items.ts  get-item.ts
│   │   ├── create-items.ts  update-item.ts  trash-items.ts  delete-items.ts
│   │   ├── manage-collections.ts  manage-tags.ts  saved-searches.ts
│   │   ├── attachment.ts  fulltext.ts  sync.ts  groups.ts  export.ts
│   │   ├── import.ts  bibliography.ts  format-bibliography.ts  styles.ts
│   │   ├── semantic-search.ts  index.ts  scholar.ts  schema.ts
│   │   └── search-tools.ts
│   ├── resources/               # zotero:// resources + templates
│   ├── prompts/                 # literature-review, cite, add-from-url, organize, find-related, …
│   ├── features/
│   │   ├── citation/            # translation-server client, CSL style resolver, citeproc engine
│   │   ├── search/              # chunker, BM25, embedding providers, vector store, reranker
│   │   └── scholar/             # openalex.ts, crossref.ts, semantic-scholar.ts, graph.ts
│   ├── codex/
│   │   └── generate.ts          # generates ./codex/zotero/*.ts wrappers from the registry
│   └── lib/                     # logger (stderr-only), cache, paths, fuzzy, types
├── codex/zotero/                # generated TS wrappers (committed; regenerated in build)
├── docs/                        # see §11
├── tests/                       # vitest: unit, integration (InMemoryTransport), e2e (opt-in)
├── dxt/                         # Desktop Extension manifest + build
├── .github/workflows/           # ci.yml, release.yml
├── server.json                  # MCP registry manifest
├── package.json  tsconfig.json  vitest.config.ts  eslint/prettier config
└── README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md  CHANGELOG.md  SECURITY.md
```

### 4.3 Tool Registry as single source of truth

A `ToolDefinition` carries: `name` (`zotero_*`), `title`, `description` (long, per Anthropic guidance), `inputSchema` (zod), optional `outputSchema` (zod), `annotations` (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`), `deferLoading?: boolean`, and an async `handler(input, ctx)`. The same definitions drive (a) MCP `registerTool`, (b) generation of `codex/zotero/<tool>.ts` wrappers, and (c) the `search_tools` catalog. This guarantees the classic tools, the code-execution surface, and Tool Search never drift apart.

---

## 5. Library access & routing

### 5.1 Capability probe (startup, fast, non-fatal)

On boot the server probes, in parallel and with short timeouts, and caches results:

- **Local read API:** `GET http://127.0.0.1:{port}/api/users/0/items?limit=1` (default port 23119). Records availability and a sample of supported formats. Read-only.
- **Better BibTeX:** `POST /better-bibtex/json-rpc {method:"api.ready"}` (or `GET /better-bibtex/cayw?probe=true`).
- **Local write add-on:** `GET /version` on the add-on namespace.
- **Translation-server:** `GET {translationServerUrl}/` liveness (default `http://127.0.0.1:1969`).
- **Cloud:** if `ZOTERO_API_KEY` present, `GET https://api.zotero.org/keys/current` to resolve `userID`, `username`, and per-library access scopes.

Nothing here is fatal: each capability flips a flag, and tools surface clear messages when a path they need is unavailable (e.g. "writes require a `ZOTERO_API_KEY`; none configured").

### 5.2 Routing rules

| Operation class | Preferred path | Fallback / notes |
|---|---|---|
| Item/collection/tag **reads**, full-text reads | Local API (fast, key-free, full PDFs) | Cloud Web API; honors `ZOTEUS_LOCAL=auto\|on\|off` |
| Saved-search **execution** | Local API (returns results) | Cloud returns *definition only* — surfaced to the model |
| **Writes** (create/update/trash/delete, collections, tags) | Cloud Web API v3 | Local write add-on only if detected **and** explicitly enabled |
| Attachment upload/download, sync, groups | Cloud Web API v3 | — |
| Citation key lookup / CAYW | Better BibTeX (if present) | degrade: no citekey lookup |
| Add-by-identifier / add-by-URL | Translation-server (if present) | degrade: feature reports it needs the service |
| Bibliography formatting | citeproc-js (in-process) or cloud `format=bib` | both available; citeproc supports any CSL style with no library |

---

## 6. The Zotero Web API client (the hard part, done once)

`WebApiClient` (and the shared `http.ts`) bake in every v3 convention so neither the model nor the tools must reason about them:

- **Base & headers:** `https://api.zotero.org`, `Zotero-API-Version: 3`, `Zotero-API-Key: <key>`, JSON by default.
- **Identity:** resolve `userID` via `/keys/current`; never require the user to type a numeric ID.
- **Concurrency & rate limits:** semaphore caps in-flight requests at 4; honor `Backoff` (every response) and `Retry-After` (429/503) in seconds; exponential backoff otherwise; respect the separate "too many unfinished uploads" 429.
- **Pagination:** follow `Link` headers (`next`/`last`); expose `Total-Results`; default `limit=25`, max 100.
- **Optimistic concurrency:** all writes send `If-Unmodified-Since-Version` (library or per-object version); single-object writes may use the per-object `version`; new-object creates send a `Zotero-Write-Token` for idempotency. On **412**: re-fetch current version and retry (bounded), surfacing a clear message if it still conflicts. A missing precondition on DELETE → **428** is prevented by construction.
- **PATCH vs PUT:** updates default to **PATCH** (partial). PUT (full replace, which wipes omitted fields) is only used when explicitly requested.
- **Batching:** auto-chunk creates/updates/deletes and `itemKey`/`collectionKey`/`searchKey` filters into ≤50-object requests; **413** on overflow is prevented by chunking.
- **Partial success:** parse the 200-OK body of batch writes — `successful` / `unchanged` / `failed` keyed by numeric index (and the single-item `success` quirk) — and report per-object outcomes rather than assuming success.
- **Schema cache:** fetch `https://api.zotero.org/schema` once, cache it, invalidate on `version` bump; used to validate item JSON and produce templates before any write.
- **Errors → actionable messages:** `412` → "Item changed on the server since you fetched it (version N). Re-fetch with `zotero_get_item` and retry."; `429` → surface `Retry-After`; `400` → name the invalid field/itemType; `413` → quota/oversize guidance.

`LocalApiClient` mirrors the read surface against `http://127.0.0.1:23119/api`, library `users/0`, sending the connector header quirks (`x-zotero-connector-api-version` / `zotero-allowed-request`) when needed, and is strictly GET-only.

---

## 7. Tool catalog (consolidated, workflow-oriented)

~24 tools, all `zotero_`-namespaced (comfortably under the 30–50 tool-selection ceiling), each with a long description encoding Zotero-specific niche knowledge (boolean `itemType`/`tag` syntax with `||`/`&&`/`-`; `bib` capped at 150 and item-only; saved searches not executed by the cloud API; DELETE permanent vs `deleted:1` trash; `mtime` in milliseconds). Read tools take `response_format: concise|detailed`. List/search tools cap response size (~25k tokens) and, on truncation, tell the model how to narrow rather than silently cutting.

**Identity / schema**
- `zotero_whoami` — resolve userID, username, per-library access scopes from the API key.
- `zotero_schema` — cached item types, valid fields, creator types, and `items/new` templates for client-side validation.

**Read**
- `zotero_search_items` — unified search/list across a library or collection: `q`+`qmode`, boolean `itemType`/`tag`, `since`, `includeTrashed`, `sort`/`direction`/`limit`/`start`, `response_format`; returns high-signal projections + `resource_link`s.
- `zotero_get_item` — one item (+optional children) with selectable `include` (data/bib/citation/csljson) and format.

**Write (safe)**
- `zotero_create_items` — create/update 1–50 items in one batch (PATCH-style update when key+version present); schema-validated before send.
- `zotero_update_item` — single-item PATCH (default) or PUT (explicit) with optimistic-locking + 412 retry.
- `zotero_trash_items` — soft-delete (`deleted:1`) / restore (`deleted:0`); the reversible default.
- `zotero_delete_items` — **permanent** purge by key (≤50); `destructiveHint`; requires `ZOTEUS_ALLOW_DELETE=true` **and** an explicit `confirm:true` argument and current versions.

**Organize**
- `zotero_manage_collections` — `action`: list/get/create/rename/reparent/move-items/delete (handles `parentCollection` nesting and membership moves).
- `zotero_manage_tags` — list (library/item/collection scope, `contains`|`startsWith`) and add/remove (by editing parent items' `tags[]`).
- `zotero_saved_searches` — list/get/create/delete definitions; **executes** them via the local API when present (cloud cannot).

**Files / text / sync**
- `zotero_attachment` — end-to-end: create attachment item + full 5-step File Storage upload (md5/mtime-ms/`exists` short-circuit/register) and download/verify (ETag == md5).
- `zotero_fulltext` — get an attachment's extracted text, set it (PUT), or list FT changed since a version.
- `zotero_sync` — incremental delta: `format=versions&since=` for items/collections/searches/tags + the `/deleted` log; returns a changed-keys summary (filter in code, not context).
- `zotero_groups` — list accessible groups + per-group metadata/permissions.
- `zotero_export` — export items in any of the 17 bibliographic formats (bibtex/biblatex/ris/csljson/csv/mods/tei/…).

**Citations**
- `zotero_import` — add by identifier (DOI/ISBN/PMID/arXiv/ADS Bibcode via `/search`) or by URL (`/web`, handling the `300 Multiple Choices` selection round-trip); optional `save_to_library` → versioned create. Account-free up to the save step.
- `zotero_bibliography` — cloud-rendered citations/bibliography for item keys (`format=bib`/`include=bib,citation`, `style`+`locale`+`linkwrap`; warns on the 150-item cap).
- `zotero_format_bibliography` — citeproc-js in-process: format arbitrary items in any CSL style → html/text/rtf, no library required (Zotero-JSON → CSL-JSON via `export?format=csljson`, stripping `note` objects per translation-server issue #67).
- `zotero_styles` — list/resolve CSL styles; fuzzy-match "APA 7th"/"IEEE"/"Vancouver" → a valid CSL id; resolve dependent→independent parents; validate before formatting.

**Discovery**
- `zotero_semantic_search` — hybrid retrieval (BM25 + vector), passage/chunk-level over metadata + full text + annotations; results cite item + page.
- `zotero_index` — build/refresh/status of the local semantic index (incremental via version delta).
- `zotero_scholar` — references / citations / recommendations / related work / retraction & version checks via OpenAlex (default) / Crossref / Semantic Scholar; matches results against the library by DOI ("in library" vs "not yet").

**Code-execution**
- `search_tools` — discover the deferred long-tail tools on demand at a chosen detail level (name / name+description / full schema). Hot tools (`zotero_search_items`, `zotero_get_item`, `zotero_schema`, `search_tools`) are never deferred.

---

## 8. MCP Resources & Prompts

### 8.1 Resources (read-only, URI-addressable; `subscribe`+`listChanged`)

- `zotero://schema` — cached data model.
- `zotero://{libraryType}/{libraryID}/collections` — collection tree snapshot.
- Templates: `zotero://{libraryType}/{libraryID}/items/{itemKey}`, `…/collections/{collectionKey}/items`, `…/tags`.
- `zotero://{libraryType}/{libraryID}/items/{itemKey}/fulltext`, `…/items/{itemKey}/file` (attachment bytes as `blob`).

Update notifications (`notifications/resources/updated`) are driven by the library `Last-Modified-Version` observed during reads/sync. Tools that return items emit `resource_link`s instead of always inlining full JSON.

### 8.2 Prompts (user-triggered workflows)

`/zotero-literature-review` (topic/collection → search + synthesize + cite), `/zotero-cite` (keys + style → formatted bibliography), `/zotero-add-from-url` (guided ingest), `/zotero-organize` (suggest tags/moves for loose items), `/zotero-find-related` (relations + tag/FT overlap + scholar graph), `/zotero-citation-audit` (check a draft's citations against the library; flag missing/retracted), `/zotero-summarize-collection`.

---

## 9. Feature modules

### 9.1 Citation pipeline (`features/citation`)

- **Translation-server client** (`POST /search`, `/web`, `/import`, `POST /export?format=`). Auto-detects identifier type by pattern; handles the `/web` `300` session round-trip; strips `note` objects before `csljson`.
- **CSL style resolver** — fuzzy name → id; fetch CSL XML from the GitHub styles repo / jsDelivr CDN (cached, effectively immutable); resolve dependent styles to their independent parent; resolve locales (RFC 5646).
- **citeproc engine** — citeproc-js in-process with `retrieveLocale`/`retrieveItem`; `makeBibliography()` + `processCitationCluster()`; outputs html/text/rtf with no Zotero account.
- A descriptive `User-Agent` and the polite-pool contact (`osrdevos@gmail.com`) are sent to translation-server / Crossref / NCBI.

### 9.2 Hybrid semantic search (`features/search`, optional/lazy deps)

- **Chunker** — splits full text + notes/annotations into passages with page offsets where available.
- **Index** — local store (better-sqlite3 + a vector extension such as sqlite-vec, or hnswlib) under `ZOTEUS_DATA_DIR`; built/refreshed incrementally from the version delta so re-indexing is cheap.
- **Embeddings provider** — pluggable: **local default** (e.g. a small on-device model via `@xenova/transformers`) so no data leaves the machine; optional OpenAI/Gemini providers behind keys. `ZOTEUS_EMBEDDINGS=local|openai|gemini|off`.
- **Retrieval** — BM25 + vector candidates, fused and reranked; returns passages citing item key + page. Heavy deps load lazily so users who don't enable search pay nothing.

### 9.3 Scholarly-context graph (`features/scholar`)

- **OpenAlex** (default, open, generous; polite pool via email), **Crossref**, **Semantic Scholar** (optional key for higher limits).
- Capabilities: references, citing works, recommendations/related, retraction & version checks; reconcile against the library by DOI to label results "in library" / "not yet".
- Short-TTL caching to respect provider rate limits.

### 9.4 Code-execution layer (`src/codex`)

- `generate.ts` emits `codex/zotero/<tool>.ts` — one thin, fully-typed wrapper per tool, each forwarding to `callMCPTool('zotero_<tool>', input)`, plus an `index.ts` barrel and a generated `README` explaining progressive disclosure (list the dir, read only the tools you need).
- Combined with `search_tools` + `deferLoading`, this delivers the token-efficiency Anthropic describes: an agent reads only the few tool files relevant to a task, and large intermediate results are filtered/aggregated in the sandbox before a small result is returned.
- Wrappers are regenerated during build and committed so the directory is browsable in the repo.

---

## 10. Configuration

All configuration is via environment variables (and equivalent CLI flags), validated by zod at startup:

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (writes/sync/groups; optional for local-only reads). |
| `ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` | auto | Target library; auto-resolved via whoami/groups if omitted. |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the desktop local API. |
| `ZOTERO_LOCAL_PORT` | `23119` | Desktop local server port. |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Add-by-identifier/URL (optional; degrades if absent). |
| `ZOTEUS_EMBEDDINGS` | `local` | `local\|openai\|gemini\|off` for semantic search. |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | — | Only if the corresponding embeddings provider is selected. |
| `ZOTEUS_DATA_DIR` | OS data dir | Index + caches. |
| `ZOTEUS_CONTACT_EMAIL` | `osrdevos@gmail.com` | Polite-pool contact for OpenAlex/Crossref/NCBI. |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent delete. |
| `ZOTEUS_SCHOLAR_PROVIDERS` | `openalex` | Comma list: `openalex,crossref,semanticscholar`. |
| `SEMANTIC_SCHOLAR_API_KEY` | — | Optional higher rate limits. |

**stdio rule:** logging goes to **stderr / file only** — never stdout (stdout carries the JSON-RPC stream).

---

## 11. Documentation plan (open-source, catchy, discoverable)

- **README.md** — catchy hero + tagline, the "how it beats the field" matrix, animated quickstart, install snippets (Claude Code `claude mcp add`, Claude Desktop config, DXT one-click), full config table, a "code execution with MCP" guide, and a feature tour. Front-loads "Zotero MCP server" in the first line + description for search ranking.
- **docs/** — `architecture.md`, auto-generated `tool-reference.md` (from the registry), `resources.md`, `prompts.md`, `citation-pipeline.md`, `semantic-search.md`, `scholarly-context.md`, `code-execution.md`, `configuration.md`, `security.md`, `troubleshooting.md`.
- **Repo hygiene** — `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `SECURITY.md`, issue/PR templates, GitHub topics (`zotero`, `mcp`, `model-context-protocol`, `claude`, `citations`, `bibliography`, `research`, `reference-manager`).

---

## 12. Testing & quality

- **Unit** — tools with `api/*-client` mocked; the HTTP wrapper's backoff/pagination/chunking/version logic; the CSL resolver and partial-success parser.
- **Integration** — in-process via the SDK's `InMemoryTransport` pair (no child process): list tools/resources/prompts, call tools, assert structured output and `resource_link`s.
- **E2E (opt-in)** — gated by env, against a disposable real test library + a local Zotero/translation-server when present; exercised in CI only when secrets exist.
- **Tooling** — MCP Inspector (`npx @modelcontextprotocol/inspector npx tsx src/index.ts`); GitHub Actions CI (lint, typecheck, test, build); release workflow (tag → build → `npm publish --access public` → registry).
- **Eval-driven iteration** — realistic multi-tool tasks against a test library; track tool-call count, tokens, and errors; refine tool descriptions (the highest-ROI lever).

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Optimistic-locking 412 conflicts | Re-fetch/retry baked into `WebApiClient`; never exposed to the model. |
| Permanent data loss via DELETE | Off by default; `destructiveHint`; explicit `confirm` + `ZOTEUS_ALLOW_DELETE`. |
| 50-item batch / 413 | Auto-chunking in the client. |
| Rate limiting / 429 throttle | Concurrency cap + `Backoff`/`Retry-After` honored everywhere. |
| Local API read-only (incl. Zotero 9) | Writes routed to cloud; local-write add-on opt-in only. |
| Optional services absent (translation-server, BBT, embeddings) | Capability-probe + graceful degradation with clear messages. |
| Schema drift / note-attachment-annotation special types | Cache `/schema`, validate by itemType, branch special types. |
| stdout corruption on stdio | stderr/file-only logging enforced. |
| Code-execution sandbox cost/security | Code-exec wrappers are opt-in; classic tools work everywhere with no sandbox. |

---

## 14. Build phasing (milestones)

0. **Scaffold** — package.json (`bin: zoteus`, `mcpName`), tsconfig (ESM/ES2022), vitest, eslint/prettier, CI skeleton, README skeleton, MIT license.
1. **API clients + capability probe** — `http.ts`, `WebApiClient`, `LocalApiClient`, `SchemaService`, errors, config.
2. **MCP core + read surface** — `McpServer`, registry, stdio transport, `whoami`/`search_items`/`get_item`/`schema`, base Resources. Inspector-verifiable.
3. **Safe writes** — create/update/trash/delete, collections, tags, saved searches; optimistic locking + partial-success.
4. **Files/sync/groups/export** — attachment 5-step upload + download, fulltext, sync delta, groups, export formats.
5. **Citation pipeline** — translation-server client, CSL resolver, citeproc engine; `import`/`bibliography`/`format_bibliography`/`styles`.
6. **Hybrid semantic search** — chunker, index, embedding providers, BM25+vector+rerank; `semantic_search`/`index`.
7. **Scholarly graph** — OpenAlex/Crossref/S2; `scholar`.
8. **Code-exec + Prompts** — wrapper generation, `search_tools`/`deferLoading`, all Prompts.
9. **Distribution polish** — Streamable HTTP transport, DXT, MCP registry `server.json`, docs completion, eval suite.

Each milestone is independently verifiable (tests + Inspector) before the next begins.
