# Citation pipeline

M5 adds an (account-free where possible) import-and-cite pipeline: four tools.

## `zotero_import` — add by identifier or URL
Resolves bibliographic metadata and optionally saves it to your library.
- `by_identifier` — a **DOI, ISBN, PMID, arXiv id, or ADS bibcode**.
- `by_url` — scrape a web page (may return multiple choices to pick from).
- `save_to_library: true` (optional `collection_key`) persists the resolved items (needs a cloud key); otherwise the metadata is returned without saving.

Requires a reachable **Zotero translation-server**. If none is running, the tool returns setup instructions instead of failing:

```bash
docker run -d -p 1969:1969 zotero/translation-server
# then (optional) set ZOTEUS_TRANSLATION_SERVER_URL if not on the default port
```

## `zotero_styles` — resolve CSL styles
- `resolve` maps a human name ("APA 7th", "IEEE", "Vancouver", "Chicago", "MLA", "Nature", …) to a valid CSL id and confirms it can be fetched.
- `list` returns the built-in common aliases. Any id from the [CSL styles repository](https://github.com/citation-style-language/styles) works too. Dependent styles are resolved to their independent parent automatically.

## `zotero_format_bibliography` — citeproc, any style, no library needed
Formats a bibliography with **citeproc-js** over either `items` (arbitrary CSL-JSON, e.g. from `zotero_import`) or `item_keys` (library items, exported to CSL-JSON first). Pick `style` (name or id, default `apa`), `locale` (default `en-US`), and `format` (`html`/`text`/`rtf`). Styles and locales are fetched from the CSL CDN and cached.

## `zotero_bibliography` — server-rendered (library items)
Asks Zotero to render a bibliography for library `item_keys` in a CSL style (`format=bib`). Item-only and capped at 150 items. For arbitrary items or styles, use `zotero_format_bibliography`.

### Which bibliography tool?
- Items **in your library**, quick render → `zotero_bibliography`.
- **Arbitrary** CSL-JSON, items not in the library, or full control of output format → `zotero_format_bibliography`.
