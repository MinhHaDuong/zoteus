# Scholarly-context graph

M7 adds `zotero_scholar` — explore the wider literature around a paper and see what's already in your library.

## `zotero_scholar`
Provide a `doi` and an `action`:
- `lookup` — metadata + citation count for the work.
- `references` — works this paper cites.
- `citations` — works that cite this paper (most-cited first).
- `related` — similar works.

With `include_in_library` (default `true`), each result is flagged `inLibrary` by matching DOIs against your library, so you can immediately spot **citation gaps** — e.g. "papers this work cites that I haven't saved yet." `limit` caps results (default 20).

## Providers
- **OpenAlex** (primary) — open, no API key; uses the polite pool via `ZOTEUS_CONTACT_EMAIL`. Provides references, citations, related works, and metadata.
- **Crossref** (fallback) — DOI metadata when OpenAlex has no record.

Both are read-only external calls and degrade to a clear message on error.

### Example
> "What does the LeCun *Deep Learning* review cite that I don't have?"
> → `zotero_scholar { action: "references", doi: "10.1038/nature14539" }`
> returns the references, each tagged in-library or new.
