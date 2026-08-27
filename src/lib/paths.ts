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
