/**
 * What it means for a search index's STORE to be unusable, and how to say so.
 *
 * Deliberately free of any dependency on the index classes themselves. `persistence.ts` is
 * imported by `index-manager.ts` and needs these errors, so anything they live beside must
 * not import back into the index — that cycle leaves `SearchIndexBase` undefined at the
 * moment `CorruptSearchIndex` extends it, and every search module fails to load.
 */

/**
 * The SQLite search index cannot be read.
 *
 * Raised in place of SQLite's own sentence, which reaches the caller as a bare "database
 * disk image is malformed" naming neither the file nor anything to do about it.
 */
export class SearchIndexCorruptError extends Error {
  readonly detail: string;
  /**
   * Every file that has to go for this index to be rebuilt, main database last.
   *
   * Carried on the error rather than recomputed by whoever repairs it, so the repair can
   * only ever delete the files the refusal named. Two copies of that path arithmetic
   * would be one copy too many: the divergence would show up as a deletion nobody was
   * warned about.
   */
  readonly files: string[];

  constructor(
    readonly dbPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(corruptionMessage(dbPath, detail));
    this.detail = detail;
    this.files = sidecarsOf(dbPath);
    this.name = 'SearchIndexCorruptError';
  }
}

/**
 * A SQLite database and its write-ahead sidecars, in deletion order: sidecars first, the
 * database itself last. That order is not cosmetic. A fresh database created beside an
 * orphaned `-wal` is the one arrangement that can manufacture a second corruption out of
 * a repair, because SQLite would replay a log belonging to a file that no longer exists.
 */
