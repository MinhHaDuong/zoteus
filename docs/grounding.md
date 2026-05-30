# Full-text grounding, tag audit, and BBT export (M12)

M12 adds tools for research grounding: retrieve PDF passages with page locators, audit tag hygiene against a controlled vocabulary, and export with Better BibTeX formatting.

## `zotero_get_fulltext` — retrieve PDF text for grounding

Retrieve the full text of a PDF attachment for use as grounding context. Pass either:
- A **parent item key** — the best PDF child attachment is resolved automatically (prefers `application/pdf` content type; falls back to the first attachment if no PDF is found).
- An **attachment key** directly — returned as-is.

### Retrieval modes

One of three modes is selected based on the arguments:

**`query` mode** (pass `query`): Returns the top-k passages most relevant to the query, ranked by an ephemeral BM25 index (fused with vector re-ranking when an embedder is configured). Each passage carries:
- `charStart` / `charEnd` — inclusive/exclusive character offsets in the source text.
- `section` — nearest preceding section heading (best-effort).
- `pageApprox` — proportional page estimate (1-based), or `page` (exact) when `precise_pages` succeeds.
- `score` — BM25 score.
- `max_passages` caps the number of passages returned (default 5, max 20).

**`page_range` mode** (pass `page_range`, e.g. `"3-7"`): Returns the text for the specified page span (1-based, inclusive). Uses exact page text when `precise_pages` is available; otherwise approximates the character range proportionally.

**Document mode** (neither argument): Returns a truncated head of the document with a notice prompting use of `query` or `page_range` for targeted retrieval.

In all modes, `max_chars` caps total returned text (default 12000, max 100000). A single passage is never split, so one passage may slightly exceed the cap.

### Page locators

By default, page numbers are **approximate** (`pageApprox`): a proportional estimate derived from the character offset divided by the total character count, clamped to 1-based page numbers. This requires only the Zotero cloud full-text index.

Pass `precise_pages: true` to re-extract the PDF for **exact** page numbers. This:
1. Downloads the attachment bytes from the cloud API.
2. Lazily imports the optional `pdfjs-dist` dependency (declared as an `optionalDependency`).
3. Extracts per-page text and locates each passage.

If the PDF bytes are unavailable or `pdfjs-dist` is not installed, the tool **degrades to approximate pages** and sets `pageSource: "approximate"` with a notice in `structuredContent.notice`. It never throws — the degrade is transparent.

Install the optional dependency for exact pages:
```bash
npm i pdfjs-dist
```

### Read-only mode

`zotero_get_fulltext` is annotated `readOnlyHint: true` and remains available under `ZOTEUS_READ_ONLY=true`.

---

## `zotero_tag_audit` — audit tags against a controlled vocabulary

Audit a Zotero library's tags against a controlled vocabulary with optional required tiers.

### Vocabulary schema

Supply inline as `vocabulary` (a JSON object) or as a JSON file path via `vocabulary_path`:

```json
{
  "tags": [
    { "name": "machine-learning", "tier": "topic" },
    { "name": "RQ1", "tier": "subquestion" }
  ],
  "tiers": [
    { "name": "topic", "required": true },
    { "name": "subquestion", "required": false }
  ]
}
```

- `tags[].name` — canonical tag name.
- `tags[].tier` — optional tier membership (used for the missing-tier report).
- `tiers[].name` — tier name.
- `tiers[].required` — if `true`, every item must have at least one tag from this tier.

### Reports

The tool produces three reports:

1. **Off-taxonomy tags** (`offTaxonomy`): library tags that are not in the vocabulary. Zotero automatically-applied tags (`meta.type === 1`, e.g. PDF keyword extraction) are bucketed separately as `autoTags` rather than flagged as off-taxonomy — unless `include_auto: true` is passed, in which case they are included in `offTaxonomy`.

2. **Missing required tiers** (`missingByTier`): for each required tier, the items that have no tag belonging to that tier. Each entry lists `tier`, `itemCount`, and a capped list of `items` (key + title).

3. **Per-collection coverage** (`collections`): pass `scope.collection_keys` with an array of collection keys to run the missing-tier analysis scoped to each collection separately.

### Other options

- `limit` — caps the number of items listed per report entry (default 50, max 500). Does not limit the tag or item enumeration — all are scanned.
- `include_auto` — treat Zotero auto-applied tags as off-taxonomy too.
- `library_type` / `library_id` — target a group library.

Tags and items are enumerated via the cloud Web API with automatic pagination.

### Read-only mode

`zotero_tag_audit` is annotated `readOnlyHint: true` and remains available under `ZOTEUS_READ_ONLY=true`.

---

## `zotero_export format:"better-biblatex"` — Better BibTeX export

`zotero_export` now accepts `format: "better-biblatex"` in addition to all existing formats.

### Built-in `biblatex` vs `better-biblatex`

| Format | Route | BBT options | Availability |
|---|---|---|---|
| `biblatex` | Zotero cloud Web API (stock translator) | Not available | Always (cloud) |
| `better-biblatex` | Local desktop Better BibTeX plugin | Your configured BBT options apply | Desktop-local only |

**`biblatex`** uses Zotero's stock cloud translator. BBT-specific features (citation-key generation rules, sentence-case handling, `biblatexExtendedNameFormat`, unicode→LaTeX transliteration, and any BBT export options you have configured) are **not** available.

**`better-biblatex`** uses the Better BibTeX plugin running in your desktop Zotero instance at `http://127.0.0.1:23119/better-bibtex`. It requires:
- Desktop Zotero running locally.
- The [Better BibTeX for Zotero](https://retorque.re/zotero-better-bibtex/) plugin installed.

When `better-biblatex` is requested but Better BibTeX / desktop Zotero is unavailable (e.g. the hosted cloud connector, or Zotero is not running), the tool **degrades to the built-in `biblatex`** stock translator and includes a notice in the response. `structuredContent.degradedToBuiltIn` is set to `true`.

`better-biblatex` requires explicit `item_keys`; whole-library or query-based exports fall back to built-in `biblatex`.

---

## `zotero_list_tags` and `zotero_list_collections` — read-only listing tools

Two new read-only tools surface information that was previously only accessible through the mutating `zotero_manage_tags` and `zotero_manage_collections` tools.

### `zotero_list_tags`
Lists tags in a Zotero library with usage counts and an `auto` flag (`true` for Zotero-applied tags, `false` for manual). Supports an optional `q` substring filter and `limit`. Available under `ZOTEUS_READ_ONLY=true`.

### `zotero_list_collections`
Lists collections with key, name, parent collection key, and item count. Optional `top: true` returns only top-level collections. Collection keys can be passed to `zotero_search_items` (`collectionKey`) or `zotero_tag_audit` (`scope.collection_keys`). Available under `ZOTEUS_READ_ONLY=true`.

---

## Read-only mode summary

Under `ZOTEUS_READ_ONLY=true`, the following M12 tools remain available:

| Tool | Purpose |
|---|---|
| `zotero_get_fulltext` | Retrieve PDF passages |
| `zotero_tag_audit` | Audit tag vocabulary |
| `zotero_list_tags` | List tags with usage/auto flag |
| `zotero_list_collections` | List collections |
