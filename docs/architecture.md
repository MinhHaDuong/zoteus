# Architecture

Zoteus is a single TypeScript (Node 20+, ESM) package with clean internal layers.

```
Transport          stdio (default) │ Streamable HTTP (--http)   (OAuth: docs/remote-oauth.md)
      │
MCP Server         McpServer — registers Tools · Resources · Prompts
      │
Tool Registry      single source of truth (name, zod schema, annotations, handler)
      │              → MCP tool registration
      │              → generated codex/zotero/*.ts wrappers (code execution)
      │              → search_tools catalog (progressive disclosure)
      │
LibraryRouter      startup capability probe → per-operation routing
      │              reads  → local API when up, else cloud
      │              writes → desktop app for the personal library when up, else cloud
      │                       (group libraries and unsupported ops always cloud)
      │
Clients            reads   WebApiClient · LocalApiClient
      │              writes WebApiClient (v3) · LocalWriteClient (Zotero 9+ local API,
      │                     user-granted key) · ConnectorWriteClient (saveItems/
      │                     saveAttachment, Zotero ≤ 9.0 — create-only)
      │              RateLimitedFetcher: concurrency cap + Backoff/Retry-After
      │
Feature modules    SchemaService · citation (translation-server, CSL, citeproc)
                   search (BM25 + vectors + embeddings) · scholar (OpenAlex/Crossref)
```

## Source map

| Path | Responsibility |
|---|---|
| `src/index.ts` | CLI entry: parse flags/env, build server, pick transport |
| `src/server.ts` | `buildServer()` — wires clients, router, features, registers everything |
| `src/config.ts` | env → typed, zod-validated `ZoteusConfig` |
| `src/api/` | `http.ts` (rate-limited fetch), `web-client.ts` (cloud v3), `local-client.ts` (desktop reads), `local-writes.ts` (Zotero 9+ desktop writes + key grant), `connector-writes.ts` (connector-protocol fallback), `attachments.ts`, `bbt-client.ts`, `errors.ts` |
| `src/router/` | `capabilities.ts` (probe), `library-router.ts` (local-vs-cloud reads) |
| `src/schema/` | `schema-service.ts` (cache), `validate.ts` (pre-write validation), `item-payload.ts` (repairs degraded client payloads) |
| `src/registry/` | `ToolDefinition`/`ToolContext` + `registerAllTools` adapter |
| `src/tools/` | one file per tool (30 total) |
| `src/resources/` | `zotero://` resources |
| `src/prompts/` | 7 workflow prompts |
| `src/features/citation` | translation-server client, CSL style resolver, citeproc engine |
| `src/features/search` | tokenizer, BM25, vector store, embeddings, chunker, index manager |
| `src/features/scholar` | OpenAlex + Crossref clients, scholar graph |
| `src/features/resolve` | built-in DOI/arXiv import resolution (translation-server fallback), see `docs/resolver.md` |
| `src/codex/` | generates the code-execution wrapper tree from the registry |
| `src/transports/` | `stdio.ts`, `http.ts` |

## Key principles
- **One client owns the hard parts** (versioning, retries, batching) so tools and the model never reason about them.
- **Safe by default** — trash over delete; permanent delete double-gated.
- **Graceful degradation** — local API, translation-server, local embeddings, and scholarly providers are all optional; absence yields a clear message, never a crash.
- **Single registry** drives tools, code-execution wrappers, and discovery so they never drift.
