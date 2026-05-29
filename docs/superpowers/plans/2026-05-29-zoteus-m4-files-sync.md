# Zoteus M4 — Files, Full-text, Sync, Groups, Export

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. TDD; commit per task.

**Goal:** Round out library coverage with group libraries, bibliographic export (17 formats), attachment full-text get/set, incremental version-delta sync, and the full attachment file protocol (upload/download).

**Architecture:** New read/raw methods on `WebApiClient` plus the multi-step Zotero File Storage upload. Five new tools. Binary attachment bytes are written to / read from local files (never streamed through the model context), in keeping with the code-execution philosophy.

---

## Verified conventions

- **Groups:** `GET /users/<id>/groups` → array of group objects (`{id, version, data:{name,type,description,...}, meta:{numItems,...}}`).
- **Export:** any items read endpoint with `format=<fmt>` returns raw text (`bibtex`, `biblatex`, `ris`, `csljson`, `csv`, `mods`, `tei`, `coins`, `rdf_*`, `refer`, `wikipedia`, `bookmarks`). Export formats REQUIRE `limit`. `csljson` is JSON; the rest are text.
- **Full-text read:** `GET <prefix>/items/<key>/fulltext` → `{content, indexedChars,totalChars}` or `{content, indexedPages,totalPages}`; `404` when none. **Write:** `PUT <prefix>/items/<key>/fulltext` body `{content, indexedChars, totalChars}` → `204`. **Delta:** `GET <prefix>/fulltext?since=<v>` (since REQUIRED) → `{itemKey: version}`.
- **Sync delta:** `GET <prefix>/<type>?format=versions[&since=<v>]` for `items|collections|searches` → `{key: version}`; tags via `/tags?since=`. `GET <prefix>/deleted?since=<v>` → `{collections,items,searches,tags,settings,relations}` of deleted keys since `v`.
- **File upload (5 steps, imported_file):**
  1. Create an `attachment` item (`linkMode:"imported_file"`, `title`, `filename`, `contentType`, optional `parentItem`) → key.
  2. `POST <prefix>/items/<key>/file`, `Content-Type: application/x-www-form-urlencoded`, `If-None-Match: *` (new) or `If-Match:<oldmd5>` (replace), body `md5,filename,filesize,mtime` (mtime in **ms**) — optionally `&params=1`.
  3. If response is `{"exists":1}` → already stored, done.
  4. Else upload bytes to the returned `url`: single request with body `prefix + bytes + suffix` and `Content-Type` from the auth response → expect `201`.
  5. Register: `POST <prefix>/items/<key>/file`, `If-None-Match: *`, body `upload=<uploadKey>` → `204`.
- **File download:** `GET <prefix>/items/<key>/file` → 302 → bytes; verify `ETag`/item `md5`.

---

## File structure

```
src/api/web-client.ts        # + listGroups, getRaw/exportItems, fulltext*, versions/deleted, file* methods
src/api/attachments.ts       # uploadFile() orchestrating the 5-step protocol (uses WebApiClient)
src/tools/groups.ts          # zotero_groups
src/tools/export.ts          # zotero_export
src/tools/fulltext.ts        # zotero_fulltext (get|set|since)
src/tools/sync.ts            # zotero_sync (versions + deleted delta)
src/tools/attachment.ts      # zotero_attachment (upload|download|info)
```

---

### Task 1 — WebApiClient read/raw/delta methods + tests
- `listGroups(userID): Promise<ListResult>` → `GET /users/<id>/groups`.
- `getRaw(path, query): Promise<{ text: string; headers: Headers }>` (throws `ZoteroApiError` on non-2xx).
- `exportItems(lib, { format, itemKey?, collectionKey?, q?, itemType?, limit }): Promise<string>` → items endpoint with `format`, default `limit=50`.
- `getFullText(lib, key): Promise<any | null>` (404 → null).
- `setFullText(lib, key, body): Promise<void>` (PUT, 204).
- `fullTextSince(lib, since): Promise<Record<string, number>>`.
- `versions(lib, type: 'items'|'collections'|'searches'|'tags', since?): Promise<Record<string,number>>`.
- `deleted(lib, since): Promise<Record<string, string[]>>`.
- Tests (mock fetch): groups parsed; export sends `format`+`limit` and returns text; getFullText returns null on 404; versions sends `format=versions&since`.

### Task 2 — Attachment protocol + tests
- `src/api/attachments.ts`: `uploadFile(web, lib, { filePath, parentItem?, title?, contentType?, linkMode? }): Promise<{ key, exists }>` and `downloadFile(web, lib, key, savePath): Promise<{ savePath, bytes }>`.
- Add low-level file methods to `WebApiClient`: `createAttachmentItem`, `requestUpload` (step 2), `uploadBytes` (step 4, to the S3 url), `registerUpload` (step 5), `downloadFileBytes` (GET .../file → ArrayBuffer + ETag).
- Compute md5 with `node:crypto` `createHash('md5')`; mtime in ms from `fs.statSync`.
- Tests (mock fetch sequence): full new-file upload hits steps 2→4→5; `{exists:1}` short-circuits after step 2; download writes bytes to the path.

### Task 3–7 — Tools
- `zotero_groups` — list accessible groups + metadata. Read.
- `zotero_export` — export items in a chosen format (validates `format`; warns export formats need a limit; returns the text). Read.
- `zotero_fulltext` — `action: get|set|since`. get → content + indexing stats (404 → "no extracted text"); set → PUT; since → changed map. `set` writes (cloud).
- `zotero_sync` — return a changed-keys summary across items/collections/searches/tags since a version, plus the deleted log. Read.
- `zotero_attachment` — `action: upload|download|info`. upload(file_path, parent_item?, title?) → new attachment key (+exists flag); download(item_key, save_path?) → local path + byte count; info(item_key) → attachment metadata. Binary stays on disk, never in context.

### Task 8 — Integration + guarded live test + docs/tag
- Integration: assert 16 tools listed.
- Live (gated by `ZOTERO_API_KEY`, read-only): `zotero_groups`, `zotero_export` (bibtex of 1 item), `zotero_sync` (since=0 returns maps). The upload round-trip is double-gated behind `ZOTEUS_E2E_WRITE=true` and self-cleaning.
- `docs/files-and-sync.md`; README roadmap M4 checked; version 0.3.0; tag.

## Self-review
- [ ] Export sends `limit` (export formats require it); csljson returned as text too.
- [ ] Full-text get handles 404 as "none" not an error.
- [ ] Upload follows steps 2→(exists?)→4→5 with correct headers (If-None-Match:* , mtime ms).
- [ ] Attachment bytes go to/from disk, not the model context.
- [ ] 16 tools; types consistent with prior milestones.
