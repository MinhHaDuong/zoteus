# Hybrid semantic search

M6 adds local-first hybrid retrieval: BM25 keyword scoring fused with vector similarity (Reciprocal Rank Fusion), with results that cite the matching item and a snippet.

## Tools

### `zotero_index` — build the index
- `action: "build"` / `"refresh"` — fetch the library's top-level items and index their text (title, abstract, creators, tags) for BM25, plus vector embeddings if an embedder is configured. Persisted under the Zoteus data dir.
- `action: "status"` — report passages/items indexed and the active embedder.

### `zotero_semantic_search` — search by meaning
- `q` — natural-language query. `mode`: `auto` (hybrid, default), `keyword` (BM25), or `semantic` (vector).
- Returns ranked items with a snippet and fused score. Build the index first.
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
