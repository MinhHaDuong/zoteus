import { join } from 'node:path';
import { Fts5PassageStore } from './fts5-store.js';
import { SearchIndex, type IndexBackend, type SearchIndexOptions } from './index-manager.js';

/** `index_meta` keys holding the watermark and its provenance. */
export const VERSION_KEY = 'builtFromVersion';
export const BACKEND_KEY = 'indexBackend';
/** `index_meta` key holding the items whose attachments await extraction (JSON array). */
export const PENDING_KEY = 'fulltextPending';
/**
 * Cap on pending item keys kept in `index_meta`. The set is a hint for reporting and for
 * re-probing, never a correctness requirement — the delta's `fullTextSince` sweep finds a
 * newly extracted attachment whether or not it was ever listed here — so it is bounded
 * rather than allowed to grow into a second index inside a scalar table.
 */
export const MAX_PENDING_KEYS = 2000;

/**
 * Beside `search-index.json`, not instead of it, so the two backends coexist on disk and a
 * user can go back and forth without losing either index.
 */
export function defaultSearchDbPath(dataDir: string, zoteroUserId?: number): string {
  return join(dataDir, zoteroUserId !== undefined ? `search-index-${zoteroUserId}.sqlite` : 'search-index.sqlite');
}

/**
 * A SearchIndex whose passages live in SQLite/FTS5 rather than in the JS heap.
 *
 * Everything else — the incremental build, the embedder plumbing, status reporting, the
 * JSON round trip — is inherited unchanged: the only difference is which PassageStore the
 * base class was handed. Nothing wires this into the server yet; it shadows the resident
 * index rather than replacing it.
 */
export class SqliteSearchIndex extends SearchIndex {
  /**
   * The same connection the base class holds, typed. Kept here because `getMeta`/`setMeta`
   * are deliberately not on the PassageStore port (a Map has no answer for them), and the
   * watermark has to be written through something.
   */
  private readonly db: Fts5PassageStore;

  constructor(opts: SearchIndexOptions & { dbPath: string }) {
    // Legal before `super()` because it touches no `this`; the store must exist before the
    // base constructor runs, and reopening the file a second time afterwards would give
    // two connections onto one database.
    const opened = openStore(opts.dbPath);
    super({ ...opts, ...opened });
    this.db = opened.store;
  }

  /**
   * Deltas live here and nowhere else. `passage_meta` carries a real index on `item`, so
   * dropping one item's passages costs nothing — which is the entire affordability
   * argument for bringing the index up to date instead of rebuilding it.
   */
  get supportsDelta(): boolean {
    return true;
  }

  /**
   * Write the watermark back. The base class does nothing here because its snapshot
   * carries the value; this backend has no snapshot, so without this the version restored
   * at construction was the only one that ever existed and every later build left it
   * stale — the gap ticket 0005 recorded.
   *
   * The label is DELETED rather than blanked when absent. Absence is a real state — an
   * index built before labels existed, or one built by `build()`, which knows no backend —
   * and the delta refuses a watermark it cannot attribute. An empty string would read as
   * an attribution.
   */
  protected recordWatermark(): void {
    const { version, backend } = this.watermark;
    this.db.setMeta(VERSION_KEY, String(version));
    if (backend) this.db.setMeta(BACKEND_KEY, backend);
    else this.db.deleteMeta(BACKEND_KEY);
    const pending = this.fulltextPendingItems.slice(0, MAX_PENDING_KEYS);
    if (pending.length) this.db.setMeta(PENDING_KEY, JSON.stringify(pending));
    else this.db.deleteMeta(PENDING_KEY);
  }

  /**
   * The JSON snapshot interface, refused rather than emulated.
   *
   * Throwing is the decision worth defending, because both alternatives are worse and
   * neither would show up as a failing test. Returning an empty structure lets
   * `saveIndex` write a valid, empty `search-index.json` over a good one — data loss with
   * a green suite. Returning the real rows works, and quietly does the one thing this
   * backend exists to avoid: `values()` materialises every passage in the library into
   * the JS heap, which on the corpus that motivated the ticket is the out-of-memory
   * condition itself.
   *
   * Nothing on the SQLite path should reach here — `server.ts` leaves `searchIndexPath`
   * undefined, so no persist callback is built and `flushIndexes` skips the context. This
   * is the guard against the caller that has not been written yet.
   */
  toJSON(): never {
    throw new Error(UNSUPPORTED('toJSON'));
  }

  loadFromJSON(): never {
    throw new Error(UNSUPPORTED('loadFromJSON'));
  }
}

/**
 * Open the store and recover what the database knows about itself: the watermark, the
 * client that produced it, and the items whose attachments await extraction. Passage and
 * vector counts are recovered by the base class straight from the tables.
 *
 * A free function because it must run before `super()` and must reuse the one connection
 * rather than opening a second against the same file.
 *
 * The label is the part worth reading twice. A database written before this ticket has a
 * `builtFromVersion` holding an ITEM COUNT and no label at all — 7540 where the local API
 * reports 200. Restoring the number without a label is exactly what makes that harmless:
 * an unlabelled watermark is refused by the freshness check and the index is rebuilt once,
 * rather than a delta being computed against a number from another quantity entirely.
 */
function openStore(dbPath: string): {
  store: Fts5PassageStore;
  builtFromVersion: number;
  indexBackend?: IndexBackend;
  fulltextPending?: string[];
} {
  const store = new Fts5PassageStore(dbPath);
  const raw = store.getMeta(VERSION_KEY);
  const parsed = raw === undefined ? NaN : Number(raw);
  const label = store.getMeta(BACKEND_KEY);
  const out: { store: Fts5PassageStore; builtFromVersion: number; indexBackend?: IndexBackend; fulltextPending?: string[] } = {
    store,
    builtFromVersion: Number.isFinite(parsed) ? parsed : 0,
  };
  if (label === 'local' || label === 'web') out.indexBackend = label;
  const pending = readPending(store.getMeta(PENDING_KEY));
  if (pending) out.fulltextPending = pending;
  return out;
}

/** Tolerant of anything but a JSON array of strings: a bad hint must not fail a startup. */
function readPending(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    return undefined;
  }
}

const UNSUPPORTED = (method: string): string =>
  `${method}() is not available under ZOTEUS_SEARCH_BACKEND=sqlite: the database is the index, ` +
  'not a snapshot of one. Use the json backend if you need search-index.json.';
