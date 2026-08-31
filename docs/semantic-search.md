# Hybrid semantic search

M6 adds local-first hybrid retrieval: BM25 keyword scoring fused with vector similarity (Reciprocal Rank Fusion), with results that cite the matching item and a snippet.

## Tools

### `zotero_index` — manage the index
The build runs **asynchronously on the server** so the tool call returns immediately and
can never time out the MCP client, even on very large libraries.

- `action: "build"` / `"refresh"` start a **background job** that rebuilds the whole
  index: it pages the library's top-level items (100-at-a-time, stopping at
  `ZOTEUS_INDEX_MAX_ITEMS`, **5000 by default**, or at a smaller `limit`) and indexes
  their text (title, abstract, creators, tags) for BM25, plus vector embeddings if an
  embedder is configured. Returns at once; **poll `action: "status"`**
  every few seconds until `state` is `done` (or `error`). Calling build again while one
  is running does **not** start a second build — it returns the current progress.
  The two differ in one thing only: `build` **resumes** a build that was interrupted, where
  one is on disk, while `refresh` always starts from scratch. See
  [Resuming an interrupted build](#resuming-an-interrupted-build).
- `action: "update"` re-indexes only what changed since the last build, and drops what the
  library no longer holds. This is the cheap one; see
  [Updating the index](#updating-the-index).
- `action: "status"` — live progress and index size. Reports
  `state` (`idle` | `building` | `done` | `error`), `operation` (`build` | `update`),
  `itemsFetched` / `itemsTotal`, `itemsRemoved`,
  `itemsAvailable` (what the library holds, before the cap; larger than `itemsTotal`
  exactly when the build was truncated), `passages`, `vectors`, `items`, the
  **effective** `embedder`, `libraryVersion` / `libraryBackend` (the version stamp an
  update diffs from), `fulltextVersion` (how far into Zotero's separate full-text sequence
  the index has read, see [Text extracted after the
  build](#text-extracted-after-the-build)), `resumedFrom` (items inherited when a build
  resumed an interrupted one), `updateNotice` (what the last update did, or why a rebuild
  replaced it), `localApiDegradedAt` (present only when this job saturated Zotero's local
  API and the session fell back to the Web API; see [Full-text
  indexing](#full-text-indexing-opt-in)), and `lastError` when
  `state` is `error`. Backward-compatible fields (`documents`, `vectors`, `items`,
  `embedder`, `builtFromVersion`) are still present. Progress is also logged on the
  server (every 500 items / 10s).
  `embedder` is what is *actually* producing vectors, not what was requested: three extra
  fields split the two apart, so a keyword-only index always explains itself.
  | Field | Meaning |
  |---|---|
  | `embedderConfigured` | the `ZOTEUS_EMBEDDINGS` value that was asked for |
  | `embedderModel` | the model it embeds with (`ZOTEUS_EMBEDDING_MODEL`), when it names one |
  | `embedderActive` | `true` only while that provider is genuinely embedding |
  | `embedderReason` | present when it is not: why, and what to do about it |
  | `vectorsStaleReason` | present when stored vectors were dropped because another model had produced them (see [Tuning API embeddings](#tuning-api-embeddings)) |

  Three more fields describe the store rather than the embedder: `storage` (`sqlite` or
  `memory`, see [Storage backends](#storage-backends)), `storageNotice` (present when
  opening it imported a JSON index, or refused to), and `persistError` (present when the
  index could not be written). Two more describe how the last semantic query ranked
  vectors: `vectorScan` (`codes` or `exact`) and `vectorScanNotice`, see
  [Two-stage vector search](#two-stage-vector-search).
- `action: "stop"` cooperatively cancels a running job. A build halts between
  pages/batches and the partial index is kept and stays searchable; it also leaves a
  checkpoint, so the next `action:"build"` carries on from it rather than starting over. A
  stopped **update** keeps what it applied but leaves the version stamp where it was, so the
  next update simply repeats the delta.
- `limit` — optional max number of items to index. It lowers the configured cap for one
  build and can never raise it: the build stops at the lower of `limit` and
  `ZOTEUS_INDEX_MAX_ITEMS` (default 5000).
- `own_words` — index your own child notes and PDF annotations (see
  [Your own notes and annotations](#your-own-notes-and-annotations) below). Defaults to
  `ZOTEUS_INDEX_OWN_WORDS` (on).
- `fulltext` — also index the body text of each item's attachments (see
  [Full-text indexing](#full-text-indexing-opt-in) below). Defaults to
  `ZOTEUS_INDEX_FULLTEXT` (off).
- `fulltext_max_chars` — cap on indexed full-text characters per item; `0` means no cap.
  Defaults to `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` (40000).

**Local-first, key-free.** The build pages items through the library router, exactly like
every other read: a running Zotero desktop app serves them from its **local API** (no
cloud API key required), for your personal library and, on Zotero 10+, for any group
library the app holds. The cloud **Web API** takes over when the app is closed, and for a
group library this desktop does not hold. Item keys are identical on both backends, so an
index built against the desktop app stays valid when a later lookup goes to the cloud,
and the index file is keyed by the Zoteus data dir (plus the authenticated user in
multi-tenant mode), never by the library id the read happened to use.

**One index file, one library.** Because the file is keyed by the data dir, a build for a
*different* library than the one the index holds would silently erase it — or, where an
interrupted build left a checkpoint, resume into it and leave one file holding two
libraries' rows. The index
therefore stamps the library it was built for (the personal library counts as one library
however it is addressed, `users/0` or by user id), and a build or update for another one
refuses up front, naming both. To index a second library, run Zoteus with its own
`ZOTEUS_DATA_DIR` for it — or delete the index file to hand the data dir over.

**Incremental, crash-safe persistence.** Partial progress is persisted as the build runs
(roughly every 200 items or 10s), so a timeout, crash, or `stop` can never leave a corrupt
index: the JSON backend writes to a temp file and renames over the target, the SQLite one
commits a transaction (see [Storage backends](#storage-backends)). What was persisted is
what loads on the next startup, and it is fully queryable (BM25 keyword search works on
whatever was indexed). A build that could **not** be written says so: `persistError` is
reported by `zotero_index action:"status"` and repeated in every `zotero_semantic_search`
summary, because a build whose artifact never reached disk still reports `state: "done"`.

### `zotero_semantic_search` — search by meaning
- `q` — natural-language query. `mode`: `auto` (hybrid, default), `keyword` (BM25), or `semantic` (vector).
- Returns ranked items with a snippet and fused score. The index is built automatically on first use (see `auto_build` below), or ahead of time with `zotero_index`.
- `auto_build` (default `true`) — when the index is empty the tool starts a background build itself and tells you to poll `zotero_index` action:"status" until `done`, then retry, instead of returning a bare error; pass `auto_build: false` to opt out.
- `mode: "semantic"` ranks by vectors alone, so with **0 vectors** in the index it returns an
  explicit error naming the cause (missing embedder, or an index built before one was
  available) rather than an empty hit list, which would be indistinguishable from "your
  library has nothing on this". `auto` and `keyword` keep working on BM25; `auto` appends a
  one-line notice when vector ranking is off.
- Snippets are query-centred and trimmed to word boundaries: the excerpt is positioned around the first query token hit rather than always taken from the document head, so the relevant phrase appears in the snippet even when it occurs deep in the abstract.
- A hit whose snippet came from a PDF body rather than the item's metadata is marked
  `source: "fulltext"`, so the caller knows the passage is quotable and can fetch it with
  a page locator via `zotero_get_fulltext`.

For exact field/tag/itemType filtering, use `zotero_search_items`. Use semantic search for conceptual "papers about X" queries.

## Updating the index

A library changes by a handful of items at a time; rebuilding it from scratch to absorb
that is the wrong shape of work. `zotero_index action:"update"` re-indexes **only what
moved**:

```jsonc
{ "tool": "zotero_index", "action": "update" }
```

**What it does.**

1. Reads the **version stamp** the last build or update recorded: Zotero's
   `Last-Modified-Version` for the library, plus which API issued it
   (`libraryVersion` / `libraryBackend` in `status`).
2. Pages `?since=<stamp>` for the items that changed after it, and upserts each one:
   the item's old passages, vectors and keyword rows are removed, then it is re-chunked,
   its attachment full text re-fetched if `fulltext` is on, and its new passages embedded.
   **Untouched items are never re-chunked and never re-embedded**, which is where the
   saving comes from.
3. Reconciles deletions by diffing its own item keys against a
   `?format=versions` census of the library (keys and versions only, no item bodies).
   The `/deleted` endpoint is cloud-only, so a key-set diff is the only way this works
   against the desktop app too. A deleted item takes its passages, its vectors and its
   FTS5 rows with it.
4. Asks Zotero's **full-text sequence**, a second and independently numbered one, what
   it has extracted since the cursor the index stored, and indexes the new body text
   through the same attachment-to-parent map a build uses. One request when nothing was
   extracted. See [Text extracted after the build](#text-extracted-after-the-build).
5. Advances both cursors **only after all of that succeeded**, and persists once.
   On SQLite the whole update is one transaction: a failure rolls back to the last good
   state rather than leaving an index that is half fresh. On the JSON backend nothing is
   written until the update succeeds, so the file on disk stays the last good one (the
   in-memory copy can be partially refreshed until the next restart, and `updateNotice`
   says so instead of claiming a rollback).
   Either way the stamp does not move, and the next `update` simply repeats the delta.

**When it falls back to a full rebuild.** An update is refused whenever a delta would be
*wrong* rather than merely stale. The fallback is never silent: the rebuild starts
immediately and `updateNotice` (repeated in the `status` summary) says which case it was.

| Condition | Why a delta cannot work |
|---|---|
| No version stamp | An index built before 1.7, imported from an older JSON file, or left by a cancelled build, covers an unknown slice of the library. The rebuild it falls back to **resumes** that cancelled build rather than starting over, see [Resuming an interrupted build](#resuming-an-interrupted-build). |
| The serving backend changed | The desktop app and the cloud number their library versions independently, so a stamp from one names a different point in the other's sequence. Closing Zotero between runs is enough to trigger this. |
| The embedding model changed | Only the changed items would come back with vectors in the new space; the rest would be ranked against a foreign one. (Same rule as [Changing the model](#tuning-api-embeddings).) |
| The store cannot delete rows | Deleted items could never leave the index. Both shipped backends can, so this is a guard for future stores. |
| The census came back empty | Treated as a failed read, not an emptied library: deletions are skipped, the stamp is withheld, and `updateNotice` says so rather than erasing the index. |

### Text extracted after the build

Zotero numbers extracted full text on a sequence of its **own**, unrelated to item
versions. Opening a PDF for the first time makes Zotero extract it and touches no item
version at all, so that item appears in no `?since=` delta, ever. An update that keyed
everything on the item version therefore left the index's full-text coverage frozen at
build time, with a full rebuild as the only remedy.

So a build records a second cursor beside the version stamp (`fulltextVersion` in
`status`, the highest version in the `/fulltext?since=0` census it consumed), and an update
asks `/fulltext?since=<that cursor>` for what has been extracted since. New text is
attached to its parent item through the same attachment map the build uses, replacing that
item's body passages and leaving its metadata ones alone. `updateNotice` counts them
separately, because they are a different question answered by a different sequence: *"N
unchanged item(s) gained newly extracted attachment full text."*

- **On a library where nothing was extracted, this costs one request.** The probe comes
  first and on its own; only a non-empty answer is worth building the attachment map.
- **The cursor advances only when the update fully succeeded**, under the same rule as the
  version stamp, so a failed update repeats the catch-up rather than skipping past it.
- **An index written before 1.10 has no cursor.** The first update that wants full text
  cannot tell which text is new, so it catches up its **coverage gap** instead: the items
  holding no body passages at all. That runs once, because the same update stores a real
  cursor. An index that holds no body text at all is left alone entirely: turning
  `action:"update"` into the hours-long full-text crawl that was never asked for is not an
  update. Run `action:"build"` with `fulltext:true` for that.
- **`fulltext` must be on for the update too.** An update not asked for full text never
  consults the other sequence at all.

### Resuming an interrupted build

A build stopped by `action:"stop"`, a crash or a restart used to be lost work: the only
progress a build recorded was the version stamp, which is deliberately **withheld** from a
build that did not finish (it covers an unknown slice of the library), and the desktop
local API commonly answers with no version at all. So the next build cleared the store and
crawled from 0 over items it had already fetched, chunked and paid to embed.

A build now commits a **checkpoint** (the crawl offset, the pass it was in, the library
totals it saw, the API that served it, the embedder identity, and the handful of passages
queued but not yet embedded) in the same write as the rows it describes. `action:"build"`
finds it and carries on:

- Everything already committed stays searchable throughout, and is never re-fetched,
  re-chunked or re-embedded. What gets redone is bounded by the last save (200 items / 10s
  on the metadata pass, 500 items / 60s on the full-text one).
- The resume point is a stored offset, not a search for one: no scan of the index, and the
  first request asks for the item after the last one committed.
- The stored offset is **verified** against the library's own totals on the first page it
  reads, since Zotero pages items newest-modified-first and one edit made while Zoteus was
  down shifts everything down by one. If they disagree, the crawl walks the library from
  the top again and steps over what the index holds by key: pages, never re-embedding.
- The full-text pass resumes on the same principle: items whose body text is already
  indexed are skipped, so no PDF is read twice.
- A resumed build stamps the library version the **interrupted** crawl began from, so
  anything modified in between is still waiting for the next `action:"update"`.
- It refuses to resume under a different embedding model: two vector spaces in one index is
  exactly what an update is refused over, and a resume must not create it by the back door.
- `status` reports `resumedFrom` (the items inherited), and `updateNotice` says outright
  that a resume is what started.

`action:"refresh"` is the one that always starts over: same crawl, checkpoint discarded.
That is the only behavioural difference between the two actions.

**The item cap still applies.** An update maintains the subset the index already holds: an
item already indexed is refreshed however full the index is, a *new* one only while there
is room under `ZOTEUS_INDEX_MAX_ITEMS` (or `limit`). If the previous build was truncated,
`updateNotice` says that the items the cap left out stay unindexed until a full
`action:"build"` covers them.

**Cost.** Measured shape rather than a benchmark, because the ratio is what matters: an
update's work is proportional to the *delta*, a build's to the *library*.

| | items fetched | passages embedded | requests |
|---|---:|---:|---:|
| `action:"build"`, 5000-item library | 5000 | all of them | 50 item pages (+ full-text reads) |
| `action:"update"`, 7 items changed | 7 | 7 items' worth | 1 item page + 1 census page |

With `ZOTEUS_EMBEDDINGS=openai` that is the difference between re-embedding the whole
library and embedding seven items: minutes and real API spend against seconds and
almost none. Rebuild when the model changes, when you raise the cap, or when the index is
new; update the rest of the time.

## Your own notes and annotations

The index covers the words **you** wrote, not only the ones you collected. Every child
note, and every PDF annotation — its highlighted passage together with your comment on it —
is indexed as an extra passage carrying the **parent item's** key:

```jsonc
// on by default; this is how you turn it off for one build
{ "tool": "zotero_index", "action": "build", "own_words": false }
```

```bash
# or for every build
ZOTEUS_INDEX_OWN_WORDS=false
```

A hit whose snippet came from one is marked `source:"note"` or `source:"annotation"`, so
you can tell your own objection from the abstract it was written against. Because the
passages carry the item's key, an item with forty annotations is still **one** search
result rather than forty: your own words extend what an item can be found by instead of
crowding the page.

This is on by default where full text is not, and the reason is cost. The whole corpus is
one paged crawl of the library's child items (`itemType=note || annotation`, a page per
hundred children, text included in the response) plus one batched lookup per fifty
annotated attachments — an annotation names the attachment it sits on, never the item that
attachment belongs to, so that hop is what attributes it. On a library of 280 items with
606 notes and annotations that is a handful of requests, where the attachment crawl behind
full text is orders of magnitude more. Notes are stored as HTML and indexed as text, so
markup never reaches a snippet, and a standalone note is left to the metadata crawl that
already indexes it.

**`zotero_annotate` and search now agree.** Before this, Zoteus could write an annotation
onto an attachment and then never find it again, on any query: the crawl asked for
top-level items, and an annotation is not one.

**Staying current costs one request.** Notes and annotations are ordinary items carrying
ordinary versions in the library's own sequence, so `action:"update"` asks one keys-only
question (`?format=versions&itemType=note || annotation`) and compares the answer against
the note and annotation keys the index already holds. That finds all three shapes of
change at once: an edit (a version past the stamp), an addition (a key the index has no
passage for) and a **deletion** — the one no `?since=` can ever report, because deleting a
note moves no version anywhere in Zotero. The crawl that reads note bodies is opened only
when there is something to re-index, so an update over a library nobody has annotated
since costs exactly that one request. An index built before this existed fills its gap on
its first update, once, and says so in `updateNotice`.

## Full-text indexing (opt-in)

By default the index covers item **metadata**: title, abstract, creators, tags, date,
publication. That finds papers, but it cannot find a claim that only ever appears on page
9 of a PDF. Turning full text on adds each item's attachment body as extra passages:

```jsonc
// per build
{ "tool": "zotero_index", "action": "build", "fulltext": true }
```

```bash
# or as the default for every build
ZOTEUS_INDEX_FULLTEXT=true
```

**What it indexes.** The text Zotero itself extracted when the PDF was first opened, read
from the `/fulltext` endpoints. Attachments Zotero has never extracted are skipped; open
them once in Zotero and rebuild. Unlike `zotero_get_fulltext`, the build does **not** fall
back to reading and parsing the files itself: that would mean fetching and decoding the
whole library. A single unindexed attachment is still readable on demand through
`zotero_get_fulltext`, which extracts it from the file (see
[`grounding.md`](./grounding.md#unindexed-attachments-local-extraction-fallback)).

**Local-first, key-free.** Zotero 7+ serves `/fulltext` from the desktop app, so full-text
indexing works with no cloud API key, exactly like the metadata build. Group libraries (and
everything else when the app is closed) go to the cloud Web API.

**How hard the crawl leans on Zotero.** Body reads run concurrently, and how many at once
depends on which API is serving them: **2** for the desktop app, **4** for the cloud Web
API. The two tolerate load in opposite ways. The Web API is a fleet that answers a burst
with a `429` and a `Backoff` header the fetcher honours, so overshooting costs latency and
nothing else. The local API is one desktop application, sharing a process with Zotero's UI,
its sync engine and its own PDF indexer, and it has no rate limiter: it answers everything
until it cannot. Four continuous body reads were enough to stop Zotero 10 answering on port
23119 at all, 60 to 90 seconds into a 358-attachment crawl. That is worse than a slow build,
because local-API reachability is a session-wide fact: the moment it goes, *every* read and
write falls back to the Web API, which is the slower, rate-limited path the crawl was
avoiding in the first place.

Two things follow. `ZOTEUS_INDEX_FULLTEXT_CONCURRENCY` overrides the number for anyone who
has measured their own machine. And if it happens anyway, the crawl notices and backs off to
one read at a time for the rest of the job, so the app can recover, rather than holding it
down for the hours the crawl has left to run. `zotero_index action:"status"` then reports
`localApiDegradedAt` (an ISO timestamp) and explains, in the summary, that the job fell back
to the Web API and why the rest of it is slower.

**Passages are attributed to the parent item.** A body-text hit is reported as the item
that owns the attachment, with the item's title, and de-duplicated against its metadata
passages, so one paper never floods the result list.

**How it is resolved.** Two library-wide reads, not per-item probing: one
`/fulltext?since=0` call names every attachment that *has* extracted text, and paging
`itemType=attachment` maps each one to its parent. Only that intersection is fetched, so
the number of full-text requests equals the number of attachments that actually have text.

**Cost.** This is the expensive option, which is why it is off by default. Measured on a
212-item library with 151 extracted PDFs:

| | passages | index file (JSON backend) | build (keyword-only, desktop app) |
|---|---:|---:|---:|
| metadata only | 687 | 0.4 MB | 0.2 s |
| `fulltext: true` | 6246 | 7.9 MB | 4.0 s |

Roughly **9× the passages**, which is also how a mid-sized library reaches the JSON
backend's ceiling: full text is the usual reason to be on the SQLite backend (see
[Storage backends](#storage-backends)). Every one of them is also a vector to compute and store, so
with `ZOTEUS_EMBEDDINGS=local` (CPU-bound) the embedding stage grows by the same factor and
dominates the build. Ways to bound it:

- `fulltext_max_chars` / `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` — characters indexed per item
  (default 40000, about 13 pages of dense text; `0` disables the cap). Passages per item
  land near `max_chars / 1200`. In Claude Desktop's settings pane the number input will not
  display a `0` you type, so the field blanks itself and looks like it refused the value; it
  did not, and the server reads it as "no cap" (see
  [`configuration.md`](./configuration.md#desktop-extension-settings-mcpb)).
- `limit` — index fewer items.
- Body passages are chunked at 1200 characters (against 512 for metadata), which keeps the
  vector count down and gives each passage enough context to embed usefully.

Progress and outcome are reported by `zotero_index action:"status"`: `fulltextItems`,
`fulltextPassages`, and `fulltextEnabled`. If full text was requested but produced nothing
(no extracted attachments, or the endpoints were unreachable) the build still completes as
a metadata index and `fulltextReason` says why, rather than looking complete.

**Metadata first, then bodies.** A build runs in two passes, and `status` reports which one
is running as `phase`. The first indexes every item's own text — title, abstract, creators,
tags — across the whole library; only then does the second crawl attachment bodies, tracked
by `fulltextItemsScanned` of `fulltextItemsTotal`. The point is the gap between them: on a
large library the body crawl can run for hours or days, and the library is fully searchable
on its metadata for all of it rather than only at the end. A build stopped during the second
pass therefore leaves complete metadata and partial full text, which is worth knowing before
you decide whether to resume it.

The version stamp an `action:"update"` diffs against is written only when *both* passes have
finished. A build interrupted during the body crawl is deliberately left unstamped, because
a stamp would make the next update skip every item whose attachments were never read: those
items are unchanged in Zotero, so they would appear in no delta, ever. The checkpoint is
what such a build leaves instead, and `action:"build"` picks the body crawl up from it: see
[Resuming an interrupted build](#resuming-an-interrupted-build).

## Storage backends

Where the index lives is set by **`ZOTEUS_INDEX_BACKEND`**:

| Value | Behaviour |
|---|---|
| `auto` (default) | SQLite when the runtime provides `node:sqlite` (**Node 22.13+**), otherwise the JSON file, with one info line on startup saying so. |
| `sqlite` | Require SQLite. On a Node without `node:sqlite` the server **fails to start** rather than quietly falling back to the backend with the ceiling. |
| `memory` | The legacy in-memory index persisted as one JSON file. |

**Why there are two.** The JSON backend keeps every passage and vector in JS memory and
saves them with a single `JSON.stringify`. That string cannot exceed V8's maximum length
(~512 MB), so past roughly 250k passages the index can no longer be saved, and a file
anywhere near that size can no longer be *read* either: a 463 MB `search-index.json` needs
about 5.4 GB of heap to parse and OOMs stock Node. Measured on the same 7540-item library
(issue #10):

| | build | resident memory | query | reload |
|---|---:|---:|---:|---|
| JSON (`memory`) | 337 s | 5370 MB | 370-500 ms | re-parses the whole file |
| SQLite (`sqlite`) | 46.6 s | 162 MB | 1-76 ms | opens the file |

The SQLite backend stores passages in an **FTS5** table (`unicode61 remove_diacritics 2`,
ranked with `bm25()`) and vectors as per-passage `BLOB`s, so a keyword search reads only
the rows it ranks and never materializes the library. The semantic path used to be the one
that grew with the library, because it read every vector; it now reads a binary code per
vector instead and fetches the float32 vectors of a few hundred candidates. See
[Two-stage vector search](#two-stage-vector-search).

**Diacritics.** Searches are diacritics-insensitive in both directions and on both
backends: `Bronte` finds `Brontë` and `Brontë` finds `Bronte`. The document side of the
FTS5 index is folded by SQLite (`remove_diacritics 2`); the query side is folded in JS by
`tokenize.ts`, which is also what the JSON backend tokenizes with, so the two agree by
construction. The JS fold deliberately reproduces `unicode61` and no more — `ø œ æ ł đ ð
þ ß` are letters to unicode61 rather than accented forms, so they are letters here too,
and `søren` does not answer to `soren`.

**Where the files are.** `<ZOTEUS_DATA_DIR>/search-index.sqlite` beside the older
`search-index.json` (and `search-index-<userId>.*` per tenant in multi-tenant mode). SQLite
also writes `-wal` and `-shm` sidecar files while the database is open; a clean shutdown
folds them back in. On-device model weights are cached under `<ZOTEUS_DATA_DIR>/models`,
so removing the data directory removes everything the index ever wrote.

**If the index is damaged.** A search index that cannot be read no longer stops the server
from starting: it is a derived cache, and no other tool reads it, so item lookups,
bibliographies, attachments and citations carry on working. Search alone refuses, and says
why.

To repair it, call `zotero_index` with `action:"build"`. That call — and only that call —
deletes the unreadable file and its write-ahead sidecars, opens a fresh index in their
place, and rebuilds in the background. Asking for a build is what makes the deletion
consented to: nothing repairs the index at startup or inside a query, because a rebuild
re-reads the whole library and takes minutes to tens of minutes, which is not a job to
begin without being asked. `action:"update"` refuses and points you here, since a delta
needs the index it cannot read. If the files cannot be deleted — another Zoteus is holding
them, or they are read-only — the message falls back to naming them for `rm`.

Deletion rather than truncation is deliberate: the version stamp lives inside the same
database, so a repair that dropped the passages and kept the stamp would leave an empty
index reporting itself as up to date. Removing the file removes the stamp with it.

The same applies to a `search-index.json` that cannot be parsed. It used to load as an
*empty* index, which reads exactly like a library holding nothing — and, because loading
resets before it parses, the next clean shutdown wrote that emptiness back over the file.
A JSON artifact that fails to parse is now refused, left untouched on disk, and repaired by
the same `action:"build"`.

**An older schema version is upgraded in place.** When Zoteus bumps the index schema, a
database stamped with an earlier version of *this* schema is migrated where it lies: the
ladder of upgrade steps runs inside one transaction with the new stamp, so the file is
either fully upgraded or fully unchanged, and nothing is re-crawled or re-embedded.
`storageNotice` says what moved it forward. A step that fails rolls the whole thing back
and the database is moved aside instead, exactly as an unmigratable one is.

**A database from an unreachable schema version is moved aside, never written into.** The
schema stamp is read before anything touches the file. A database stamped with a version
this build cannot reach — one written by a newer Zoteus after a downgrade, a file with no
stamp at all, or a version no ladder covers — is renamed to
`search-index.sqlite.incompatible-<timestamp>` (its write-ahead sidecars with it, nothing
deleted), a fresh index is created in its place, and `storageNotice` says what moved and
where. The moved file stays a complete database, readable by the build that stamped it;
rebuild with `zotero_index action:"build"`, and a later re-upgrade finds the moved file
intact.

**A sideline hands its vectors to the rebuild that replaces it.** The expensive half of a
rebuild is not the crawl but the embedding — hours of local CPU on a large library, or real
spend on a hosted provider — and none of that cost is inherent: an embedding is a function
of the passage text and the model, neither of which a schema change touches. So the
moved-aside database stays open as a read-only vector source, and every passage the rebuild
re-reads with the same id and byte-identical text takes its vector from there instead of
being embedded again. Only genuinely new or edited text costs embedding time. The reuse is
refused outright when the embedder has changed (`embedderId` covers provider *and* model),
and `storageNotice` prices the rebuild either way: how many passages must be re-indexed, how
many vectors that involves, and whether they have to be paid for.

**Migration is automatic and lossless.** The first time the SQLite backend opens a data dir
that holds a `search-index.json` and no database, it imports the JSON index and leaves the
file exactly where it was (a downgrade to an older Node still finds it). If the JSON file is
larger than **200 MB** it is *not* parsed, because that parse is the failure mode described
above: nothing is imported, the file is left alone, and `zotero_index action:"status"`
reports the reason and asks for one `action:"build"`. Either way the outcome is in
`storageNotice`, never silent.

**One warning line on stderr.** Node 22 LTS prints
`ExperimentalWarning: SQLite is an experimental feature and might change at any time` the
first time the module loads. It comes from Node, not from Zoteus, and stdio clients are
unaffected (the MCP stream is stdout).

## Two-stage vector search

A semantic query used to read every stored vector: on a 255,703-passage index at 3072
dimensions that is 3.1 GB decoded and multiplied per query, and it took **90 to 105
seconds** whatever was asked (issue #30). The cost was never the store, it was the bytes:
number of vectors x bytes per vector x cost per byte, and at 3072 dimensions the middle
term is 12,288 bytes a passage.

The SQLite backend now shrinks that middle term. Beside each vector it keeps a **binary
code**: one bit per dimension, set where that coordinate is above the corpus mean, so a
3072-dimensional vector becomes 384 bytes. A query is centred on the same mean, reduced to
the same 384 bytes, and compared against every code by **Hamming distance** (a XOR and a
popcount over `Uint32Array`s, which is cheap enough to do a quarter of a million times).
That first pass produces a *candidate pool*, and only those candidates' real float32
vectors are read and ranked by the exact cosine the full scan used.

Two properties follow, and they are the whole design:

- **Every score you see is exact.** The codes decide which rows get scored, never how they
  rank. The page returned is ordered by exact cosine over real vectors, so scores are
  comparable with anything the full scan produced and no index needs rebuilding.
- **What can be lost is recall, not correctness.** A relevant passage the codes rank
  outside the pool is not seen at all. Measured on real embeddings against the exact
  ranking, a pool of 8x the result set recovered 0.953 of it and 16x recovered 0.986, and
  the codes get *better* as vectors get wider (0.953 at 384 dimensions, 0.997 at 1024),
  because a wider vector makes a longer code. Binary codes with no rescore recovered only
  0.592, which is why the float32 vectors stay in the index.

**This makes queries fast; it does not reclaim disk or memory.** The vectors are still
there, and they must be: the rescore is what buys the accuracy back. The codes are an
addition, about 3% of the size of the vectors they describe.

**Where the codes live.** In the index file, in a `vector_codes` table, beside the corpus
mean they were centred on. They are written by `zotero_index action:"build"` and kept
current by `action:"update"`, which codes the passages it adds and drops the codes of the
items it removes. An index built by an older Zoteus has none: the first semantic query
builds them in one pass over the vectors (the same pass that query was going to make
anyway) and says so in `vectorScanNotice`. Nothing is rebuilt and no re-embedding
happens; the codes are derived from vectors that are already on disk. They are held in
memory while the server runs (dimensions ÷ 8 bytes per passage: about 98 MB for 255k
passages at 3072 dimensions) and dropped whenever the index is written to.

**When it does not apply.** An index with fewer vectors than the candidate pool would
cover is scanned exactly, and gets no codes at all: there is nothing to narrow, and small
libraries were never slow. A build or update in progress also leaves the codes alone, so
queries during a build take the exact path. Whichever path served the last query is
reported by `zotero_index action:"status"` as `vectorScan` (`codes` or `exact`), with
`vectorScanNotice` explaining anything that needs explaining: the fallback, or the
one-time backfill.

| Variable | Default | What it changes |
|---|---|---|
| `ZOTEUS_INDEX_ANN` | `true` | The escape hatch. `false` turns the coded path off entirely: every semantic query scans every vector, exactly as before, and no codes are written. |
| `ZOTEUS_INDEX_ANN_OVERSAMPLE` | `16` | Candidates rescored per vector hit the fusion asks for. Higher is more accurate and slower; the measured recall at 4x/8x/16x was 0.884/0.953/0.986. |
| `ZOTEUS_INDEX_ANN_MIN_CANDIDATES` | `500` | Floor on that pool, so a small `limit` still rescores a real neighbourhood. It is also the size below which an index is simply scanned exactly. |

`bench/two-stage-search.ts` measures both paths over a synthetic index of any shape
(`npx tsx bench/two-stage-search.ts --vectors 255703 --dim 3072`).

## Embedding backends (privacy-first)

Set `ZOTEUS_EMBEDDINGS`:

| Value | Behaviour |
|---|---|
| `local` (default) | On-device embeddings via `@huggingface/transformers` (model `all-MiniLM-L6-v2`). **No data leaves your machine.** |
| `openai` / `gemini` | API embeddings (opt-in; requires `OPENAI_API_KEY` / `GEMINI_API_KEY`; data is sent to the provider). |
| `off` | Keyword-only (BM25). |

### Tuning API embeddings

Three variables tune whichever provider is active, and all three default to today's
behaviour:

| Variable | Default | What it changes |
|---|---|---|
| `ZOTEUS_EMBEDDING_MODEL` | provider default | The model the active **API** provider embeds with: `text-embedding-3-small` (openai) or `text-embedding-004` (gemini). |
| `ZOTEUS_EMBED_BATCH_SIZE` | `32` | Passages per embedding call — one API request, or one local pipeline call. |
| `ZOTEUS_EMBED_BATCH_DELAY_MS` | `0` | Pause between those calls. `0` only yields to the event loop; a positive value sleeps. |

The last two are what a large build is tuned with. An embeddings request is rejected as a
whole when it carries more tokens than the provider accepts (OpenAI answers `400` above
300K tokens per request), and full-text passages, at 1200 characters each, reach that
ceiling far sooner than metadata ones do: lower `ZOTEUS_EMBED_BATCH_SIZE` until a request
fits. `ZOTEUS_EMBED_BATCH_DELAY_MS` bounds the request *rate* instead, which is how a build
of tens of thousands of passages stays under a tokens-per-minute limit rather than being
throttled by the provider.

```bash
ZOTEUS_EMBEDDINGS=openai
ZOTEUS_EMBEDDING_MODEL=text-embedding-3-large
ZOTEUS_EMBED_BATCH_SIZE=16
ZOTEUS_EMBED_BATCH_DELAY_MS=200
```

**Changing the model means rebuilding the index.** Vectors from two models share neither
dimension nor vector space, so comparing them produces scores that look plausible and mean
nothing. Zoteus therefore stores the embedder identity (`openai:text-embedding-3-small`)
alongside the vectors: when the index is loaded under a different one, the stored vectors are
**discarded** and `zotero_index action:"status"` (plus every `zotero_semantic_search`
summary) says so and names the remedy. Keyword search keeps working throughout; run
`zotero_index action:"build"` once to re-embed the library with the new model (an
`action:"update"` refuses for the same reason and rebuilds for you, see
[Updating the index](#updating-the-index)). Index files
written before the identity was recorded carry none and are kept as they are; a switch under
one is caught at the first search instead, where the query vector turns out to be a different
width from the stored ones.

**`local` is opt-in by install** to keep the core package light:

```bash
npm i @huggingface/transformers
```

The first local build downloads the model (~25 MB) once, into
`<ZOTEUS_DATA_DIR>/models` — so deleting the data directory removes the weights along
with the index.

### Why it is not bundled

`@huggingface/transformers` statically imports `onnxruntime-node`, whose prebuilt native
binaries ship for every platform in one package. The resolved tree is **~700 MB installed**
(686 MB measured on Linux x64 against `@huggingface/transformers` 4.2.0; onnxruntime's
per-platform binaries are the bulk of it, with `sharp` and the tokenizers behind them),
against a ~35 MB bundle today. There is no WASM-only shortcut either: the package's Node
entry point imports the native runtime unconditionally, so it cannot be pruned. Shipping it
would mean five per-platform `.mcpb` files of 100 MB+ each, and users picking the right one.

So the `.mcpb` bundle carries **keyword search out of the box**, and local vectors are an
opt-in that lives outside the bundle, in a directory of its own:

```bash
mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps
npm init -y
npm i @huggingface/transformers
```

Then set **`ZOTEUS_TRANSFORMERS_PATH`** to `~/.zoteus-deps/node_modules` (in Claude Desktop:
the extension's **"Local embeddings path"** setting, which wants the absolute path, so
`/home/you/.zoteus-deps/node_modules`) and restart.

**Not `npm i -g`.** Claude Desktop does not run the server with the Node on your `PATH`. It
runs it with its own built-in one, which its `main.log` says out loud:

```
Using UtilityProcess for extension Zoteus: appConfig.isUsingBuiltInNodeForMcp is true and built-in node is compatible
[LocalMcpServerManager] Using built-in Node.js for MCP server: Zoteus
```

So under nvm (or any version manager) `npm root -g` names a directory belonging to a Node
that never executes this server, holding onnxruntime binaries built for that other runtime:
the path resolves nothing, or resolves something that throws on import. Switching or
upgrading the Node version later breaks a path that used to work, silently. A standalone
directory belongs to no version manager and survives both (#38).

Living outside the bundle also means surviving extension updates, which wipe anything
installed *into* the extension folder. The variable accepts a `node_modules` directory, the
package directory itself, or an npm prefix whose modules live under `lib/node_modules`. It
works for npm/Docker installs too, whenever the module lives somewhere the server cannot
resolve on its own.

If local embeddings still do not come up, the diagnosis is in
`zotero_index action:"status"`: `embedderReason` names the directory that was searched, and
a package that resolves but fails to load reports the file it loaded plus the Node version,
platform and architecture it loaded it under, which is the ABI mismatch above spelled out.

### When vector ranking is off

Missing dependency, missing API key, a model download that failed mid-build: in every case
the index still builds and keyword search still works. What changed in **1.4.2** is that
this is no longer silent (it used to be a single stderr line, which desktop clients
discard):

- `zotero_index action:"status"` reports `embedderActive: false` with an
  `embedderReason`, and `embedder` reads `none (local requested; ...)` instead of `local`.
- `zotero_semantic_search` with `mode:"semantic"` returns an **error** explaining why, not
  an empty result set; `auto` mode appends the same notice to its summary.
- `zotero_whoami` reports embedding health alongside identity.

After installing the runtime, run `zotero_index action:"build"` again: an index built
without an embedder stays keyword-only until it is rebuilt.

The index is stored under `<ZOTEUS_DATA_DIR>` and reopened on startup: see
[Storage backends](#storage-backends) for which file that is.

## Large libraries

A few things to know when indexing a big Zotero library:

- **Run on Node 22.13+ so the index goes to SQLite.** It is the difference between a build
  that fits in 162 MB of memory and one that needs 5.4 GB, and past roughly 250k passages
  the JSON backend cannot save the index at all (see
  [Storage backends](#storage-backends)).
- **Local embeddings are CPU-bound.** With `ZOTEUS_EMBEDDINGS=local` the model runs on
  your CPU, so embedding thousands of passages takes real time. If you just want fast
  keyword search, set `ZOTEUS_EMBEDDINGS=off` for a quick keyword-only (BM25) index.
- **First local run downloads the model** (~25 MB) before embedding begins — expect a
  one-time delay (and a slower first build) while it fetches and caches (under
  `<ZOTEUS_DATA_DIR>/models`).
- **Builds stop at `ZOTEUS_INDEX_MAX_ITEMS`, 5000 by default** (both Zotero APIs page
  100-at-a-time). A build that hits the cap reports how many items it left out, in status
  and in every later `zotero_semantic_search` result, so a bigger library never looks
  fully indexed when it is not. Raise the variable to cover it, or pass a smaller `limit`
  to index a subset faster.
- **Build once, then update.** `action: "update"` costs the delta rather than the library
  (see [Updating the index](#updating-the-index)), which on a big library is the
  difference between seconds and ten minutes of embedding. Keep the same backend between
  runs where you can: closing the desktop app between a build and an update forces a
  rebuild, because the two APIs number their library versions independently.
- **Indexing a big library is fastest against the desktop app** — it is served from disk
  over loopback, with no cloud rate limits to back off from.
- **Don't block on the build call.** `build` returns immediately; poll
  `action: "status"` (every few seconds) until `state` is `done`. A partially built
  index is usable for keyword search the whole time, and progress survives crashes.
- **Embeddings are batched** (32 passages per pipeline call or API request) to keep builds
  efficient and interruptible. `ZOTEUS_EMBED_BATCH_SIZE` and `ZOTEUS_EMBED_BATCH_DELAY_MS`
  resize and pace those batches when an API provider's per-request or per-minute limits
  need it (see [Tuning API embeddings](#tuning-api-embeddings)).
- **Full text multiplies all of the above** by roughly the passage ratio above. On a large
  library, start with a `limit` or a smaller `fulltext_max_chars` before indexing
  everything.
