# Files, full-text, sync, groups & export

M4 rounds out library coverage with five tools.

## `zotero_groups`
Lists the group libraries your key can access (id, name, type, item count, edit permissions). Pass a returned id as `library_id` (with `library_type:"group"`) to other tools to operate on a group library.

## `zotero_export`
Exports items in a machine-readable bibliographic format and returns the raw text:
`bibtex`, `biblatex`, `ris`, `csljson`, `csv`, `mods`, `tei`, `coins`, `rdf_bibliontology`, `rdf_dc`, `rdf_zotero`, `refer`, `wikipedia`, `bookmarks`. Narrow with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` is always applied (export formats require it). For styled, human-readable citations in a CSL style (APA, IEEE, …), use the citation tools (M5).

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

> Uploads/downloads use the cloud Web API and count against your Zotero file-storage quota.
