import {
  SearchIndex,
  type IndexBuildStatus,
  type SearchHit,
  type SearchIndexOptions,
} from './index-manager.js';

/**
 * The search database is unreadable. Raised instead of letting SQLite's own message escape
 * as an opaque failure — ticket 0010.
 *
 * `search-index.sqlite` had no corruption path at all: `Fts5PassageStore` opened the file,
 * prepared its statements, and assumed success forever after. On `SQLITE_CORRUPT` or
 * `SQLITE_NOTADB` the error propagated out of `search()` into `SearchIndex.query()`, whose
 * only try/catch is around the embedder. So a corrupt index did not degrade — it failed
 * every query, and failed it again after a restart, reporting something the caller could
 * not act on.
 */
export class SearchIndexCorruptError extends Error {
  readonly dbPath: string;
  readonly detail: string;

  constructor(dbPath: string, detail: string) {
    super(corruptionMessage(dbPath, detail));
    this.name = 'SearchIndexCorruptError';
    this.dbPath = dbPath;
    this.detail = detail;
  }
}

/**
 * SQLite's own vocabulary for "this file is not a usable database".
 *
 * Matched on the message rather than an error code because `node:sqlite` does not surface
 * `SQLITE_CORRUPT` as a stable numeric field, and because these strings are part of
 * SQLite's public interface: they appear in its documentation and have not changed in the
 * lifetime of the 3.x series.
 *
 * Deliberately narrow. A busy database, a read-only filesystem and a missing table are all
 * failures, and none of them is corruption — widening this list would turn every transient
 * fault into a message telling the user to delete their index.
 */
const CORRUPTION_SIGNS = [
  'database disk image is malformed',
  'file is not a database',
  'file is encrypted or is not a database',
  'malformed database schema',
  'database corruption',
  'sqlite_corrupt',
  'sqlite_notadb',
];

/** True when `e` says the database file itself is unusable, not that an operation failed. */
export function isCorruptionError(e: unknown): boolean {
  if (e instanceof SearchIndexCorruptError) return true;
  const text = (e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e)).toLowerCase();
  return CORRUPTION_SIGNS.some((sign) => text.includes(sign));
}

/**
 * Name the cause and the command, because the caller cannot act on either otherwise.
 *
 * **Refuse and report, never rebuild** — the position the author settled on 2026-08-22.
 * The index is derived data and could in principle be discarded and rebuilt, which is why
 * an automatic rebuild looked attractive: unlike Zotero's own corruption handler, we would
 * lose nothing but time. Time is the objection. A rebuild re-crawls the whole library —
 * 339 s on the 7 540-item library that motivated this, and that with full text on — and
 * the caller here is an agent in the middle of somebody's task. It cannot consent to an
 * unrequested rebuild of that length on their behalf, and an MCP tool that silently
 * disappears for several minutes is worse than one that says what is wrong.
 *
 * Deleting the file is also what keeps this clear of the trap a partial rebuild walks
 * into. 0006's watermark lives in `index_meta`, *inside the same database*: a rebuild that
 * dropped the passage tables and left `index_meta` standing would leave an empty index
 * claiming to be current, and the freshness check would compare equal and serve nothing,
 * forever — worse than the corruption, because it presents as an empty library rather than
 * an error. Removing the file removes the watermark with it, by construction.
 */
export function corruptionMessage(dbPath: string, detail: string): string {
  return (
    `The search index at ${dbPath} is unreadable — SQLite reports: ${detail}. ` +
    'It will not be rebuilt automatically: rebuilding re-reads the whole Zotero library and takes ' +
    'minutes to tens of minutes, which is not a decision to take inside somebody\'s query. ' +
    'The index is derived data, so deleting it loses nothing but that time. To recover, stop the ' +
    `server, remove the file and its write-ahead sidecars, restart, and rebuild:\n` +
    `  rm ${JSON.stringify(dbPath)} ${JSON.stringify(dbPath + '-wal')} ${JSON.stringify(dbPath + '-shm')}\n` +
    '  then call the zotero_index tool with action "build" (add fulltext:true if you index attachment text).\n' +
    'Deleting the file is also what clears the delta watermark, which lives inside it: a rebuild in ' +
    'place that left the watermark standing would produce an empty index claiming to be current.'
  );
}

/** Rethrow anything that is corruption as the typed error, and everything else unchanged. */
export function rethrowCorruption(e: unknown, dbPath: string): never {
  if (e instanceof SearchIndexCorruptError) throw e;
  if (isCorruptionError(e)) throw new SearchIndexCorruptError(dbPath, e instanceof Error ? e.message : String(e));
  throw e;
}

/**
 * The index the server holds when the database could not be opened at all.
 *
 * Not an empty index, and that is the entire design. An empty `SearchIndex` here would
 * answer every query with no hits, which reads to an agent exactly like a library with
 * nothing in it — the failure mode 0010 calls "worse than the corruption it replaced". So
 * every operation that would consult or write the index refuses, loudly, with the message
 * naming the file and the command.
 *
 * The rest of the server is untouched: item lookups, bibliographies and full-text reads go
 * to Zotero and never through here, so one bad derived file does not take the whole MCP
 * server down with it.
 */
export class CorruptSearchIndex extends SearchIndex {
  constructor(
    opts: SearchIndexOptions,
    readonly failure: SearchIndexCorruptError,
  ) {
    super(opts);
  }

  /** Nothing to bring up to date; a delta must never be attempted against this. */
  get supportsDelta(): boolean {
    return false;
  }

  /**
   * Reported as non-empty so no caller mistakes this for a library awaiting its first
   * build and helpfully starts one. `zotero_semantic_search`'s auto-build is the caller
   * that would.
   */
  get isEmpty(): boolean {
    return false;
  }

  async query(): Promise<SearchHit[]> {
    throw this.failure;
  }

  async buildIncremental(): Promise<IndexBuildStatus> {
    throw this.failure;
  }

  buildStatus(): IndexBuildStatus {
    return { ...super.buildStatus(), state: 'error', lastError: this.failure.message };
  }
}
