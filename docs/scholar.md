# Scholarly-context graph

M7 adds `zotero_scholar` — explore the wider literature around a paper and see what's already in your library.

## `zotero_scholar`
Provide a `doi` and an `action`:
- `lookup` — metadata + citation count for the work.
- `references` — works this paper cites.
- `citations` — works that cite this paper (most-cited first).
- `related` — similar works.

> **Note:** `zotero_scholar` queries the external scholarly web (OpenAlex/Crossref) — it does **not** search or read your library. To find items in your library use `zotero_search_items`, `zotero_semantic_search` (after `zotero_index build`), or `zotero_get_item`.

With `include_in_library: true` (opt-in; off by default because it scans the library), each result is flagged `inLibrary` by matching DOIs against your library, so you can spot **citation gaps** — e.g. "papers this work cites that I haven't saved yet." `limit` caps results (default 20).

## Providers
- **OpenAlex** (primary) — open, no API key; uses the polite pool via `ZOTEUS_CONTACT_EMAIL`. Provides references, citations, related works, and metadata.
- **Crossref** (fallback) — DOI metadata when OpenAlex has no record.

Both are read-only external calls and degrade to a clear message on error.

### Example
> "What does the LeCun *Deep Learning* review cite that I don't have?"
> → `zotero_scholar { action: "references", doi: "10.1038/nature14539" }`
> returns the references, each tagged in-library or new.
