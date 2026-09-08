# Third party notices

Zoteus itself is MIT licensed; see [`LICENSE`](./LICENSE). This file records the notices its
third party dependencies ask a redistributor to carry.

It matters most for the artefacts that ship dependency code inside them. The per-OS `.mcpb`
bundles attached to each GitHub release and the container image published to
`ghcr.io/oscardvs/zoteus` both install the production dependency tree with
`npm ci --omit=dev` and carry the resulting `node_modules` whole. The npm package
`@oscardvs/zoteus` does not: its `files` list is `dist`, `README.md`, `LICENSE` and this
file, so `npm install` resolves every dependency from the registry instead. This file is
carried in all three so that the notice travels with the code wherever it goes.

## citeproc-js (npm package `citeproc`)

Zoteus formats bibliographies with [citeproc-js](https://github.com/Juris-M/citeproc-js),
which it uses unmodified as an npm dependency. It is the one dependency in the production
tree that is not under a permissive licence.

The package's `LICENSE` offers a choice of two:

> Copyright (c) 2009-2019 Frank Bennett
>
> This program is free software: you can redistribute it and/or modify it under EITHER
>
> - the terms of the Common Public Attribution License (CPAL) as published by the Open
>   Source Initiative, either version 1 of the CPAL, or (at your option) any later version;
>   OR
> - the terms of the GNU Affero General Public License (AGPL) as published by the Free
>   Software Foundation, either version 3 of the AGPL, or (at your option) any later
>   version.

**Zoteus takes the CPAL option.** citeproc-js is redistributed here under the
Common Public Attribution License 1.0, and not under the AGPL. Zoteus's own source is MIT
licensed and is not offered under the AGPL.

Section 14 of the CPAL asks that the Attribution Information the Original Developer names in
Exhibit B be displayed each time a session begins, on the graphic user interface used to
reach the covered code, if there is one. Exhibit B of the CPAL as published in the
citeproc-js repository reads:

> EXHIBIT B. Attribution Information
>
> Attribution Copyright Notice: (c) Frank Bennett
>
> Attribution Phrase (not exceeding 10 words): citeproc-js implements the Citation Style Language
>
> Attribution URL: https://citationstyles.org/
>
> Graphic Image as provided in the Covered Code, if any.
>
> Display of Attribution Information is required in Larger Works which are defined in the CPAL as a work which combines Covered Code or portions thereof with code not governed by the terms of the CPAL.

citeproc-js provides no graphic image, so there is none to display.

Zoteus is an MCP server and has no window of its own. Its two text surfaces stand in for the
splash screen Section 14 describes, and both carry the attribution:

- The server writes it once per process to its log stream (stderr, never stdout, which
  carries JSON-RPC on the stdio transport).
- `zotero_whoami`, the tool the server's own instructions tell every client to call first,
  returns it in its summary text and in its structured `attribution` field, so it reaches
  the person using the client once per session.

Links: [citeproc-js](https://github.com/Juris-M/citeproc-js) ·
[CPAL 1.0](https://opensource.org/licenses/CPAL-1.0) ·
[Citation Style Language](https://citationstyles.org/)

## Everything else in the production tree

Every other production dependency is under a permissive licence. Taken from the `license`
field npm records in `package-lock.json` for each entry not marked `dev`, the tree that
`npm ci --omit=dev` installs held 107 packages at the time of writing (Zoteus 1.16.0): 95
MIT, 7 ISC, 2 BSD-3-Clause, 1 BSD-2-Clause, 1 Apache-2.0, and citeproc above.

The ones that are neither MIT nor ISC, each of which asks that its copyright notice and
licence text be kept with any redistribution:

| Package             | Licence      | Role                                                |
| ------------------- | ------------ | --------------------------------------------------- |
| `pdfjs-dist`        | Apache-2.0   | PDF text extraction (optional dependency)            |
| `fast-uri`          | BSD-3-Clause | URI parsing, via `ajv`                               |
| `qs`                | BSD-3-Clause | query-string parsing, via `express`                  |
| `json-schema-typed` | BSD-2-Clause | JSON Schema types, via `@modelcontextprotocol/sdk`   |

Each of these ships its own licence file inside its package directory, and the `.mcpb`
bundles and the container image carry those directories whole, so the text travels with the
code. `pdfjs-dist` ships no `NOTICE` file, so Apache-2.0 section 4(d) adds nothing here.

This is a record of what the dependency licences say, not legal advice.
