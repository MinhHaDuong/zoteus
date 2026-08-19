# Distribution & release runbook (maintainers)

How to ship Zoteus to the public. Two tracks that ship independently:

- **Package release (W1–W3)** — npm + MCP registry + Claude Desktop DXT. Needs only a solid
  package; no hosted instance required.
- **Directory listing (W4–W5)** — the claude.ai connector directory. Needs the M13 hosted
  instance live + CIMD enabled. Ships after the package track.

`v1.0.0` is the long-reserved first public release.

---

## 1. Preconditions (green gate)

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

Confirm the version is in lockstep across **all five** locations (a drift here ships a
mismatched release):

```bash
node -e "console.log('pkg ', require('./package.json').version)"
grep -n "const VERSION" src/server.ts src/index.ts      # MCP serverInfo + /healthz version
node -e "const s=require('./server.json'); console.log('server.json', s.version, s.packages[0].version)"
node -e "console.log('dxt ', require('./dxt/manifest.json').version)"
node -e "console.log('lock', require('./package-lock.json').version)"
```

Every line must print the same `X.Y.Z`. (`src/server.ts` feeds the MCP `serverInfo.version`;
`src/index.ts` feeds the `/healthz` liveness version — keep both in step.)

---

## 2. npm publish (`@oscardvs/zoteus`, scoped public)

**Inspect the tarball first** — the `files` allowlist must ship only `dist/`, `README.md`,
`LICENSE`, `package.json` (no `.env`, `src/`, `tests/`, `docs/`, `dxt/`):

```bash
npm run build
npm pack --dry-run 2>&1 | tee /tmp/zoteus-pack.txt
grep -E '(^|/)(\.env|src/|tests/|docs/|dxt/|\.git)' /tmp/zoteus-pack.txt && echo "LEAK" || echo "clean"
```

**Manual publish** (`publishConfig.access=public` means no `--access` flag needed):

```bash
npm publish              # or: npm publish --dry-run  to rehearse
```

**CI publish (preferred)** — push a `vX.Y.Z` tag; `.github/workflows/deploy.yml`'s
`npm-publish` job runs `npm publish --provenance` (npm provenance via GitHub OIDC) behind the
green `test` gate. Requires a repo Actions secret **`NPM_TOKEN`** — an *automation* token from
npmjs.com with publish rights on `@oscardvs/zoteus`. Never commit the token.

> Prefer **one** path per release — CI **or** manual, not both. The CI `npm-publish` step is
> idempotent (it checks `npm view` and skips if the version already exists), so a prior manual
> publish or a re-pushed tag won't fail the pipeline or block the `.dxt` release asset.

---

## 3. Post-publish verification (the broken-install path)

From a **clean** dir or container (no repo checkout):

```bash
# stdio: initialize must return serverInfo.version = X.Y.Z
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | ZOTERO_API_KEY=dummy npx -y @oscardvs/zoteus | head -c 400; echo

# http: binds loopback and serves /mcp
npx -y @oscardvs/zoteus --http --port 3939 &
sleep 2 && curl -fsS http://127.0.0.1:3939/healthz && kill %1
```

---

## 4. MCP registry (`io.github.oscardvs/zoteus`)

`server.json` advertises both the npm **package** and the hosted **remote**
(`https://zoteus.duckdns.org/mcp`). Only publish the remote once that instance is live
(see §8) — otherwise drop the `remotes` block until it is.

```bash
mcp-publisher login github
mcp-publisher publish            # validates server.json against the registry schema
```

Verify the listing resolves under `io.github.oscardvs/zoteus`.

---

## 5. Claude Desktop DXT (self-contained `.dxt`)

> **Important:** the manifest lives in `dxt/` but the runtime entry is `dist/index.js` with
> bare imports (tsc output, not bundled). Packing `dxt/` **alone produces a broken extension**
> (no `dist/`, no `node_modules`). You must stage a complete tree first.

```bash
npm run build
rm -rf /tmp/dxt-build && mkdir -p /tmp/dxt-build
cp dxt/manifest.json dxt/icon.png /tmp/dxt-build/
cp -r dist /tmp/dxt-build/dist
cp package.json package-lock.json /tmp/dxt-build/
( cd /tmp/dxt-build && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )  # bundles prod deps incl. optional pdfjs-dist
npx --yes @anthropic-ai/dxt pack /tmp/dxt-build zoteus.dxt
# verify it carries the entry point + bundled deps:
unzip -l zoteus.dxt | grep -E ' dist/index.js$| icon.png$| manifest.json$'
unzip -l zoteus.dxt | grep -q 'node_modules/@modelcontextprotocol/sdk/' && echo "deps bundled"
```

