import { homedir } from 'node:os';
import { join } from 'node:path';

/** OS-appropriate default data directory for Zoteus caches and the search index. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ZOTEUS_DATA_DIR) return env.ZOTEUS_DATA_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'zoteus');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'zoteus');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'zoteus');
}
