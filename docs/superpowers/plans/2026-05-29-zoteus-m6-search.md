# Zoteus M6 — Hybrid Semantic Search

> REQUIRED SUB-SKILL: subagent-driven-development / executing-plans. TDD; commit per task.

**Goal:** Local-first hybrid retrieval over the library: BM25 keyword scoring fused with vector similarity, with results citing the matching item + snippet. Privacy-preserving by default (embeddings computed locally), and fully functional as keyword-only when no embedder is available.

**Architecture:** Pure-TypeScript core — tokenizer, BM25 index, a JSON-persisted vector store with cosine similarity, a passage chunker, and an index manager that fuses BM25 + vector ranks via Reciprocal Rank Fusion (RRF). Embeddings come from a pluggable `EmbeddingProvider`: a lazy local model (optional dependency), an API provider (OpenAI/Gemini, opt-in), or none. Tests inject a deterministic fake embedder, so CI never downloads a model. The index persists under `ZOTEUS_DATA_DIR`.

**Deps:** no new hard deps. `@huggingface/transformers` is an OPTIONAL, lazily-imported dependency enabling the local model; absent → keyword-only with a logged note.

---

## Files
```
src/features/search/tokenize.ts       # tokenize + stopwords
src/features/search/bm25.ts           # BM25Index (addDoc, search)
src/features/search/vector-store.ts   # VectorStore (cosine topK, JSON persist)
src/features/search/embeddings.ts     # EmbeddingProvider + Fake/Local/Api + factory
src/features/search/chunker.ts        # chunkText(text, size, overlap)
src/features/search/index-manager.ts  # SearchIndex: build/refresh/query/status/persist
src/tools/semantic-search.ts          # zotero_semantic_search
src/tools/index-tool.ts               # zotero_index (build|refresh|status)
```

## Tasks
1. **tokenize + bm25** (+tests): classic BM25 (k1=1.5,b=0.75) over `{id,text}` docs; `search(query, topK)` → `[{id,score}]`.
2. **vector-store** (+tests): `add(id,vector)`, `search(vector,topK)` cosine, `toJSON`/`fromJSON`. Pure JS (brute force; fine for a personal library).
3. **embeddings** (+tests with Fake): `EmbeddingProvider.embed(texts)→number[][]`; `FakeEmbeddingProvider` (deterministic hash → unit vector); `LocalEmbeddingProvider` (lazy `@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`, mean-pool+normalize; import failure → clear error); `ApiEmbeddingProvider` (OpenAI/Gemini). `createEmbeddingProvider(config)` → provider | null (null = keyword-only).
4. **chunker** (+test): split into ~512-char passages with ~64 overlap on sentence/word boundaries; carry an index.
5. **index-manager** (+tests with Fake embedder): `build({items, includeFulltext})` chunks item text (title, abstractNote, creators, tags, date [+ fulltext if requested]) into BM25 + vector store; `query(q,{limit,mode:auto|keyword|semantic})` → RRF-fused ranked passages with `{itemKey,title,snippet,score}`; `status()`; persist/load `search-index.json` under dataDir.
6. **Tools** (+unit tests, Fake embedder via injected ctx.search): `zotero_index` (action build|refresh|status; reports doc/vector counts, embedder mode) and `zotero_semantic_search` (q, limit, mode; returns ranked passages citing item keys; auto-builds a transient index from a search if none persisted).
7. **Wire** a `SearchIndex` into `ToolContext` (lazy; created in buildServer with the configured provider). Integration test → 22 tools. `docs/semantic-search.md`; README M6; v0.5.0; tag. Document enabling the local model (`npm i @huggingface/transformers`) or an API provider.

## Self-review
- [ ] Works keyword-only when no embedder (no crash, clear status).
- [ ] Deterministic fake embedder in tests; CI downloads no model.
- [ ] Index persists/loads under dataDir; rebuild is incremental-friendly (by item version).
- [ ] Results cite item keys + snippets.
- [ ] 22 tools; types consistent.
