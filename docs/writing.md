# Writing to Zotero (safe by design)

Writes to your **personal** library go straight to the running Zotero desktop app when it is available — either through the app's local-API writes (Zotero 10+, behind a key you grant once) or, on Zotero 9 and earlier whose local API is read-only, through the desktop connector protocol. No cloud key is needed for those paths. The cloud **Web API v3** is the fallback and is still required for **group libraries**, when the desktop app is not running, and for the tools that have no desktop path (they need a `ZOTERO_API_KEY` with write access). The hard parts — optimistic concurrency, idempotency, batching, and partial-failure handling — are done for you inside the clients.

## Tools

"Route" is the order Zoteus tries: `desktop` means the running Zotero app for the personal library, `cloud` the Web API v3. Passing `library_id` (a group library) always routes to the cloud.

| Tool | What it does | Route | Safety |
|---|---|---|---|
| `zotero_create_items` | Create/update up to many items in one batch (auto-chunked to 50). Validates every item against the schema first — if any is invalid, **nothing** is written. | cloud | non-destructive |
| `zotero_update_item` | Partial **PATCH** of one item (omitted fields are preserved). Fetches the version if you don't supply it; auto re-fetches and retries once on a 412 conflict. | cloud | non-destructive |
| `zotero_trash_items` | Move items to the trash (`deleted:1`) or restore them (`deleted:0`). **Reversible** — the default for "remove". | desktop (local-API writes) → cloud | reversible |
| `zotero_delete_items` | **Permanent** purge. Disabled unless `ZOTEUS_ALLOW_DELETE=true`, and requires `confirm:true` on every call. | desktop (local-API writes) → cloud | ⚠️ irreversible |
| `zotero_manage_collections` | `list` / `create` / `rename` / `reparent` / `delete`, plus `add_items` / `remove_items` (membership lives on the item). | cloud | mixed |
| `zotero_manage_tags` | `list`, or `add` / `remove` tags on items (edits each item's tag array). | cloud | non-destructive |
| `zotero_saved_searches` | `list` / `create` / `delete` saved-search definitions. The cloud API does not *execute* them. | cloud | mixed |
| `zotero_annotate` | Add or delete PDF annotations — highlights, underlines, notes — the same objects the Zotero PDF reader creates. Resolves the PDF attachment from any parent item, or takes an attachment key directly. `delete` needs local-API writes or a cloud key (the connector protocol cannot delete). | desktop → cloud | non-destructive; `delete` **trashes** (reversible) |
| `zotero_attach_file` | Store a local file or a downloaded URL as an `imported_file` attachment under an existing item. Returns the new attachment key. | desktop (local-API writes) only | non-destructive |

`zotero_import` with `save_to_library:true` also saves through the desktop app (both desktop paths), including `attach_url` to stream a PDF into the same save session and `collection_key` targeting — see [`citations.md`](./citations.md).

## Desktop write paths

Zoteus picks one of two desktop paths automatically, both against the running app on `127.0.0.1:23119` (the same local API used for key-free reads — see [`configuration.md`](./configuration.md)).

**1. Local-API writes (Zotero 10+).** `POST`/`PATCH`/`DELETE` on `…/api/users/0/…`, gated by a **local** API key that Zotero grants through an in-app dialog. Zoteus asks for it lazily, on the first desktop write (`POST /api/local/authorize`) — pick **Always Allow** so you are never prompted again. The grant is cached as `local-api-key.json` under the Zoteus data dir; set `ZOTEUS_LOCAL_API_KEY` to pre-provision one (headless/CI, or to skip the dialog entirely). Every write — including the `authorize` call itself — echoes the running instance's `Zotero-Server-ID` header (428 without it, 412 when it no longer matches), and carries the library's current version as `If-Unmodified-Since-Version`, which Zotero requires for deletes and key-based writes. A consumed key (401) or a restarted/moved-on Zotero (412/428) is re-authorized / re-probed transparently. This path covers creates, patches, trash/restore, permanent delete, and file uploads. Note that the local API's `DELETE` erases outright, exactly like the Web API's — trash and restore are writes of the `deleted` flag, never a `DELETE`.

**2. Connector protocol (Zotero 9 and earlier, local API read-only).** The protocol the browser connectors use — `saveItems` / `saveAttachment` / `updateSession`. No key, no grant dialog. Limits: it can only **create** (no updates, no deletes), saves land in the personal library only, and the response carries no item keys — Zoteus recovers them by polling the local API afterwards, so a result may list fewer keys than items even when everything saved.

Local API keys have nothing to do with zotero.org keys: they never leave your machine and only authorize the running app. `ZOTEUS_LOCAL=off` disables both desktop paths and forces every write to the cloud.

## How safety is enforced

- **Optimistic concurrency.** Updates send the object's `version` (or `If-Unmodified-Since-Version`). If the object changed on the server (HTTP 412), `zotero_update_item` automatically re-fetches the current version and retries once, rather than blindly overwriting.
- **PATCH, never PUT.** Updates only change the fields you pass; everything else is preserved. (A raw PUT would wipe omitted fields — Zoteus never does this.)
- **Validation before create.** New items are checked against the live Zotero schema (valid `itemType`, valid fields, valid creator types). Notes/attachments/annotations are exempt from field checks by design.
- **Batch limits & partial failure.** Requests auto-chunk to Zotero's 50-object limit. Batch responses are parsed per-object — a request that returns HTTP 200 with some failures reports exactly which objects failed and why.
- **Trash by default, delete gated.** "Removing" defaults to the reversible trash. Permanent deletion is double-gated: the server must be started with `ZOTEUS_ALLOW_DELETE=true` **and** each call must pass `confirm:true`.

## Examples

Create a paper:

```jsonc
// zotero_create_items
{ "items": [{
  "itemType": "journalArticle",
  "title": "Attention Is All You Need",
  "creators": [{ "creatorType": "author", "lastName": "Vaswani", "firstName": "Ashish" }],
  "date": "2017",
  "tags": [{ "tag": "transformers" }]
}] }
```

Move two items into a collection:

```jsonc
// zotero_manage_collections
{ "action": "add_items", "collection_key": "ABCD1234", "item_keys": ["KEY1", "KEY2"] }
```

Trash (reversible) vs permanent delete:

```jsonc
// zotero_trash_items  — safe default
{ "item_keys": ["KEY1"] }

// zotero_delete_items — only with ZOTEUS_ALLOW_DELETE=true
{ "item_keys": ["KEY1"], "confirm": true }
```

Highlight a passage in an item's PDF:

```jsonc
// zotero_annotate
{ "action": "add", "parent": "ABCD1234", "annotations": [{
  "type": "highlight",
  "text": "Attention mechanisms have become an integral part of sequence models",
  "comment": "core claim",
  "color": "#ffd400",
  "position": { "pageIndex": 0, "rects": [[71.9, 520.4, 523.2, 534.8]] }
}] }
```

`parent` is a regular item key (the PDF child is resolved for you) or an attachment key directly. `position` is Zotero's stored form: `pageIndex` is 0-based, and `rects` are `[x1, y1, x2, y2]` in **native PDF points with a bottom-left origin** — the coordinates a PDF text-extraction pass gives you. Without a `position`, a highlight/underline is rejected (it could not render in place); `annotationSortIndex` is computed from the position so the sidebar order matches the reader (pass `char_offset` and `page_height` to refine it, or `sort_index` to set it outright). `action:"delete"` trashes annotations by key:

```jsonc
// zotero_annotate
{ "action": "delete", "annotation_keys": ["ANNO1234"] }
```

Store a PDF under an existing item:

```jsonc
// zotero_attach_file
{ "parent": "ABCD1234", "url": "https://arxiv.org/pdf/1706.03762", "title": "Full Text PDF" }

// …or from disk; filename/content_type are inferred when omitted
{ "parent": "ABCD1234", "path": "/home/me/papers/attention.pdf" }
```

This needs Zotero 10+ local-API writes. On Zotero 9 and earlier, attach the file **during import** instead — `zotero_import` takes `attach_url` and streams it into the same connector save session.
