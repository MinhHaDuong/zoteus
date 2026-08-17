import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SearchIndex } from './index-manager.js';

/**
 * Atomically persist the index: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write can therefore never leave a corrupt or
 * half-written search-index.json — readers see either the previous complete snapshot
 * or the new one.
 */
export async function saveIndex(index: SearchIndex, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(tmp, JSON.stringify(index.toJSON()));
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function loadIndex(index: SearchIndex, path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    index.loadFromJSON(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}
