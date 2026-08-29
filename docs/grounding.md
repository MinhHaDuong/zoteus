# Full-text grounding, tag audit, and BBT export

Zoteus adds tools for research grounding: retrieve PDF passages with page locators, audit tag hygiene against a controlled vocabulary, and export with Better BibTeX formatting.

## `zotero_get_fulltext` — retrieve PDF text for grounding

Retrieve the full text of a PDF or EPUB attachment for use as grounding context. Pass either:
- A **parent item key**, whose best child attachment is resolved automatically (a PDF first, then an EPUB, then whatever else is attached).
- An **attachment key** directly — returned as-is.

### Retrieval modes

One of four modes is selected based on the arguments:

**`query` mode** (pass `query`): Returns the top-k passages most relevant to the query, ranked by an ephemeral BM25 index (fused with vector re-ranking when an embedder is configured). Each passage carries:
- `charStart` / `charEnd` — inclusive/exclusive character offsets in the source text.
- `section` — nearest preceding section heading (best-effort).
- `pageApprox` — proportional page estimate (1-based), or `page` (exact) when `precise_pages` succeeds.
- `score` — BM25 score.
- `max_passages` caps the number of passages returned (default 5, max 20).

**`page_range` mode** (pass `page_range`, e.g. `"3-7"`): Returns the text for the specified page span (1-based, inclusive). The PDF is re-extracted so the span is the real one, which is what makes reading a long document page by page practical; asking for "page 5" and getting a proportional slice of the character stream answers a different question. Pass `precise_pages: false` to opt back out and take the proportional slice of the indexed text (no file read at all). When exact extraction is not possible the tool degrades to the proportional slice with a notice, exactly as `precise_pages` does.

**`outline` mode** (pass `outline: true`): Returns the PDF's own table of contents instead of text. See [PDF outline](#pdf-outline-table-of-contents) below.

**Document mode** (no argument): Returns a truncated head of the document with a notice prompting use of `query` or `page_range` for targeted retrieval.

In all text modes, `max_chars` caps total returned text (default 12000, max 100000). A single passage is never split, so one passage may slightly exceed the cap.

### Page locators

By default, page numbers are **approximate** (`pageApprox`): a proportional estimate derived from the character offset divided by the total character count, clamped to 1-based page numbers. This requires only the Zotero cloud full-text index.

Pass `precise_pages: true` to re-extract the PDF for **exact** page numbers (`page_range` already does this without the flag). This:
1. Reads the attachment bytes, from the running Zotero desktop app, the local Zotero storage folder, or the cloud API, in that order (see [Where the file bytes come from](#where-the-file-bytes-come-from)).
2. Lazily imports the optional `pdfjs-dist` dependency (declared as an `optionalDependency`).
3. Extracts per-page text and locates each passage.

If the PDF bytes are unavailable or `pdfjs-dist` is not installed, the tool **degrades to approximate pages** and sets `pageSource: "approximate"` with a notice in `structuredContent.notice`. It never throws — the degrade is transparent.

Install the optional dependency for exact pages:
```bash
npm i pdfjs-dist
```

### PDF outline (table of contents)

Pass `outline: true` to get the PDF's own bookmark tree instead of its text:

```jsonc
{
  "mode": "outline",
  "fileSource": "local-api",
  "outline": [
    { "title": "Introduction", "page": 1, "level": 0 },
    { "title": "Related work", "page": 3, "level": 0 },
    { "title": "Anchoring", "page": 4, "level": 1 }
  ],
  "entries": 3
}
```

- `level` is the nesting depth (0 for a top-level heading, 1 for its children).
- `page` is the 1-based page the heading points at. A heading whose destination cannot be resolved is still listed, without a page.
- The outline is read from the file itself and never touches Zotero's full-text index, so it works for an attachment added a minute ago.
- A PDF with no bookmarks returns `outline: []` and a notice, not an error. An EPUB is refused with a pointer back to plain-text mode.
- At most 500 headings are returned (`truncated: true` says when a longer tree was cut).

Reading the outline first and then asking for the pages it names is the cheap way to work through a long document: two small calls instead of one call that returns a book.

### Unindexed attachments: local extraction fallback

`zotero_get_fulltext` normally serves text from Zotero's full-text index. When an attachment has **not been indexed yet** (no stored full text), the tool reads the file itself and extracts the text locally:

- **PDF** via the same `pdfjs-dist` parser used for exact pages, with `fulltextSource: "pdf"` and **exact** page locators (`pageSource: "exact"`).
- **EPUB** via a dependency-free reader (an EPUB is a zip of XHTML: Zoteus unpacks it with `node:zlib`, follows the package document's spine so the chapters come back in reading order, and strips the markup), with `fulltextSource: "epub"`. An EPUB reflows and has no fixed pages, so `page_range` does not apply to one and says so rather than inventing a span.
- The response is served exactly like indexed text: `query`, `page_range` and document modes all work, and `fulltextSource` plus `fileSource` tell a caller that this text was extracted locally rather than read out of Zotero's index.
- The fallback is on by default; pass `fallback: false` to opt out (the tool then returns an actionable "not indexed" error).
- Same OOM guard as `precise_pages`: attachments larger than 20 MB are not parsed; the error tells you to open the file once in Zotero to index it.
- Scanned/image-only PDFs yield no text: the error explains that extraction found nothing.

This is what makes "summarise the paper I just added" work. It covers libraries where many PDFs were never indexed, and grounding no longer waits for Zotero to re-process anything.

### Where the file bytes come from

Everything that reads the attachment file itself (the fallback above, `precise_pages`, `page_range`, `outline`, and `zotero_annotate`'s passage anchoring) tries three sources in order, and reports the one that answered as `fileSource`:

| `fileSource` | Source | Reaches |
|---|---|---|
| `local-api` | The running Zotero desktop app (`/items/<key>/file`, which answers a `file://` redirect into its data directory) | Everything Zotero holds, including unsynced attachments and libraries with no storage quota. No cloud key. |
| `storage` | `<Zotero data dir>/storage/<attachment key>/` read straight off disk | The same files **while Zotero is closed**, as long as Zoteus shares the machine. No cloud key, no desktop app. |
| `cloud` | The Web API file download | Anything that has synced, from anywhere. Needs `ZOTERO_API_KEY` with file access. |

The storage folder defaults to `~/Zotero` (`%USERPROFILE%\Zotero` on Windows). Zotero lets you move it, and the moved path lives in the app's own preferences where Zoteus cannot see it, so set `ZOTERO_DATA_DIR` if yours is elsewhere. A directory that is not there is skipped silently, so a hosted Zoteus loses nothing by looking.

When no source can produce the file, the error names each one it tried and why it could not answer, rather than reporting only the last failure.

### Where the indexed text comes from

Zotero's stored full text is read through the library router, not the cloud alone: a running desktop app (Zotero 7+) serves the `/fulltext` endpoints itself, so grounding works with **no cloud API key**, and for items that never synced. Group libraries, and everything when the app is closed, go to the cloud Web API.

The same text feeds the opt-in full-text pass of the semantic index, so a passage found by `zotero_semantic_search` (marked `source: "fulltext"`) can be re-fetched here with a page locator. See [`semantic-search.md`](./semantic-search.md#full-text-indexing-opt-in).

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

Under `ZOTEUS_READ_ONLY=true`, the following tools remain available:

| Tool | Purpose |
|---|---|
| `zotero_get_fulltext` | Retrieve PDF passages |
| `zotero_tag_audit` | Audit tag vocabulary |
| `zotero_list_tags` | List tags with usage/auto flag |
| `zotero_list_collections` | List collections |
