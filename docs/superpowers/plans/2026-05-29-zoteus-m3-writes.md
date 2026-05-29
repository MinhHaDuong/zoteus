# Zoteus M3 — Safe Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD throughout; commit per task.

**Goal:** Add safe, versioned write operations — create/update/trash/delete items, manage collections, manage tags, and manage saved searches — on top of the M0–M2 foundation.

**Architecture:** All writes go through the cloud `WebApiClient` (the local API is read-only). The client owns optimistic concurrency (`If-Unmodified-Since-Version`), idempotency (`Zotero-Write-Token` for creates), 50-object auto-chunking, and partial-success parsing. Tools orchestrate version fetching and the 412 re-fetch/retry loop. `SchemaService.validateItem` validates item JSON before any create. Trash (`deleted:1`) is the reversible default; permanent `DELETE` is gated behind `ZOTEUS_ALLOW_DELETE` + an explicit `confirm` argument.

**Tech Stack:** unchanged (TypeScript/ESM, MCP SDK 1.29, zod 3.25, Vitest).

---

## Verified Zotero write conventions (baked into the client)

- **Batch create/update:** `POST <prefix>/items` with a JSON array body. An object with `key`+`version` → update; without `key` → create (server assigns the key). Max 50 objects/request → auto-chunk.
- **Idempotency vs concurrency:** for a pure-create chunk (no versions), send `Zotero-Write-Token: <32 hex>`. For chunks containing updates, send `If-Unmodified-Since-Version: <libraryVersion>`. Never send both.
- **Batch response (HTTP 200 even on partial failure):** body `{ "successful": { "<idx>": {item} }, "success": { "<idx>": "KEY" }, "unchanged": { "<idx>": "KEY" }, "failed": { "<idx>": { "code", "message" } } }`. Keys are stringified array indices. The new library version is in the `Last-Modified-Version` response header. MUST parse `failed` — a 200 does not mean every object succeeded.
- **Single partial update:** `PATCH <prefix>/items/<key>` with `If-Unmodified-Since-Version: <itemVersion>`; returns `204` + new `Last-Modified-Version`. `PATCH` only changes supplied fields; **never use PUT** (it wipes omitted fields). `412` = the item changed since `version` → re-fetch and retry.
- **Delete (permanent):** `DELETE <prefix>/items?itemKey=K1,K2,...` (comma list, ≤50) with `If-Unmodified-Since-Version: <libraryVersion>`; `204`. Missing precondition → `428`.
- **Trash / restore:** there is no trash verb — set the `deleted` field (`1` = trash, `0` = restore) via a normal write (PATCH/POST). Reversible.
- **Collections:** `POST <prefix>/collections` (array, ≤50) to create/update; objects `{ name, parentCollection: <key>|false }`; updates need `key`+`version`. `DELETE <prefix>/collections?collectionKey=...`.
- **Collection membership** lives on the **item** (`item.data.collections: string[]`), changed by writing the item — not a collection endpoint.
- **Tags:** edited via the parent item's `data.tags` array (`{ tag, type? }`); no standalone tag write endpoint. Renaming/deleting a tag library-wide is done by rewriting affected items.
- **Saved searches:** `POST <prefix>/searches` (array; each `{ name, conditions: [{condition, operator, value}] }`); `DELETE <prefix>/searches?searchKey=...`. The cloud API stores definitions only.

---

## File structure

```
src/api/write-client.ts        # WriteResult type + write methods (mix into WebApiClient via a subclass or methods)
src/schema/validate.ts         # validateItem(schema, item) -> { valid, errors }
src/tools/create-items.ts      # zotero_create_items
src/tools/update-item.ts       # zotero_update_item
src/tools/trash-items.ts       # zotero_trash_items
src/tools/delete-items.ts      # zotero_delete_items
src/tools/manage-collections.ts# zotero_manage_collections
src/tools/manage-tags.ts       # zotero_manage_tags
src/tools/saved-searches.ts    # zotero_saved_searches
```

Decision: add the write methods directly to `WebApiClient` (Task 1) rather than a separate class, so tools keep a single client dependency. `validateItem` is a standalone pure function in `src/schema/validate.ts`, used by `SchemaService.validateItem()` and unit-tested directly.

---

### Task 1: WebApiClient write methods

**Files:** Modify `src/api/web-client.ts`; Test `tests/api/web-client-writes.test.ts`.

Add:

```ts
export interface WriteResult {
  successful: Array<{ index: number; key: string; version?: number }>;
  unchanged: string[];
  failed: Array<{ index: number; key?: string; code: number; message: string }>;
  newLibraryVersion: number;
}
```

