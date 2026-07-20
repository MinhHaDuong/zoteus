# Changelog

All notable changes to Zoteus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.4] — 2026-07-20

### Fixed
- `/healthz` and MCP `serverInfo` now report the real package version. Two hardcoded
  `VERSION` constants were missed by every release bump since 1.0.1, so deployed servers
  self-reported a stale version and made deploys look outdated. The version is now read
  from `package.json` at runtime.

## [1.0.3] — 2026-07-20

### Fixed
- `zotero_update_item` / `zotero_create_items`: writing array-valued fields (`creators`,
  `tags`, `collections`) no longer fails with Zotero's "property must be an array" when the
  client sends them in a degraded shape (a JSON-encoded string, a single un-wrapped object,
  a numeric-keyed object, or a wrapper object around the real array). The structured fields
  are now explicitly typed in the advertised tool schema so clients know the expected shape
  up front, and the common degradations are repaired at the tool boundary before the write
  reaches Zotero. Reported in
  [#1](https://github.com/oscardvs/zoteus/issues/1).

## [1.0.2] — 2026-06-01

### Fixed
- `zotero_bibliography` and `zotero_export` now mirror their rendered output into
  `structuredContent`, not only `content`. MCP clients that read the structured channel
  (e.g. the claude.ai connector) were surfacing just a summary (`{style, itemCount}` /
  `{format, length}`) and dropping the actual bibliography/export text.
  `zotero_format_bibliography` also returns the joined `bibliography` string alongside
  `entries` for consistency.
- Zotero fetcher: a slow single request that exceeds the time budget is no longer reported
  as rate-limiting. The 408 now distinguishes genuine throttling (a 429/503/`Backoff` was
  observed → back off and retry sequentially) from an expensive query that was simply slow
  (e.g. a full-text `qmode=everything` scan over a large library → narrow the query or lower
  the limit), so the guidance matches the real cause.
- OAuth (`MODE=zotero`): removed `identity=1` from the Zotero authorize URL, which forced
  identity-only mode and prevented a real API key from being issued.

## [1.0.1] — 2026-06-01

### Changed
- `zotero_search_items`: a quick search (`q`) with no pinned `qmode` that returns nothing now
  auto-retries once in `everything` mode (notes + attachment full text) before reporting
  absence, so "is X in my library?" checks no longer false-negative on terms that appear only
  inside PDF text. Empty `everything` results are reported as strong-but-not-conclusive
  (un-indexed/scanned/un-synced PDFs aren't full-text searchable). The response gains `qmode`
  (effective) and `broadened`; only previously-empty searches change behavior.
- `zotero_fulltext`: description now states it is not a search and points to
  `zotero_search_items` (qmode=everything) for finding which items contain a term.
- Zotero fetcher: bounded per-request time budget (~25s, overridable) with an `AbortController`,
  so a rate-limited (429/503) retry loop or a stalled connection fails fast with an actionable
  408 ("retry sequentially, avoid parallel batches, keep responses concise") instead of hanging
  until the MCP connector's own per-call timeout fires. The budget is per request (not per
  operation), so multi-request batch flows are unaffected. 429/503 messages and the server
  `instructions` now also steer the model toward sequential calls.

## [1.0.0] — 2026-05-31

First public release: published to npm as a scoped public package, listed in the MCP
registry, and shipped as a Claude Desktop DXT.

### Added
- Published `@oscardvs/zoteus` to npm (`npx -y @oscardvs/zoteus`), scoped public with `publishConfig.access=public`.
- MCP registry listing via `server.json` (npm package + hosted remote endpoint).
- Refreshed Claude Desktop DXT one-click package (local-API toggle, icon, self-contained bundle).
- **CIMD (Client ID Metadata Document)** support: resolve a URL `client_id` to a registered
  client without DCR, advertised via `client_id_metadata_document_supported`. Prerequisite for
  the claude.ai connector directory (single shared app instead of per-connection DCR).
- `CHANGELOG.md` and a maintainer distribution runbook (`docs/distribution.md`).
- README launch polish: npm badge, connect matrix, directory/CIMD note.

## [0.12.0] — 2026-05-30 (M13)
### Added
- Production hardening: `/healthz` `/readyz` `/metrics`, secret-redacting logger (text/JSON),
  `/mcp` rate limiting, graceful shutdown (drain → flush store + indexes → close).
- Deploy IaC: docker-compose + Caddy, systemd + Fly alternatives, backups, GHCR release workflow,
  `docs/deployment.md` runbook.

## [0.11.0] — (M12)
### Added
- `zotero_get_fulltext` (passage retrieval with page locators), `zotero_tag_audit`,
  `zotero_list_tags`, `zotero_list_collections`, `zotero_export format:"better-biblatex"`,
  `zotero_update_item dry_run` diff, query-centred search snippets.

## [0.10.0] — (M11)
### Added
- Multi-tenant per-user Zotero login (OAuth `zotero` mode); per-user encrypted token store.

## [0.9.0] — (M10)
### Added
- OAuth 2.1 + PKCE authorization server in front of `/mcp`; passcode-gated consent;
  HTTP transport + DXT + initial MCP registry entry; turn-key claude.ai custom connector.
