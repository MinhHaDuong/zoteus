# Scholarly-context graph

`zotero_scholar` explores the wider literature around a paper and shows what is already in your library.

## `zotero_scholar`
Provide a `doi` and an `action`:
- `lookup` — metadata + citation count for the work.
- `references` — works this paper cites.
- `citations` — works that cite this paper (most-cited first).
- `related` — similar works.

> **Note:** `zotero_scholar` queries the external scholarly web (OpenAlex/Crossref) — it does **not** search or read your library. To find items in your library use `zotero_search_items`, `zotero_semantic_search` (after `zotero_index build`), or `zotero_get_item`.

With `include_in_library: true` (opt-in; off by default because it scans the library), each result is flagged `inLibrary` by matching DOIs against your library, so you can spot **citation gaps** — e.g. "papers this work cites that I haven't saved yet." `limit` caps results (default 20). Every list answer also carries `total`, the size of the list the results were cut from, and `truncated: true` when the limit dropped some, so a review with 150 references never looks like one with 20; raise `limit` (up to 100) or ask again to see the rest.

The tool is deliberately a thin helper around one DOI. For full OpenAlex querying (keyword search, filters, paging, `select`) an agent can call `https://api.openalex.org` directly; OpenAlex publishes an LLM quick reference for exactly that. Wrapping more of that API here would make Zoteus a second OpenAlex client to maintain, for power the calling agent already has over plain HTTP.

## Providers
- **OpenAlex** (primary): works without a key on a small daily budget; a free key from openalex.org in `ZOTEUS_OPENALEX_API_KEY` raises it. The key travels as a bearer header, never in a URL. OpenAlex replaced its "polite pool" with keys before February 2026 and ignores the `mailto=` parameter, so Zoteus no longer sends it there; `ZOTEUS_CONTACT_EMAIL` still identifies you in the User-Agent. Provides references, citations, related works, and metadata.
- **Crossref** (fallback) — DOI metadata when OpenAlex has no record.

Both are read-only external calls and degrade to a clear message on error.

### Example
> "What does the LeCun *Deep Learning* review cite that I don't have?"
> → `zotero_scholar { action: "references", doi: "10.1038/nature14539" }`
> returns the references, each tagged in-library or new.
