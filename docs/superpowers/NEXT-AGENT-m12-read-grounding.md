# Handoff brief — M12: Agent-usable read path, full-text grounding, and library-hygiene writes

**Status going in:** Zoteus is at **v0.9.1** (repo `oscardvs/zoteus`, local checkout `/home/odesha/zoteus`, CI green, 145 tests). The claude.ai (web) OAuth 2.1 connector from M10 works (and from the Claude Code CLI). This brief comes from a **real claude.ai session** that used the connector for a research-grounding task (checking whether specific papers support specific claims — Grandia Hessian decomposition, CasADi interpolant behaviour). The user's verbatim feedback drives the priorities below.

> **Independent of M11.** There is a separate brief `NEXT-AGENT-m11-multitenant.md` (per-user Zotero accounts). M11 and M12 are independent workstreams and can run in parallel; **M12 is the higher near-term value for actually using the connector.** Each workstream below (W1–W5) is self-contained and can be handed to its own agent.

## Already fixed (do not redo) — v0.9.1
The session's headline bug — **every search/retrieval call returned only a one-line header and dropped the payload** — is **fixed**. Root cause: the shared `ok()` result helper put data only in `structuredContent`, and claude.ai (like many clients) surfaces only **text** content to the model. `ok()` now also mirrors the structured data as a JSON text block (`src/registry/registry.ts`); a regression test in `tests/tools/search-items.test.ts` asserts item keys/titles appear in the text content. Verified live over the tunnel: `zotero_search_items` now returns `key/itemType/title/creatorSummary/date` and `zotero_semantic_search` returns `itemKey/title/snippet/score` in text. **Keep this invariant**: any new tool's payload must be visible in text content, not only `structuredContent`.

## Keep — these earned explicit praise; don't regress them
- `version` on `get_item` for optimistic concurrency; `inLibrary` flagging in `zotero_scholar` (cited-but-unsaved papers = lit-review gap work); `totalResults` + `start` pagination; `zotero_index status` transparency; the two-path citation rendering (server-side `zotero_bibliography` vs citeproc `zotero_format_bibliography` with arbitrary CSL — matches a Zotero→Overleaf pipeline).

## Cross-cutting issue to fix first (blocks W1/W2 for read-only deployments)
**Read actions are hidden in read-only mode.** `zotero_fulltext` and `zotero_update_item` are `readOnlyHint: false` (because they can write), so `ZOTEUS_READ_ONLY=true` (the recommended public-connector setting, and what the session used) **removes them entirely — including their read-only actions**. That is why full-text retrieval was unavailable to the user.
- Fix: separate read from write so the **read path is always available**. Recommended: add a dedicated read-only `zotero_get_fulltext` (W1) with `readOnlyHint: true`, and keep `zotero_fulltext` `set/since` as the write/admin tool. Audit other tools for the same trap.

## W1 — `zotero_get_fulltext`: passages with locators (the killer feature)
**User ask:** "A full-text retrieval tool `get_fulltext(item_key, query?/page_range?)` that returns the PDF's extracted text or the top-k relevant passages with page or section locators … closes the loop from 'found the claim' to 'cite \citet{key} with a page'." This was the single biggest miss.

**What exists:** `zotero_fulltext action:"get"` → `ctx.web.getFullText(lib, attachmentKey)` returns the flat indexed text + `indexedChars/totalChars/indexedPages/totalPages`. The semantic index (`src/features/search/*`) already chunks attachment text into ~439 passages over 138 items.

**Gaps / do this:**
- New `zotero_get_fulltext` (`readOnlyHint: true`). Accept a **parent item key** and auto-resolve its best attachment (PDF child) — don't make the agent hunt for the attachment key. Accept optional `query` (return top-k relevant passages via the existing index) and/or `page_range`.
- Return **locators**: page and/or section. **Caveat to solve:** the Web API full-text is a flat string with only aggregate `indexedPages/totalPages` — no per-passage page offsets. Options: (a) track character→page offsets when chunking/extracting (extend `src/features/search/chunker.ts`), (b) re-extract the PDF with a page-aware extractor for locators on demand, or (c) start with character-offset/section locators and label page mapping "approximate". Be explicit about which.
- **Guard size** (see cross-cutting "token budget"): cap returned text; for whole-document requests return the top-k passages or a truncated head with a "truncated, N more chars; pass query/page_range" notice — never silently drop.
- Verify end-to-end with the user's real checks (Grandia Hessian decomposition; CasADi interpolant out-of-grid) — the offered acceptance test.

## W2 — Guarded write/update: dry-run + diff
**User ask:** an `update_item` that takes `version` and supports a **diff or dry-run**, defaulting to showing the change before applying — for their "export → LLM fixes/completes entries → Overleaf" cleanup.

**What exists:** `zotero_update_item` (PATCH semantics, `version` concurrency, 412 auto-retry) and `zotero_create_items`.

**Do this:** add `dry_run: boolean` (and/or `preview`) to `zotero_update_item` that fetches current fields, computes a field-level **diff** (before→after) and returns it **without writing**; default behaviour should make the change visible before applying (e.g. require a follow-up confirm, or return the diff when `dry_run`). Keep the write itself behind `ZOTEUS_READ_ONLY=false` and `ZOTEUS_ALLOW_DELETE=false` defaults. Document that this workflow needs read-write mode.

