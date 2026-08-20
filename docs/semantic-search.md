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
  `passages`, `vectors`, `items`, the **effective** `embedder`, and `lastError` when
  `state` is `error`. Backward-compatible fields (`documents`, `vectors`, `items`,
  `embedder`, `builtFromVersion`) are still present. Progress is also logged on the
  server (every 500 items / 10s).
  `embedder` is what is *actually* producing vectors, not what was requested: three extra
  fields split the two apart, so a keyword-only index always explains itself.
  | Field | Meaning |
  |---|---|
  | `embedderConfigured` | the `ZOTEUS_EMBEDDINGS` value that was asked for |
  | `embedderActive` | `true` only while that provider is genuinely embedding |
  | `embedderReason` | present when it is not: why, and what to do about it |
- `action: "stop"` — cooperatively cancel a running build. The build halts between
  pages/batches and the partial index is kept and stays searchable.
- `limit` — optional max number of items to index (default and hard cap: 5000).
- `fulltext` — also index the body text of each item's attachments (see
  [Full-text indexing](#full-text-indexing-opt-in) below). Defaults to
  `ZOTEUS_INDEX_FULLTEXT` (off).
- `fulltext_max_chars` — cap on indexed full-text characters per item; `0` means no cap.
  Defaults to `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` (40000).

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
back to downloading and parsing PDFs itself: that would mean fetching and decoding the
whole library.

**Local-first, key-free.** Zotero 7+ serves `/fulltext` from the desktop app, so full-text
indexing works with no cloud API key, exactly like the metadata build. Group libraries (and
everything else when the app is closed) go to the cloud Web API.

**Passages are attributed to the parent item.** A body-text hit is reported as the item
that owns the attachment, with the item's title, and de-duplicated against its metadata
passages, so one paper never floods the result list.

**How it is resolved.** Two library-wide reads, not per-item probing: one
`/fulltext?since=0` call names every attachment that *has* extracted text, and paging
`itemType=attachment` maps each one to its parent. Only that intersection is fetched, so
the number of full-text requests equals the number of attachments that actually have text.

**Cost.** This is the expensive option, which is why it is off by default. Measured on a
212-item library with 151 extracted PDFs:

| | passages | index file | build (keyword-only, desktop app) |
|---|---:|---:|---:|
| metadata only | 687 | 0.4 MB | 0.2 s |
| `fulltext: true` | 6246 | 7.9 MB | 4.0 s |

Roughly **9× the passages**. Every one of them is also a vector to compute and store, so
with `ZOTEUS_EMBEDDINGS=local` (CPU-bound) the embedding stage grows by the same factor and
dominates the build. Ways to bound it:

- `fulltext_max_chars` / `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` — characters indexed per item
  (default 40000, about 13 pages of dense text; `0` disables the cap). Passages per item
  land near `max_chars / 1200`.
- `limit` — index fewer items.
- Body passages are chunked at 1200 characters (against 512 for metadata), which keeps the
  vector count down and gives each passage enough context to embed usefully.

Progress and outcome are reported by `zotero_index action:"status"`: `fulltextItems`,
`fulltextPassages`, and `fulltextEnabled`. If full text was requested but produced nothing
(no extracted attachments, or the endpoints were unreachable) the build still completes as
a metadata index and `fulltextReason` says why, rather than looking complete.

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

The first local build downloads the model (~25 MB) once.

### Why it is not bundled

`@huggingface/transformers` statically imports `onnxruntime-node`, whose prebuilt native
binaries ship for every platform in one package. The full tree is **~384 MB installed**
(211 MB onnxruntime-node + 130 MB onnxruntime-web + ~40 MB of `sharp`/tokenizers), against
a ~35 MB bundle today. There is no WASM-only shortcut either: the package's Node entry
point imports the native runtime unconditionally, so it cannot be pruned. Shipping it would
mean five per-platform `.mcpb` files of 100 MB+ each, and users picking the right one.

So the `.mcpb` bundle carries **keyword search out of the box**, and local vectors are an
opt-in that lives outside the bundle:

```bash
npm i -g @huggingface/transformers
npm root -g            # copy this path
```

Then set **`ZOTEUS_TRANSFORMERS_PATH`** to that path (in Claude Desktop: the extension's
**"Local embeddings path"** setting) and restart. Because it lives outside the bundle it
survives extension updates, which would wipe anything installed *into* the extension folder.
The variable accepts the `npm root -g` directory, the package directory itself, or an npm
prefix. It works for npm/Docker installs too, whenever the module lives somewhere the
server cannot resolve on its own.

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
- **Full text multiplies all of the above** by roughly the passage ratio above. On a large
  library, start with a `limit` or a smaller `fulltext_max_chars` before indexing
  everything.
