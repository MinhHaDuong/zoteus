import { homedir } from 'node:os';
import { join } from 'node:path';
import { isUnset } from './env.js';

/** OS-appropriate default data directory for Zoteus caches and the search index. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  // Not `if (env.ZOTEUS_DATA_DIR)`: blank is falsy, but an unsubstituted reference is not,
  // and returning one makes a directory named after the reference (#18).
  if (env.ZOTEUS_DATA_DIR && !isUnset(env.ZOTEUS_DATA_DIR)) return env.ZOTEUS_DATA_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'zoteus');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'zoteus');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'zoteus');
}

/**
 * OS-appropriate default data directory of the ZOTERO desktop app (not Zoteus's own).
 *
 * Zotero keeps attachment files under `<data dir>/storage/<attachment key>/`, which is the
 * only copy a local-only library or a library with no storage quota has. Reading it lets a
 * Zoteus sharing the machine open an attachment while Zotero is closed, when neither the
 * desktop local API nor a cloud download can reach the bytes.
 *
 * The app lets a user move that directory, and the moved location lives in its own prefs
 * rather than anywhere Zoteus can see, so `ZOTERO_DATA_DIR` overrides the default. A
 * directory that is not there is simply skipped, so a hosted Zoteus loses nothing by
 * looking.
 */
export function defaultZoteroDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZOTERO_DATA_DIR && !isUnset(env.ZOTERO_DATA_DIR)) return env.ZOTERO_DATA_DIR;
  // Zotero's own default on every platform it ships for: a `Zotero` folder in the home
  // directory (`%USERPROFILE%\Zotero` on Windows, which is what `homedir()` returns).
  return join(homedir(), 'Zotero');
}
