# Getting started (no code required)

> **You do NOT need to download the ZIP from GitHub, and you do NOT need to write any code.** Zoteus installs itself the first time your AI app runs it — you only ever touch one settings screen. Pick one of the two options below.

## Option A — One-click install (easiest, Claude Desktop)

1. Download **`zoteus.mcpb`** from the [latest release](https://github.com/oscardvs/zoteus/releases/latest) (under *Assets*).
2. **Double-click** the downloaded file.
3. Claude Desktop opens and shows you what Zoteus can do. Click **Add** to accept.
4. Restart Claude Desktop if it asks. That's it — skip to [Restart Claude Desktop and verify](#restart-claude-desktop-and-verify).

> Want to sync, change a group library, or work while Zotero is closed? Add a [Zotero API key](#what-is-the-zotero-api-key) in the extension's settings afterwards. Reading *and* changing your own library works without one while the desktop app is running, and on Zotero 10+ so does reading any group library the app holds.

> The same settings screen also tunes semantic search: whether PDF full text is indexed, how much of each document is indexed (*Full-text characters per item*, `0` for whole documents instead of the first 40000 characters), how many items a build crawls, and the embedding model, batch size and pause between embedding calls. Every field is optional: leave one empty to keep the default. See [Desktop extension settings](./configuration.md#desktop-extension-settings-mcpb).

## Option B — Manual setup (any MCP client, e.g. Claude Desktop)

### 1. Install Node.js (one time, ~2 minutes)

Zoteus runs on [Node.js](https://nodejs.org). Download the **LTS** version from <https://nodejs.org>, run the installer, and keep all the default choices. That's all — no terminal needed.

### 2. Open Claude Desktop's config file

In Claude Desktop: **Settings → Developer → Edit Config**. This opens a file named `claude_desktop_config.json`. If you prefer to open it yourself, it lives here:

| Operating system | Config file location |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

### 3. Paste this in

If the file is empty (or doesn't exist yet), paste exactly this:

```json
{
  "mcpServers": {
    "zoteus": {
      "command": "npx",
      "args": ["-y", "@oscardvs/zoteus"],
      "env": { "ZOTERO_API_KEY": "PASTE_YOUR_KEY_HERE" }
    }
  }
}
```

Replace `PASTE_YOUR_KEY_HERE` with your [Zotero API key](#what-is-the-zotero-api-key) — or read on if you don't have one yet (you may not need it).

**Already have `"mcpServers"` in the file?** Don't paste over it — just add the `"zoteus"` block *inside* the existing `"mcpServers"` object, separated by a comma from the other entries:

```json
{
  "mcpServers": {
    "some-other-server": { "...": "..." },
    "zoteus": {
      "command": "npx",
      "args": ["-y", "@oscardvs/zoteus"],
      "env": { "ZOTERO_API_KEY": "PASTE_YOUR_KEY_HERE" }
    }
  }
}
```

**Just want to work with your local Zotero library?** The key is optional — you can drop the whole `"env"` line and keep the rest as-is. See [below](#what-is-the-zotero-api-key) for when a key is and isn't needed.

Save the file, then [restart Claude Desktop](#restart-claude-desktop-and-verify).

## What is the Zotero API key?

A Zotero API key is a password-like string that lets Zoteus talk to your Zotero account on the web. **It is optional whenever the Zotero desktop app is running** — Zoteus then reads *and* writes your own library through the app. On Zotero 10+ the app also serves any **group library** it holds, so reading those needs no key either. You need a key for sync, for changing a group library, for reading a group the app does not hold, and for changes made while the app is closed.

### Creating a key (if you want one)

1. Go to <https://www.zotero.org/settings/keys> and sign in.
2. Click **Create new private key**, give it any name (e.g. "Zoteus").
3. Under permissions, tick **"Allow library access"** — that's the only box needed for reading. Only tick the write-related boxes if you want Claude to add or edit items in your library.
4. Copy the generated key and paste it into the `ZOTERO_API_KEY` field of your config (Option B) or the extension settings (Option A).

### No key needed: the Zotero desktop app

If you use the **Zotero 7 (or newer) desktop app**, Zoteus can work with your library straight from the app on your machine — no key, no account lookup:

1. Open Zotero → **Settings → Advanced**.
2. Enable **"Allow other applications on this computer to communicate with Zotero"**.
3. Keep Zotero running while you chat with Claude.

This key-free mode covers searching (keyword *and* semantic, including the one-time index build), reading, bibliographies, and PDF text from your own library — and adding items, filing attachments, highlighting PDFs, and trashing items, which go straight into the running app. (The first such change may pop up a one-time Zotero dialog asking whether to allow Zoteus to make changes; choose **Always Allow**.) On Zotero 10+ it also covers reading any **group library** the app holds. You'd add an API key only to **sync, change a group library, reach a group the app does not hold, or make changes while Zotero is closed**.

## Restart Claude Desktop and verify

Config changes only take effect after a **full quit and restart** — closing the window is not enough:

- **Windows:** in Claude Desktop choose **File → Exit**, then open it again.
- **macOS:** press **⌘Q** (Claude → Quit), then open it again.

**How to tell it worked:** start a new chat and look for the tools/extensions icon in the message box — Zoteus should be listed with its `zotero_*` tools. You can also just ask: *"List your Zotero tools."*

Try one of these first prompts:

1. *"Search my library for papers about urban heat islands."*
2. *"Format a bibliography of the five most relevant papers in APA style."*
3. *"Add this paper to my Zotero library by DOI: 10.1038/s41586-021-03819-2."*

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npx: command not found` | Node.js isn't installed (or wasn't picked up). Install the LTS from <https://nodejs.org>, then fully restart Claude Desktop. |
| Zoteus tools don't appear | Quit Claude Desktop **fully** (File → Exit / ⌘Q) and reopen it. If you used Option B, also re-check the JSON for a missing comma or quote. |
| First search/index build is slow on a big library | Normal — the index is built once and cached. See [`semantic-search.md`](./semantic-search.md). |
| Reads fail with no key set | Make sure the Zotero desktop app is running and the **Settings → Advanced** toggle is on (see [above](#no-key-needed-the-zotero-desktop-app)). |
