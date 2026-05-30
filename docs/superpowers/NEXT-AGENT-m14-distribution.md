# Handoff brief — M14: Public distribution (npm v1.0.0, MCP registry, DXT) + claude.ai connector directory

**Status going in (expected):** Runs **after M13** (a real hosted, persistent, hardened deployment at a stable HTTPS domain). By here, Zoteus has: the OAuth 2.1 remote connector (M10), multi-tenant per-user Zotero login (M11), an agent-usable read/grounding path (M12), and a production deployment (M13). What's missing is **getting it into people's hands**: it is still unpublished (the README quickstart's `npx -y @oscardvs/zoteus` does **not** work yet), not in the MCP registry as installable, and not listed in claude.ai's connector directory.

**Goal:** Ship Zoteus publicly — cut the **`v1.0.0`** release to **npm**, update the **MCP registry** and **DXT**, and pursue listing the hosted instance in the **claude.ai connector directory** (which requires CIMD or Anthropic-held credentials, not per-connection DCR). After this, anyone can `npx @oscardvs/zoteus` (self-host stdio/HTTP) or one-click the hosted connector.

> **Dependency split:** the **npm/registry/DXT** track only needs the package to be solid — it can ship independently of M13. The **directory-listing** track needs the M13 hosted instance + CIMD. Treat them as two workstreams (W1–W3 = package release; W4–W5 = directory).

## W1 — npm publish (this is `v1.0.0`)
The package scaffolding already exists: `package.json` has `name: @oscardvs/zoteus`, `bin: { zoteus }`, `files: [dist, README.md, LICENSE]`, `prepublishOnly: npm run build`, and `mcpName: io.github.oscardvs/zoteus`. Do:
- Set the release version to **1.0.0** in `package.json` **and** `src/server.ts` `VERSION` (keep them in lockstep — there have been drift bugs).
- Confirm `publishConfig` / publish access: it's a **scoped** package, so publishing must use `--access public` (add `"publishConfig": { "access": "public" }` so `npm publish` works without the flag). Consider npm **provenance** (`npm publish --provenance` from CI with OIDC).
- Verify the shipped artifact: `npm pack` and inspect the tarball contains only `dist/ + README + LICENSE` (no `.env`, tests, src). Smoke-test the built bin: `node dist/index.js --help`-equivalent and a stdio `initialize`.
- **Test the real install path** that has been broken all along: from a clean dir, `npx -y @oscardvs/zoteus` (stdio) and `npx -y @oscardvs/zoteus --http` must start. Add this as a post-publish verification.
- Engines/Node: `package.json` says `>=18`; CI runs 18/20/22 — confirm the published build runs on the floor version.

## W2 — MCP registry + `server.json`
- `server.json` exists with `mcpName: io.github.oscardvs/zoteus`. Update it for the `1.0.0` release and ensure it advertises the right package + (optionally) the **remote** deployment endpoint so discovery clients can find both the self-host package and the hosted connector.
- Publish via the documented flow (README: `mcp-publisher login github && mcp-publisher publish`). Verify the listing resolves.

## W3 — DXT (Claude Desktop one-click) refresh
- `dxt/manifest.json` exists. Rebuild the `.dxt` from `dist/` + the manifest for `1.0.0`, verify it installs and runs in Claude Desktop, and attach it to the **GitHub Release** for the tag.

## W4 — CIMD (Client ID Metadata Document) — prerequisite for the directory
Claude's auth reference: directory connectors use a **single shared app** via **CIMD** or **Anthropic-held credentials**, *not* per-connection DCR (DCR registers a fresh client per connection — fine for custom connectors, discouraged at directory scale). The M10/M12 briefs already flagged CIMD as a future enhancement. Implement it:
- Advertise `client_id_metadata_document_supported: true` in the AS metadata.
- Accept a **URL `client_id`** that resolves to a client-metadata document; fetch + validate it (HTTPS, allowed schemes, cache with TTL), and treat it as a registered client without DCR.
- Keep DCR working in parallel (custom connectors still use it). Add tests for the CIMD path (valid doc accepted, malformed/oversized/non-HTTPS rejected).
- This composes with M11's per-user model: CIMD identifies the *client app* (Claude); the per-user Zotero login still identifies the *user*.

## W5 — claude.ai connector directory submission
- Prepare the hosted M13 instance: stable domain, CIMD (W4) or request **Anthropic-held credentials** by contacting `mcp-review@anthropic.com`; production logging/SLAs from M13; a clear privacy/security statement (single operator key vs per-user Zotero login; data handling; no token/key logging).
- Submit per Anthropic's connector-directory process; iterate on review feedback. Track this as an external, async process (it depends on Anthropic review, not just code).

## Release engineering (cross-cutting)
- **`CHANGELOG.md`** (Keep a Changelog format) summarizing M10→M14; backfill the 0.9.x entries.
- **Release CI**: a GitHub Actions workflow that, on a `v*` tag, runs the full gate (`typecheck && lint && build && test`) then `npm publish --provenance` and creates a GitHub Release with the `.dxt` asset. Guard with the green gate; store the npm token in Actions secrets.
- **Version coordination**: M11/M12/M13 each bumped the minor (0.10/0.11/…). M14 jumps to **1.0.0**. Make sure `package.json`, `src/server.ts` `VERSION`, `server.json`, and `dxt/manifest.json` all agree.
- **README polish for launch**: remove the "until it's published, clone and build" caveat (README quickstart) once W1 lands; add an npm-version badge; present a clean **connect matrix** (Claude Code stdio · Claude Desktop DXT · claude.ai web connector · self-hosted HTTP+OAuth); keep the security/privacy note prominent.

## Constraints / house style (match the repo)
- **TDD with Vitest** for code (CIMD validation, any registry/manifest generation, `npm pack` content assertions if scripted). Keep `npm run typecheck && npm run lint && npm run build && npm test` green.
- TypeScript **NodeNext ESM** — relative imports end in `.js`.
- **Commits: never include co-authoring/attribution trailers.**
- No secrets in the repo or the published tarball; the npm token lives only in CI secrets.
- Use the superpowers skills: **writing-plans** → implement (TDD) → **verification-before-completion**; plan doc under `docs/superpowers/plans/`.
- **Tag `v1.0.0`** for the npm publish (the milestone this whole roadmap reserved it for).
- **Verify end-to-end:** after publishing, from a clean machine/container, `npx -y @oscardvs/zoteus` connects over stdio in Claude Code/Desktop; the DXT installs; the MCP registry listing resolves; and (directory track) the hosted connector is reachable via the submitted listing. Capture evidence.

## Pointers
- Publish scaffolding: `package.json` (`bin`, `files`, `prepublishOnly`, `mcpName`, add `publishConfig`), `server.json`, `dxt/manifest.json`, `src/server.ts` (`VERSION`), `.github/workflows/ci.yml` (extend for release).
- CIMD: build on the M10 OAuth surface — AS metadata in `src/auth/router.ts` (via `mcpAuthRouter` options / a metadata override) and client resolution in the provider's `clientsStore` (`src/auth/provider.ts`), alongside the existing DCR path.
- README quickstart caveat to remove once published: the "works once it's published to npm; until then, clone…" note near the top of the Quickstart section.
