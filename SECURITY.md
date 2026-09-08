# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use one of these two channels:

1. **GitHub private vulnerability reporting.** On the repository's Security tab, choose
   *Report a vulnerability*, or go straight to
   <https://github.com/oscardvs/zoteus/security/advisories/new>. The report is visible only
   to you and the maintainer, and the fix and the advisory are coordinated in that thread.
2. **Email** <support@zoteus.com>. Say in the first message if you want to encrypt, and a key
   will come back.

Include what you can: the Zoteus version, how it runs (stdio under a desktop client, the
HTTP transport, the container, or the hosted instance at `mcp.zoteus.com`), the library
mode (local API, cloud key, or both), and steps to reproduce.

## What to expect

- An acknowledgement within three working days, and a first assessment within a week.
- A fix ships in the next release as soon as it is ready, with a `Fixed` entry in
  [`CHANGELOG.md`](./CHANGELOG.md). When the entry would disclose a problem that also
  affects the hosted instance, `mcp.zoteus.com` is deployed first and the notes go public
  after.
- Credit in the changelog and the advisory, if you want it.

## Scope

In scope: the `@oscardvs/zoteus` npm package, the `zoteus.mcpb` bundle, the
`ghcr.io/oscardvs/zoteus` image, and the hosted instance at `mcp.zoteus.com`.

Out of scope: Zotero itself and its local or Web API (report those to Zotero), and the MCP
clients that connect to Zoteus.

## Supported versions

Only the latest release receives fixes. There are no maintenance branches; upgrade to the
newest npm release or `.mcpb` bundle.

## A frozen dependency: `pdfjs-dist`

`pdfjs-dist` is pinned to exactly 5.6.205, the last release that runs on the Node 20.19
floor this package declares. Every release after it (5.7.284 and the whole 6.x line) needs
Node 22.13 or newer, so the PDF parser cannot be moved without raising that floor.

The visible cost is that `npm audit` reports GHSA-hq66-cqwq-w95j (CVE-2026-16633,
"arbitrary JavaScript execution upon opening a malicious PDF", fixed in 6.2.108) against
the pin, and will report the next pdfjs advisory the same way.

That advisory does not reach Zoteus. It is a viewer flaw: it needs a rendered
`AnnotationLayer` with `enableScripting` on, which is a default of the bundled *viewer*
(`web/pdf_viewer.mjs`), not of the parsing API. Zoteus imports only the API build
(`pdfjs-dist/legacy/build/pdf.mjs`), calls `getDocument({ data, useSystemFonts: true,
isEvalSupported: false })`, and reads `getTextContent()`, `getOutline()` and page geometry.
It builds no viewer, renders no annotation layer, and never loads `pdf.sandbox.mjs`, which
is the file that would run a PDF's JavaScript. The parser also degrades to null on any
failure rather than throwing, and refuses files over 20 MB before parsing them.

Raising the floor to Node 22.13 is what unfreezes the dependency. It is tracked in
[#69](https://github.com/oscardvs/zoteus/issues/69), along with the guard
(`tests/node-floor.test.ts`) that fails if the pin ever drifts past the declared floor.