Methods (all on `WebApiClient`):
- `writeItems(lib: LibraryRef, objects: any[], opts?: { libraryVersion?: number }): Promise<WriteResult>` — chunks `objects` into ≤50; for each chunk, if every object lacks a `version` send `Zotero-Write-Token` (random 32-hex via `crypto.randomBytes(16).toString('hex')`), else send `If-Unmodified-Since-Version: opts.libraryVersion ?? 0`; `POST <prefix>/items`; parse the multi-write body into `WriteResult` (merge across chunks, offsetting indices); read `newLibraryVersion` from `Last-Modified-Version`. Non-2xx → `ZoteroApiError`.
- `patchItem(lib, key, patch, version): Promise<number>` — `PATCH <prefix>/items/<key>`, `If-Unmodified-Since-Version: version`, body `JSON.stringify(patch)`; return new `Last-Modified-Version` (number). 412 → `ZoteroApiError(412)`.
- `deleteItems(lib, keys: string[], libraryVersion: number): Promise<void>` — chunk ≤50; `DELETE <prefix>/items?itemKey=<comma>`, `If-Unmodified-Since-Version`.
- `currentLibraryVersion(lib): Promise<number>` — `GET <prefix>/items?limit=1`, return `Last-Modified-Version` header.
- `writeCollections(lib, objects[], opts?): Promise<WriteResult>` — like `writeItems` but `/collections`.
- `deleteCollections(lib, keys[], libraryVersion): Promise<void>`.
- `writeSearches(lib, objects[], opts?): Promise<WriteResult>` and `deleteSearches(lib, keys[], libraryVersion)`.
- `listSearches(lib): Promise<ListResult>` (GET `/searches`).

Shared chunk helper `chunk<T>(arr, size=50)`. Shared `postArray(path, objects, headers)` used by writeItems/writeCollections/writeSearches.

**Tests (mock fetch):**
- create batch sends `Zotero-Write-Token`, parses `successful` → key+version.
- update batch (objects have version) sends `If-Unmodified-Since-Version`, parses `failed`.
- `>50` objects → 2 POSTs (chunked), merged indices.
- `patchItem` sends `If-Unmodified-Since-Version` and returns the new version header; 412 body → throws with /changed on the server/.
- `deleteItems` builds `itemKey=` comma list and sends the precondition header.

---

### Task 2: Item validation

**Files:** Create `src/schema/validate.ts`; modify `src/schema/schema-service.ts` (add `validateItem`); Test `tests/schema/validate.test.ts`.

```ts
// src/schema/validate.ts
import type { ZoteroSchema } from './schema-service.js';

export interface ValidationResult { valid: boolean; errors: string[] }
const SPECIAL = new Set(['note', 'attachment', 'annotation']);

export function validateItem(schema: ZoteroSchema, item: any): ValidationResult {
  const errors: string[] = [];
  const itemType = item?.itemType;
  if (!itemType) return { valid: false, errors: ['Missing required "itemType".'] };
  const def = schema.itemTypes.find((t) => t.itemType === itemType);
  if (!def) return { valid: false, errors: [`Unknown itemType "${itemType}". Use zotero_schema to list valid types.`] };
  if (SPECIAL.has(itemType)) return { valid: true, errors: [] }; // special types bypass field/creator model
  const validFields = new Set((def.fields ?? []).map((f) => f.field));
  const reserved = new Set(['itemType', 'creators', 'tags', 'collections', 'relations', 'key', 'version', 'dateAdded', 'dateModified']);
  for (const k of Object.keys(item)) {
    if (reserved.has(k)) continue;
    if (!validFields.has(k)) errors.push(`Field "${k}" is not valid for itemType "${itemType}".`);
  }
  const validCreatorTypes = new Set((def.creatorTypes ?? []).map((c) => c.creatorType));
  for (const c of item.creators ?? []) {
    if (c.creatorType && !validCreatorTypes.has(c.creatorType)) {
      errors.push(`Creator type "${c.creatorType}" is not valid for itemType "${itemType}".`);
    }
  }
  return { valid: errors.length === 0, errors };
}
```

`SchemaService.validateItem(item)` = `validateItem(await this.getSchema(), item)`.

**Tests:** unknown itemType → invalid; unknown field → invalid w/ message; valid `journalArticle` w/ title+creators → valid; `note` → valid regardless of fields.

---

### Task 3–9: Write tools

Each is a `ToolDefinition` with a long description, strict zod `inputSchema`, accurate `annotations`, and the 412 re-fetch/retry handled in the handler. Register all in `src/tools/index.ts`.