## W3 — Tag-taxonomy audit
**User ask (very on-brand):** they run exactly **50 controlled tags with priority tiers and per-sub-question (SQ) collections**. Want a tool that lists the controlled vocabulary, flags **off-taxonomy** tags, and finds items **missing a must-have / priority tag**.

**What exists:** `zotero_manage_tags` (list/rename/delete), `zotero_search_items` (tag filters), collections tools.

**Do this:** add `zotero_tag_audit` (read-only) that accepts a **controlled vocabulary** (tags + tiers) — via tool args and/or a config file/path — and reports: (1) tags in the library not in the vocab (off-taxonomy), (2) items missing a must-have/priority-tier tag, (3) optional per-collection (per-SQ) coverage. Generalize the user's setup (don't hard-code 50 tags) but ship a sensible schema for tiers.

## W4 — Better BibLaTeX (BBT) export
**User ask:** confirm `zotero_export` can emit **Better BibLaTeX** with their settings (sentence-case, unicode-as-latex), not just CSL/built-in — their .bib/Overleaf pipeline depends on BBT-specific formatting.

**Reality to convey:** the Web API only offers **built-in** translators (`bibtex`, `biblatex`, …). **BBT is a desktop plugin**; its translators + options (sentence-case, `biblatexExtendedNameFormat`, unicode→LaTeX) run inside Zotero and are exposed via the **local BBT endpoint** (`http://localhost:23119/better-bibtex/...`, JSON-RPC / export URLs), not the cloud API.

**Do this:** (1) verify/improve built-in `biblatex` output via the Web API and document its limits vs BBT; (2) when the desktop local API + BBT plugin are available, add a BBT export path that calls the local BBT endpoint with the user's options. This is genuinely **local-only**; flag it and degrade gracefully to built-in `biblatex` when BBT isn't present.

## W5 — Sharpen overlaps + snippet quality (light, no deletions)
- **Don't delete anything** on the basis of one session. Sharpen descriptions so the agent picks correctly: `zotero_bibliography` (server-side CSL, items-in-library, ≤150) vs `zotero_format_bibliography` (citeproc, arbitrary CSL-JSON/styles); and `zotero_semantic_search` (conceptual "papers about X") vs `zotero_search_items` `qmode:"everything"` (exact field/tag filters + keyword/full-text). Optionally merge each pair behind a flag, but sharpening is enough.
- **Snippet quality:** semantic snippets start mid-token (e.g. `"avid Cen Cheng Indri…"`). Make snippet extraction start at word/sentence boundaries and read cleanly (`src/features/search` snippet generation).

## Cross-cutting notes
- **Token budget.** claude.ai caps tool results at ~150,000 chars (and 300s). Now that `ok()` mirrors full JSON into text, large results actually flow — so **add/keep sane default limits and truncate-with-notice** for big searches (`response_format:"detailed"` × `limit:100`) and especially W1 full-text. Never silently truncate.
- **outputSchema (optional, belt-and-suspenders).** Tools return `structuredContent` without declaring `outputSchema`; declaring it would make `structuredContent` spec-compliant for clients that *do* read it, complementing the text mirror now in place.
- **Read-only audit.** Re-check every tool's `readOnlyHint`; any tool with a useful *read* action must keep that action reachable when `ZOTEUS_READ_ONLY=true`.

## Constraints / house style (match the repo)
- **TDD with Vitest**; unit-test each tool's output (assert payload appears in **text** content, not only `structuredContent`); add an integration test for W1 passage retrieval. Keep `npm run typecheck && npm run lint && npm run build && npm test` green.
- TypeScript **NodeNext ESM** — relative imports end in `.js`.
- **Commits: never include co-authoring/attribution trailers.**
- Real Zotero key lives in git-ignored `.env`; never commit it.
- Use the superpowers skills: **writing-plans** → implement (TDD) → **verification-before-completion**; plan doc under `docs/superpowers/plans/`. Tag **`v0.10.0`** when the milestone lands (reserve `v1.0.0` for the npm publish; M11 multi-tenant, if done separately, also targets a 0.x bump — coordinate version numbers).
- **Verify end-to-end:** deploy/tunnel a stable HTTPS instance, connect in claude.ai, and re-run the **Grandia + CasADi** grounding checks — confirm W1 returns usable passages with locators and the agent can cite a claim with a page. The user offered to re-run these.

## Pointers
- Result helper + read-only filter: `src/registry/registry.ts` (`ok`, `registerAllTools`), `src/server.ts` (`activeTools` read-only filter).
- Tools: `src/tools/{fulltext,update-item,export,manage-tags,search-items,semantic-search,get-item,scholar}.ts`.
- Full text + search internals: `src/api/web-client.ts` (`getFullText`/`fullTextSince`), `src/features/search/{chunker,index-manager,bm25,vector-store,persistence}.ts`.
- Live read-path repro pattern (OAuth + MCP client dumping content vs structuredContent) is in the M10 session history; reuse it to verify W1.
