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
