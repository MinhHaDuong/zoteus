# Hybrid semantic search

M6 adds local-first hybrid retrieval: BM25 keyword scoring fused with vector similarity (Reciprocal Rank Fusion), with results that cite the matching item and a snippet.

## Tools

### `zotero_index` — manage the index
The build runs **asynchronously on the server** so the tool call returns immediately and
can never time out the MCP client, even on very large libraries.

- `action: "build"` / `"refresh"` — start a **background job** that pages the library's
  top-level items (100-at-a-time, capped at **5000 items** unless a smaller `limit` is
  given) and indexes their text (title, abstract, creators, tags) for BM25, plus vector
  embeddings if an embedder is configured. Returns at once; **poll `action: "status"`**
  every few seconds until `state` is `done` (or `error`). Calling build again while one
  is running does **not** start a second build — it returns the current progress.
- `action: "status"` — live progress and index size. Reports
  `state` (`idle` | `building` | `done` | `error`), `itemsFetched` / `itemsTotal`,
  `passages`, `vectors`, `items`, the active `embedder`, and `lastError` when
  `state` is `error`. Backward-compatible fields (`documents`, `vectors`, `items`,
  `embedder`, `builtFromVersion`) are still present. Progress is also logged on the
  server (every 500 items / 10s).
- `action: "stop"` — cooperatively cancel a running build. The build halts between
  pages/batches and the partial index is kept and stays searchable.
- `limit` — optional max number of items to index (default and hard cap: 5000).

**Local-first, key-free.** The build pages items through the library router, exactly like
every other read: a running Zotero desktop app serves them from its **local API** (no
cloud API key required), and the cloud **Web API** takes over when the app is closed — and
always for group libraries, which the desktop app does not serve. Item keys are identical
on both backends, so an index built against the desktop app stays valid when a later
lookup goes to the cloud, and the index file is keyed by the Zoteus data dir (plus the
authenticated user in multi-tenant mode), never by the library id the read happened to use.

**Incremental, crash-safe persistence.** Partial progress is persisted atomically as the
build runs (roughly every 200 items or 10s — write-temp-then-rename), so a timeout,
crash, or `stop` can never corrupt `search-index.json`; the last complete snapshot is
what loads on the next startup, and it is fully queryable (BM25 keyword search works on
whatever was indexed).

### `zotero_semantic_search` — search by meaning
- `q` — natural-language query. `mode`: `auto` (hybrid, default), `keyword` (BM25), or `semantic` (vector).
- Returns ranked items with a snippet and fused score. The index is built automatically on first use (see `auto_build` below), or ahead of time with `zotero_index`.
- `auto_build` (default `true`) — when the index is empty the tool starts a background build itself and tells you to poll `zotero_index` action:"status" until `done`, then retry, instead of returning a bare error; pass `auto_build: false` to opt out.
- Snippets are query-centred and trimmed to word boundaries: the excerpt is positioned around the first query token hit rather than always taken from the document head, so the relevant phrase appears in the snippet even when it occurs deep in the abstract.

For exact field/tag/itemType filtering, use `zotero_search_items`. Use semantic search for conceptual "papers about X" queries.

## Embedding backends (privacy-first)

Set `ZOTEUS_EMBEDDINGS`:

| Value | Behaviour |
|---|---|
| `local` (default) | On-device embeddings via `@huggingface/transformers` (model `all-MiniLM-L6-v2`). **No data leaves your machine.** |
| `openai` / `gemini` | API embeddings (opt-in; requires `OPENAI_API_KEY` / `GEMINI_API_KEY`; data is sent to the provider). |
| `off` | Keyword-only (BM25). |

**`local` is opt-in by install** to keep the core package light:

```bash
npm i @huggingface/transformers
```

If the optional dependency (or an API key) is absent, Zoteus **automatically falls back to keyword-only** search and logs a one-line note — everything still works, just without vector ranking. The first local build downloads the model (~25 MB) once.

The index is stored at `<ZOTEUS_DATA_DIR>/search-index.json` and reloaded on startup.

## Large libraries

A few things to know when indexing a big Zotero library:

- **Local embeddings are CPU-bound.** With `ZOTEUS_EMBEDDINGS=local` the model runs on
  your CPU, so embedding thousands of passages takes real time. If you just want fast
  keyword search, set `ZOTEUS_EMBEDDINGS=off` for a quick keyword-only (BM25) index.
- **First local run downloads the model** (~25 MB) before embedding begins — expect a
  one-time delay (and a slower first build) while it fetches and caches.
- **Builds are capped at 5000 items** (both Zotero APIs page 100-at-a-time). Pass a
  smaller `limit` to index a subset faster.
- **Indexing a big library is fastest against the desktop app** — it is served from disk
  over loopback, with no cloud rate limits to back off from.
- **Don't block on the build call.** `build` returns immediately; poll
  `action: "status"` (every few seconds) until `state` is `done`. A partially built
  index is usable for keyword search the whole time, and progress survives crashes.
- **Embeddings are batched** (32 passages per pipeline call) to keep local builds
  efficient and interruptible.
