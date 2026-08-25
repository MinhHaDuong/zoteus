import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IndexSnapshot } from './backend.js';

/** What the JSON artifact needs from an index: the legacy backend, or a test double. */
export interface JsonIndex {
  toJSON(): IndexSnapshot;
  loadFromJSON(data: IndexSnapshot): void;
}

/**
 * Atomically persist the index: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write can therefore never leave a corrupt or
 * half-written search-index.json — readers see either the previous complete snapshot
 * or the new one.
 *
 * JSON.stringify is also this backend's ceiling: it builds the whole file as one V8
 * string, which cannot exceed ~512 MB, and the failure is a plain throw the caller has
 * to surface (see persistNotice in build.ts). Large libraries belong on the SQLite
 * backend, which writes rows.
 */
export async function saveIndex(index: JsonIndex, path: string): Promise<void> {
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

export async function loadIndex(index: JsonIndex, path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, 'utf8');
    index.loadFromJSON(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
}
