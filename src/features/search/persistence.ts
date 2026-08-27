import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SearchIndexUnreadableError } from './store-faults.js';
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

/**
 * Read the JSON artifact back into `index`.
 *
 * The two failures are not the same thing and must not be answered the same way.
 *
 * Not being able to OPEN the file means there is no previous index to load: a first run, or
 * a path that cannot hold one. That is benign here and returns false; if the path is also
 * unwritable, the build's own `persistError` is what reports it, and reporting it twice
 * would tell someone their index is damaged when nothing has ever been written to it.
 *
 * Failing to PARSE bytes that were read is the other case, and it used to be swallowed into
 * the same false. That produced an empty index which reported itself healthy — and since
 * `loadFromJSON` resets before it parses, the next shutdown flush wrote the emptiness back
 * over the user's file, destroying the index the failure was about (#21). So it throws.
 */
export async function loadIndex(index: JsonIndex, path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return false;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new SearchIndexUnreadableError(path, e);
  }
  // Parsing is not the same as recognising. `loadFromJSON` validates nothing — it resets,
  // then reads `data.chunks ?? []` — so a file that is valid JSON of some other shape
  // loads as a healthy EMPTY index with no fault, and the next save writes that emptiness
  // over it. That is the same data loss a truncated file used to cause, by a different
  // route, so the shape is checked here rather than trusted (#21).
  if (!isSnapshot(data)) {
    throw new SearchIndexUnreadableError(
      path,
      new Error('the file is valid JSON but is not a Zoteus search index (no `chunks` array)'),
    );
  }
  index.loadFromJSON(data);
  return true;
}

/** The one field that identifies the artifact; everything else `loadFromJSON` defaults. */
function isSnapshot(data: unknown): data is IndexSnapshot {
  return typeof data === 'object' && data !== null && Array.isArray((data as IndexSnapshot).chunks);
}
