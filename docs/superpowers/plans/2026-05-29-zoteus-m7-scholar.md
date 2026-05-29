# Zoteus M7 — Scholarly-Context Graph

> REQUIRED SUB-SKILL: subagent-driven-development / executing-plans. TDD; commit per task.

**Goal:** Enrich the library with the wider scholarly graph: look up a work, list its references and citations, find related work — and flag which results are (or aren't yet) in the user's library.

**Architecture:** `OpenAlexClient` (primary; open, no key, polite-pool `mailto`) + `CrossrefClient` (DOI-metadata fallback). A `ScholarGraph` orchestrates them and normalizes results. One tool, `zotero_scholar`. In-library matching compares result DOIs against the set of DOIs in the library (fetched once, cached). All read-only/openWorld; degrades clearly if a provider errors.

**No new deps** (uses fetch + the existing RateLimitedFetcher).

---

## Verified
- `GET https://api.openalex.org/works/doi:<doi>?mailto=<email>` → work with `referenced_works` (OpenAlex URLs), `related_works`, `cited_by_count`, `authorships`, `publication_year`, `doi`.
- Batch resolve: `GET /works?filter=openalex_id:W1|W2&per-page=50`.
- Citations: `GET /works?filter=cites:W<id>&per-page=<n>`.
- Crossref: `GET https://api.crossref.org/works/<doi>?mailto=<email>` → `{message}` (may return non-JSON on error → handle as null).

## Files
```
src/features/scholar/openalex.ts   # OpenAlexClient + normalize
src/features/scholar/crossref.ts   # CrossrefClient.work(doi)
src/features/scholar/graph.ts      # ScholarGraph: lookup/references/citations/related; ScholarWork type
src/tools/scholar.ts               # zotero_scholar
```

## Tasks
1. **OpenAlexClient** (+tests, mock fetch): `work(doiOrId)`, `worksByIds(ids[])` (strip `https://openalex.org/`, chunk 50, OR filter), `citedBy(id, perPage)`, `normalize(w)→ScholarWork`.
2. **CrossrefClient** (+test): `work(doi)→ScholarWork|null` (tolerate non-JSON).
3. **ScholarGraph** (+tests): `lookup(doi)` (OpenAlex→Crossref fallback), `references(doi,limit)`, `citations(doi,limit)`, `related(doi,limit)`.
4. **zotero_scholar tool** (+unit tests): `action: lookup|references|citations|related`, `doi` (required), `limit` (default 20), `include_in_library` (default true). When set, fetch library DOIs (paginated listItems, cached, cap 5000), lowercase-match, add `inLibrary` to each result and an `in_library`/`not_in_library` summary.
5. **Wire** `scholar: ScholarGraph` into ToolContext + buildServer. Integration → 23 tools. **Live** verify (OpenAlex, no key): lookup + references of a known DOI. `docs/scholar.md`; README M7; v0.6.0; tag.

## Self-review
- [ ] OpenAlex `mailto` polite-pool param sent; provider errors degrade to a clear message.
- [ ] referenced/related OpenAlex URLs stripped to bare ids for the batch filter.
- [ ] in-library matching by lowercased DOI; library DOIs fetched once and cached.
- [ ] 23 tools; types consistent.
