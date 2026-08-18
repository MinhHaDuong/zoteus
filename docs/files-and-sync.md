# Files, full-text, sync, groups & export

M4 rounds out library coverage with five tools; `zotero_attach_file` and `zotero_annotate` were added later and write through the Zotero desktop app.

## `zotero_groups`
Lists the group libraries your key can access (id, name, type, item count, edit permissions). Pass a returned id as `library_id` (with `library_type:"group"`) to other tools to operate on a group library.

## `zotero_export`
Exports items in a machine-readable bibliographic format and returns the raw text:
`bibtex`, `biblatex`, `ris`, `csljson`, `csv`, `mods`, `tei`, `coins`, `rdf_bibliontology`, `rdf_dc`, `rdf_zotero`, `refer`, `wikipedia`, `bookmarks`. Narrow with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` is always applied (export formats require it). For styled, human-readable citations in a CSL style (APA, IEEE, …), use the citation tools.

## `zotero_fulltext`
Read or write attachment full text (only attachment items have it):
- `get` — extracted text + indexing stats (`found:false` when none).
- `set` — store extracted text (`content` + char/page counts).
- `since` — map of attachment keys whose full text changed after a library version (for incremental indexing).

## `zotero_sync`
The version-based delta the Zotero sync algorithm uses. Given `since` (a library version, 0 = everything), returns per-type maps of changed keys (items/collections/searches/tags) plus the deletion log. Fetch only the changed keys afterward — don't re-pull the whole library.

## `zotero_attachment`
Upload, download, or inspect attachment files. File bytes go to/from **disk**, never through the conversation.
- `upload` — store a local file via the full 5-step Zotero File Storage protocol (compute md5/mtime → request authorization → upload bytes → register). Optional `parent_item`, `title`, `content_type`. Returns the new attachment key (and whether the file already existed in storage).
- `download` — fetch an attachment's file to `save_path` (default under the Zoteus data dir); returns the path and byte count.
- `info` — return an attachment item's metadata.

> Uploads/downloads use the cloud Web API and count against your Zotero file-storage quota. For a **key-free** store into the running desktop app, use `zotero_attach_file` instead.

## `zotero_attach_file`
Store a file as an `imported_file` attachment under an existing item, through the Zotero desktop app's local-API writes (Zotero 10+) — no cloud key, and the bytes never go through the Web API. Give `parent` (the item key) and either `path` (a local file the Zoteus process can read) or `url` (downloaded first); `filename` and `content_type` are inferred when omitted, `title` defaults to the filename. Returns the new attachment key. On Zotero builds without local-API writes the tool says so and points you at `zotero_import`'s `attach_url`, which streams a file into the same connector save session. See [`writing.md`](./writing.md) for the two desktop write paths and the one-time key grant.

## `zotero_annotate`
Add or delete Zotero PDF annotations — highlights, underlines, notes — the same objects the PDF reader creates, so they appear in Zotero's reader sidebar and export with the item. `parent` may be a regular item key (the PDF child is resolved for you) or an attachment key. Highlights need `text` plus a `position` (`{"pageIndex":N,"rects":[[x1,y1,x2,y2],…]}` in native PDF points, bottom-left origin); `annotationSortIndex` is derived from it. `action:"delete"` trashes annotations by key. Routes to the desktop app for the personal library, else the cloud Web API — details and examples in [`writing.md`](./writing.md).