- **Task 3 `zotero_create_items`** — input `items` (array of item-data objects), optional `library_*`. Validate each via `ctx.schema.validateItem`; if any invalid → return `isError` listing problems (write nothing). Else `ctx.web.writeItems(lib, items, { libraryVersion })`. Return created keys + per-object failures. `annotations: { readOnlyHint:false }`.
- **Task 4 `zotero_update_item`** — input `item_key`, `patch` (object), optional `version`. If `version` absent → fetch current via `ctx.web.getItem`. `patchItem`; on `ZoteroApiError` status 412 → re-fetch version once and retry; if still 412 → `isError` with guidance. `annotations: { idempotentHint:true }`.
- **Task 5 `zotero_trash_items`** — input `item_keys[]`, `action` `trash|restore` (default `trash`). Fetch each item's version (concurrent, capped by the fetcher), build `[{ key, version, deleted: action==='trash'?1:0 }]`, `writeItems`. Reversible; `annotations: { destructiveHint:false }`.
- **Task 6 `zotero_delete_items`** — input `item_keys[]` (≤50/call after chunking), `confirm` (boolean). Guard: if `!ctx.config.allowDelete` → `isError` ("permanent delete disabled; set ZOTEUS_ALLOW_DELETE=true; prefer zotero_trash_items"). If `!confirm` → `isError` ("pass confirm:true to permanently delete"). Else `currentLibraryVersion` → `deleteItems`. `annotations: { destructiveHint:true }`.
- **Task 7 `zotero_manage_collections`** — input `action`: `list|get|create|rename|reparent|delete|add_items|remove_items`. list/get → reads; create → `writeCollections([{name, parentCollection}])`; rename → fetch version, `writeCollections([{key, version, name}])`; reparent → `writeCollections([{key, version, parentCollection: parent|false}])`; delete → `currentLibraryVersion` + `deleteCollections`; add_items/remove_items → for each item key, fetch item, modify `data.collections`, `writeItems`. Validate `action` enum.
- **Task 8 `zotero_manage_tags`** — input `action`: `list|add|remove`. list → `ctx.web.listTags` (or local). add/remove → for each `item_key`, fetch item, mutate `data.tags` (dedupe on `tag`), `patchItem` with version. `tags` input is `string[]`.
- **Task 9 `zotero_saved_searches`** — input `action`: `list|get|create|delete`. list/get → `listSearches`/getItem-style; create → `writeSearches([{name, conditions}])`; delete → `currentLibraryVersion` + `deleteSearches`. Description NOTES that the cloud API does not execute saved searches (read results via the local API).

Each task: write unit test calling `tool.handler(args, fakeCtx)` with mocked `ctx.web`/`ctx.schema`, asserting the right client method is called and errors are surfaced; commit.

---

### Task 10: Integration + guarded live write round-trip

**Files:** extend `tests/integration/server.test.ts` (assert 11 tools now listed); create `tests/e2e/live-writes.test.ts`.

The live write test is **double-gated**: runs only when `ZOTERO_API_KEY` **and** `ZOTEUS_E2E_WRITE=true` are set (so normal `npm test` and CI never mutate the real library). It performs a self-cleaning round-trip:
1. create a `journalArticle` titled `ZOTEUS_E2E <ISO timestamp>` → expect a key.
2. update its `extra` field via `zotero_update_item` → expect a new version.
3. trash it (`zotero_trash_items` action=trash), then permanently delete it via the client (`deleteItems`) so nothing is left behind.

Run once manually: `set -a && . ./.env && set +a && ZOTEUS_E2E_WRITE=true npx vitest run tests/e2e/live-writes.test.ts`.

---

### Task 11: Docs, roadmap, tag

- Update `README.md`: check the **M3** box; add a short "Safe writes" note (trash default, gated delete).
- Add `docs/writing.md` documenting the write tools and the safety model.
- `npm run lint && npm run typecheck && npm test` all green.
- Commit; `git tag v0.2.0`; push with tags.

---

## Self-review checklist
- [ ] Every write path sends a precondition (`If-Unmodified-Since-Version`) or a `Zotero-Write-Token`; never both.
- [ ] Batches auto-chunk at 50; partial `failed` is parsed and surfaced.
- [ ] `PATCH` (not `PUT`) is used for updates.
- [ ] Permanent delete is double-gated (`allowDelete` + `confirm`); trash is the default.
- [ ] Item validation runs before create; special types bypass field checks.
- [ ] Live write test is double-gated and self-cleaning; CI never mutates the library.
- [ ] Tool names/types consistent with M0–M2 (`ToolDefinition`, `ok`, `LibraryRef`).