export function sidecarsOf(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`, dbPath];
}

/**
 * A JSON search index artifact that exists but cannot be read back.
 *
 * Separate from the SQLite case only in what it names; the reasoning is identical, and so
 * is the remedy. Before this, a truncated `search-index.json` was swallowed into `false`
 * and became an empty index that reported itself healthy — and, worse, the next shutdown
 * flush wrote that emptiness back over the file (#21).
 */
export class SearchIndexUnreadableError extends Error {
  readonly detail: string;
  readonly files: string[];

  constructor(
    readonly path: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `The search index at ${path} cannot be read — ${detail}. Every other tool still works: only search is ` +
        'affected, because the index is a derived cache and nothing else reads it. Nothing will be written over ' +
        'it in this state, so the file is exactly as you found it. ' +
        repairAdvice([path]),
    );
    this.detail = detail;
    this.files = [path];
    this.name = 'SearchIndexUnreadableError';
  }
}

/**
 * The remedy, shared by both unreadable-store errors so the two cannot drift apart.
 *
 * Leads with the tool call rather than with `rm`, which is the change #21 asked for: the
 * people most likely to meet a damaged index are desktop `.mcpb` installs, and someone
 * with no shell open has no use for a shell command as their first instruction.
 */
function repairAdvice(files: string[]): string {
  const quoted = files.map((p) => JSON.stringify(p)).join(' ');
  return (
    'To repair it, call zotero_index with action:"build" (add fulltext:true if you index attachment text). ' +
    'That call deletes this file and its write-ahead sidecars, opens a fresh index in their place and rebuilds ' +
    'in the background; poll action:"status". It is the only thing that does: the index is never repaired ' +
    'automatically, neither at startup nor inside a query, because rebuilding re-reads the whole Zotero library ' +
    'and takes minutes to tens of minutes, which is not a job to begin without being asked. If a legacy ' +
    'search-index.json sits beside it, the fresh index imports that and the library is searchable straight away. ' +
    'If the files cannot be deleted (another process is holding them, or they are read-only), remove them by ' +
    `hand and restart:\n  rm ${quoted}`
  );
}

/** One sentence for the status fields that have room only to say the index is unusable. */
export const UNREADABLE = 'the search index cannot be read';

/**
 * SQLite's vocabulary for "this file is not a usable database". These strings are part of
 * SQLite's public interface: they are in its documentation and have not changed across
 * the 3.x series.
 *
 * Deliberately narrow. A locked database, a read-only filesystem and a missing table are
 * all failures and none of them is corruption; widening this list would turn a transient
 * fault into a message telling someone to delete their index.
 */
const CORRUPTION_SIGNS = [
  'database disk image is malformed',
  'file is not a database',
  'file is encrypted or is not a database',
  'malformed database schema',
  'database corruption',
];

/**
 * SQLite primary result codes for corruption: SQLITE_CORRUPT (11) and SQLITE_NOTADB (26).
 * `node:sqlite` sets `code` to the constant 'ERR_SQLITE_ERROR' on every error and carries
 * the real classification in numeric `errcode` and textual `errstr` — and the message can
 * be an unrelated wrapper: a corrupt FTS5 shadow table surfaces as "vtable constructor
 * failed: passages_fts" with errcode 11, which no message scan can recognize. Extended
 * codes put the primary code in the low byte, hence the mask.
 */
const CORRUPT_ERRCODES = new Set([11, 26]);

/** True when `e` says the file itself is unusable, not that one operation failed. */
export function isCorruptionError(e: unknown): boolean {
  if (e instanceof SearchIndexCorruptError) return true;
  const { errcode, errstr } = (e ?? {}) as { errcode?: number; errstr?: string };
  if (typeof errcode === 'number' && CORRUPT_ERRCODES.has(errcode & 0xff)) return true;
  const text = `${e instanceof Error ? e.message : String(e)} ${errstr ?? ''}`.toLowerCase();
  return CORRUPTION_SIGNS.some((sign) => text.includes(sign));
}

/**
 * Prefixes SQLite uses when it is rejecting the MATCH STRING a query just built, rather
 * than reporting that the index behind it is broken.
 *
 * Measured on this runtime, not recalled: `fts5: syntax error near "AND"`, `unknown
 * special query: bogus` and `no such column: nosuchcol` (an FTS5 column filter naming a
 * column the table has not got). All three are errcode 1 — and so is `no such table:
 * passages`, which is a broken index and must never be mistaken for a bad query. The
 * errcode therefore cannot separate them and the prefix has to.
 */
const QUERY_SYNTAX_PREFIXES = ['fts5: ', 'unknown special query: ', 'no such column: '];

/**
 * True only when SQLite rejected the query text, which is the one condition the catch in
 * `keywordSearch` was ever written for.
 *
 * It matters that this is narrow. That catch used to swallow everything and return no
 * hits, so `disk I/O error`, `no such table: passages`, a locked database and an
 * interrupted statement all reached the user as an empty library rather than as a fault
 * (#21). Anything this function does not claim now propagates.
 */
export function isQuerySyntaxError(e: unknown): boolean {
  const { errcode } = (e ?? {}) as { errcode?: number };
  // SQLITE_ERROR (1) is the generic "this statement is wrong" code; a query rejection is
  // always one, so anything else is some other kind of failure.
  if (typeof errcode === 'number' && (errcode & 0xff) !== 1) return false;
  const msg = e instanceof Error ? e.message : String(e);
  return QUERY_SYNTAX_PREFIXES.some((prefix) => msg.startsWith(prefix));
}

/**
 * The message the refusal carries, which is the whole of what a caller has to go on.
 *
 * It says why there is no automatic rebuild; what it does not say, and the reason deleting
 * the file is the recovery rather than emptying it, is the version stamp. That lives in the
 * `meta` table inside this same database. A repair that dropped the passage tables and left
 * `meta` standing would leave an empty index carrying a current stamp, and `action:"update"`
 * would then diff against passages that no longer exist — an empty library reporting itself
 * as up to date, which is worse than the error it replaced. Removing the file removes the
 * stamp with it, by construction.
 */
function corruptionMessage(dbPath: string, detail: string): string {
  return (
    `The search index at ${dbPath} cannot be read — SQLite reports: ${detail}. Every other tool still works: ` +
    'only search is affected, because the index is a derived cache and nothing else reads it. ' +
    repairAdvice(sidecarsOf(dbPath))
  );
}

