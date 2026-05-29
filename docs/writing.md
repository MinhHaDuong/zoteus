# Writing to Zotero (safe by design)

Zoteus writes go through the cloud Web API v3 (the desktop local API is read-only), and require a `ZOTERO_API_KEY` with write access. The hard parts — optimistic concurrency, idempotency, batching, and partial-failure handling — are done for you inside the client.

## Tools

| Tool | What it does | Safety |
|---|---|---|
| `zotero_create_items` | Create/update up to many items in one batch (auto-chunked to 50). Validates every item against the schema first — if any is invalid, **nothing** is written. | non-destructive |
| `zotero_update_item` | Partial **PATCH** of one item (omitted fields are preserved). Fetches the version if you don't supply it; auto re-fetches and retries once on a 412 conflict. | non-destructive |
| `zotero_trash_items` | Move items to the trash (`deleted:1`) or restore them (`deleted:0`). **Reversible** — the default for "remove". | reversible |
| `zotero_delete_items` | **Permanent** purge. Disabled unless `ZOTEUS_ALLOW_DELETE=true`, and requires `confirm:true` on every call. | ⚠️ irreversible |
| `zotero_manage_collections` | `list` / `create` / `rename` / `reparent` / `delete`, plus `add_items` / `remove_items` (membership lives on the item). | mixed |
| `zotero_manage_tags` | `list`, or `add` / `remove` tags on items (edits each item's tag array). | non-destructive |
| `zotero_saved_searches` | `list` / `create` / `delete` saved-search definitions. The cloud API does not *execute* them. | mixed |

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
