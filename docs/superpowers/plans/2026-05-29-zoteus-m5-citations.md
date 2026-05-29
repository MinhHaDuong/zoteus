# Zoteus M5 — Citation Pipeline

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. TDD; commit per task.

**Goal:** Add an (account-free where possible) citation pipeline: import items by identifier (DOI/ISBN/PMID/arXiv) or URL via a Zotero translation-server, format bibliographies in any of ~2,800 CSL styles via citeproc-js, and resolve human style names to CSL ids — plus cloud-rendered bibliographies for library items.

**Architecture:** Three feature modules under `src/features/citation/` (translation-server client, CSL style/locale resolver with CDN caching, citeproc engine) and four tools. External services degrade gracefully: if no translation-server is reachable, `zotero_import` returns a clear, actionable message instead of failing. CSL styles/locales are fetched from the CSL GitHub CDN and cached in-process.

**New dependency:** `citeproc@^2.4` (CommonJS citeproc-js). A `src/types/citeproc.d.ts` ambient declaration provides the module type.

---

## Verified facts
- `citeproc` v2.4.63 published (CommonJS); used as `new CSL.Engine(sys, styleXml)` with `sys.retrieveLocale(lang)` and `sys.retrieveItem(id)`, then `engine.updateItems(ids)` + `engine.makeBibliography()` → `[params, entries[]]`.
- CSL style XML: `https://raw.githubusercontent.com/citation-style-language/styles/master/<id>.csl` (200 OK). Dependent styles contain `<link ... rel="independent-parent"/>` → resolve to the parent id and fetch that.
- CSL locale XML: `https://raw.githubusercontent.com/citation-style-language/locales/master/locales-<lang>.xml` (200 OK). Default `en-US`.
- translation-server: `POST /search` (text/plain identifier) → Zotero-JSON items; `POST /web` (text/plain URL) → items, or `300` Multiple Choices `{url,session,items}`; `POST /export?format=<fmt>` (JSON body) → text. Default base `http://127.0.0.1:1969` (not assumed running).
- Cloud bibliography: `GET <prefix>/items?itemKey=<csv>&format=bib&style=<id>&locale=<loc>&linkwrap=1` → XHTML (item-only, ≤150).

---

## Files
```
src/features/citation/translation-server.ts   # TranslationServerClient (search/web/export/isUp)
src/features/citation/styles.ts                # StyleResolver (alias map, fetch+cache style/locale, parent resolution)
src/features/citation/citeproc-engine.ts       # formatBibliography(items, styleXml, localeXml, format)
src/types/citeproc.d.ts                         # declare module 'citeproc'
src/api/web-client.ts                           # + getBibliography()
src/tools/import.ts            # zotero_import (by_identifier | by_url)
src/tools/styles.ts           # zotero_styles (list | resolve)
src/tools/format-bibliography.ts  # zotero_format_bibliography (citeproc, arbitrary CSL-JSON or library keys)
src/tools/bibliography.ts     # zotero_bibliography (cloud format=bib for library keys)
```

## Tasks
1. **Add `citeproc` dep + `citeproc.d.ts`**; `npm i`.
2. **StyleResolver** (+ tests): `resolveId(name)` maps common names (apa/apa 7th→apa, ieee, vancouver, chicago→chicago-note-bibliography, mla→modern-language-association, nature, harvard→harvard-cite-them-right) else passthrough; `fetchStyle(id)` fetches+caches, follows `independent-parent`; `fetchLocale(lang='en-US')` fetches+caches. Inject a `fetchImpl` for tests.
3. **citeproc-engine** (+ test with a tiny bundled style+locale): `formatBibliography({items, styleXml, localeXml, format})` → `{ bibliography, entries }`. Items must carry `id`; assign one if missing.
4. **TranslationServerClient** (+ tests, mock fetch): `isUp()`, `search(identifier)`, `web(url)` (handle 300), `exportFormat(items, fmt)`.
5. **WebApiClient.getBibliography(lib, itemKeys, {style, locale, linkwrap})** (+ test) via `getRaw` with `format=bib`.
6. **Tools** (+ unit tests): `zotero_import` (probe → degrade; `by_identifier` calls search, optional `save_to_library`→writeItems(+collection); `by_url` calls web, surfaces 300 choices), `zotero_styles` (list common aliases / resolve a name and confirm it fetches), `zotero_format_bibliography` (items CSL-JSON or `item_keys`→ export csljson → citeproc; `style`,`locale`,`format`), `zotero_bibliography` (cloud `format=bib` for `item_keys`).
7. **Register** 4 tools (20 total); integration test asserts 20; **live** (CDN reachable): styles.resolve + format a sample CSL-JSON item in APA; cloud bibliography of 1 library item. `docs/citations.md`; README M5; v0.4.0; tag.

## Self-review
- [ ] No translation-server → `zotero_import` returns actionable guidance, not a crash.
- [ ] Dependent CSL styles resolve to their parent before formatting.
- [ ] citeproc items always have an `id`.
- [ ] Styles/locales cached; CDN base configurable.
- [ ] 20 tools; types consistent.