The result is a ~35 MB self-contained `.dxt` (full feature parity, incl. PDF passage
extraction). Install it in Claude Desktop, confirm the tools load, and attach it to the
GitHub Release for the tag (the `release` job in `deploy.yml` does this automatically).

> **Toolchain note:** `@anthropic-ai/dxt` is deprecated and renamed `@anthropic-ai/mcpb`
> (which emits `.mcpb`). Claude Desktop still consumes `.dxt`, so we keep `@anthropic-ai/dxt`
> for now; revisit if/when Desktop requires `.mcpb`.

> **Updates (#6):** Claude only auto-updates extensions installed from the official
> directory; a manually installed `.dxt` stays on its version forever. Zoteus therefore
> ships an in-server update check (`ZOTEUS_UPDATE_CHECK`, on by default): a daily cached
> GET of the latest GitHub release, surfaced through `zotero_whoami` with a
> download-and-reinstall hint when the manifest marks the install as `ZOTEUS_DIST=dxt`.
> True auto-update would require acceptance into the official extension directory, which
> is a separate Anthropic review/submission process.

---

## 6. Git tag (triggers the release pipeline)

```bash
git tag v1.0.0
git push origin v1.0.0
```

`deploy.yml` (on `v*`) runs: `test` → `image` (multi-arch GHCR push) + `npm-publish`
(provenance) + `release` (self-contained `.dxt` attached, auto release notes).

---

## 7. CIMD (Client ID Metadata Document)

CIMD lets a directory-scale connector use **one shared client app** instead of per-connection
Dynamic Client Registration: the provider resolves a **URL `client_id`** by fetching +
validating its metadata document.

- **Enable:** `ZOTEUS_CIMD_ENABLED=true` (off by default — OSS self-host is unaffected).
- **Validation:** https-only URL, byte cap (`ZOTEUS_CIMD_MAX_BYTES`, default 16 KB),
  `client_id` must equal the document URL, redirect_uri schemes limited to
  `ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES` (default `https`), TTL cache
  (`ZOTEUS_CIMD_CACHE_TTL_SEC`, default 1 h). Invalid/unreachable docs → treated as an unknown
  client (no error leak). `redirect: 'error'` blocks redirect-based fetch tricks.
- **Advertised** as `client_id_metadata_document_supported: true` on
  `/.well-known/oauth-authorization-server` (only when enabled). **DCR keeps working** in
  parallel for custom (non-directory) connectors.
- **Composes with M11 multi-tenant:** CIMD identifies the *client app* (Claude); per-user
  Zotero login (`ZOTEUS_OAUTH_MODE=zotero`) identifies the *user*. They are orthogonal.

---

## 8. claude.ai connector directory submission (async, external)

Depends on the M13 hosted instance being live. Prepare:

1. **Hosted instance** at a stable HTTPS domain (`docs/deployment.md` — free-tier VM + Caddy +
   DuckDNS). Set `ZOTEUS_CIMD_ENABLED=true`. Either serve a CIMD document for Claude's client
   app, or request **Anthropic-held credentials** by emailing `mcp-review@anthropic.com`.
2. **Production posture (M13):** health/readiness probes, structured **secret-redacted**
   logging (no token/key/passcode ever logged), `/metrics`, graceful shutdown, backups.
3. **Privacy/security statement:** single operator key (passcode mode) vs per-user Zotero
   login (zotero mode); per-user keys encrypted at rest (`ZOTEUS_OAUTH_STORE=file` +
   `ZOTEUS_OAUTH_TOKEN_SECRET`); GDPR data-processor posture for stored Zotero keys.

Submit per Anthropic's directory process (or email `mcp-review@anthropic.com`). Track as an
external, async review — not gated on code.

---

## 9. Rollback

- Bad version published: `npm deprecate @oscardvs/zoteus@X.Y.Z "reason"` and ship a patch.
- **Do not `npm unpublish`** after 72 h (and avoid it generally — it breaks installs).
- Re-tag a corrected `vX.Y.(Z+1)`; the registry/DXT/image follow from the new tag.
