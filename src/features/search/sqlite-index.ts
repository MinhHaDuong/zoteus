import { createRequire } from 'node:module';
import type { DatabaseSync as Database, StatementSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SearchIndexBase } from './index-manager.js';
import { tokenize } from './tokenize.js';
import { SearchIndexCorruptError, isCorruptionError, isQuerySyntaxError, sidecarsOf } from './corruption.js';
import type { ChunkRecord, IndexCounts, IndexSnapshot, RankedId, SearchIndexOptions } from './backend.js';

/**
 * Required through createRequire rather than imported: `sqlite` is absent from
 * `module.builtinModules` while it is experimental, so bundlers and test runners try to
 * resolve `node:sqlite` from disk and fail. Node itself requires it as the builtin it is.
 * This module is only ever loaded after the factory has confirmed the runtime has it.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Ceiling on a legacy search-index.json this backend will import. Above it the parse is
 * the very wall this backend exists to remove: a 463 MB file needs ~5.4 GB of heap and
 * OOMs stock Node, so the file is left alone and status asks for a rebuild instead (#10).
 */
export const MAX_MIGRATION_BYTES = 200 * 1024 * 1024;

/**
 * Bumped only when the schema below changes shape; a file at any other version is rebuilt,
 * not patched. Enforced in open(): the stamp is read before any DDL or write touches the
 * file, and a database this build does not understand is moved aside, never written into.
 */
const SCHEMA_VERSION = 1;

/**
 * How long a statement waits on another connection's lock before giving up. SQLite's
 * default is to fail instantly with "database is locked", which is wrong here: two Zoteus
 * processes legitimately share a data dir whenever a host runs a second, disposable server
 * alongside the real one (Claude Desktop probes that way), and instant failure took BOTH
 * of them down at startup (#18). Ten seconds outlasts any open() and any single build
 * commit, so the loser waits rather than dies.
 */
const BUSY_TIMEOUT_MS = 10_000;

export interface SqliteSearchIndexOptions extends SearchIndexOptions {
  /** Database file (':memory:' is accepted, for tests). */
  path: string;
  /** Legacy JSON artifact to import when this database is created. */
  migrateFrom?: string;
  /** Override for MAX_MIGRATION_BYTES (tests exercise the refusal without a 200 MB fixture). */
  maxMigrationBytes?: number;
}

interface PassageRow {
  id: string;
  item_key: string;
  title: string;
  text: string;
  source: string | null;
}

/** Statements prepared once at open(): every write in a build goes through them. */
interface Statements {
  insertItem: StatementSync;
  insertPassage: StatementSync;
  insertFts: StatementSync;
  deleteFts: StatementSync;
  itemPassages: StatementSync;
  deletePassages: StatementSync;
  deleteItemRow: StatementSync;
  itemKeys: StatementSync;
  setVector: StatementSync;
  selectPassage: StatementSync;
  keyword: StatementSync;
  vectors: StatementSync;
  vectorWidth: StatementSync;
  setMeta: StatementSync;
  getMeta: StatementSync;
}

/**
 * SQLite (FTS5) backend. Passages, their vectors and the keyword index live in one file,
 * so the index is bounded by disk rather than by heap: building it costs a few hundred MB
 * of resident memory instead of several GB, reopening it is an open() rather than a parse,
 * and a keyword query touches only the rows it ranks.
 *
 * Requires Node's built-in `node:sqlite` (Node 22.13+), which is why this module is
 * imported dynamically and only after the factory has detected it.
 */
export class SqliteSearchIndex extends SearchIndexBase {
  readonly storage = 'sqlite' as const;
  readonly supportsDelete = true;
  private db: Database | undefined;
  private stmts!: Statements;
  /** True while a write transaction is open; save() is what commits it. */
  private inTransaction = false;
  private c: IndexCounts = { documents: 0, vectors: 0, items: 0, fulltextItems: 0, fulltextPassages: 0 };
  /**
   * Item keys that own full-text passages, so `fulltextItems` stays a distinct count.
   * Bounded by the number of ITEMS (thousands), never by passages: the passages and their
   * vectors are exactly what must not become resident.
   */
  private fulltextKeys = new Set<string>();
  /** Vector scans performed. A keyword-only query must never cause one (#10). */
  private vectorScans = 0;
  private readonly file: string;
  private readonly migrateFrom: string | undefined;
  private readonly maxMigrationBytes: number;

  constructor(opts: SqliteSearchIndexOptions) {
    super(opts);
    this.file = opts.path;
    this.migrateFrom = opts.migrateFrom;
    this.maxMigrationBytes = opts.maxMigrationBytes ?? MAX_MIGRATION_BYTES;
  }

  /** Open (creating it if needed) the database, importing a legacy JSON index once. */
  async open(): Promise<void> {
    if (this.file !== ':memory:') await mkdir(dirname(this.file), { recursive: true });
    // Checked before the handle is created, because creating it creates the file.
    const existed = this.file !== ':memory:' && existsSync(this.file);
    try {
      // Read before write: the stamp of an existing file is examined before any DDL or
      // connection pragma touches it. Doing it the other way around — createSchema first —
      // re-stamped a database written by a newer build and then misread it, destroying the
      // one piece of evidence the stamp exists to carry at exactly the moment it mattered.
      if (existed) await this.sidelineIfIncompatible();
      this.openHandle();
      this.createSchema();
      this.prepareStatements();
      // `existed` deliberately still gates the import after a sideline: the legacy JSON
      // was already consumed by whichever build wrote the incompatible database, and
      // re-importing it here would resurrect stale data next to the moved-aside truth.
      if (!existed && this.migrateFrom) await this.importJson(this.migrateFrom);
      this.refreshCounts();
      this.loadMeta();
    } catch (e) {
      if (!isCorruptionError(e) && !(e instanceof SearchIndexCorruptError)) throw e;
      // The handle may exist, so this object owns it and must release it before handing
      // the failure on. Not housekeeping: the message names three files for the user to
      // delete, and on Windows an open handle refuses the delete — a server holding them
      // would block the recovery it is prescribing.
      await this.close().catch(() => {});
      throw e instanceof SearchIndexCorruptError ? e : new SearchIndexCorruptError(this.file, e);
    }
  }

  /** Create the writable handle and apply its connection pragmas, after the schema probe. */
  private openHandle(): void {
    this.db = new DatabaseSync(this.file);
    // Before anything that takes a lock, so every statement below inherits the wait.
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // WAL rather than the rollback journal: a build commits every few hundred items, and
    // WAL makes those commits cheap while still leaving a complete database behind a
    // crash (an interrupted build rolls back to its last commit, never a torn file).
    // Switching modes needs an exclusive lock that a second process can hold for as long
    // as it is connected, past any busy timeout — but the mode is a property of the file,
    // so that process has already set it and this one just inherits it. Failing to set a
    // mode the database is in is not worth refusing to open over.
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch (err) {
      if (isCorruptionError(err)) throw err;
      this.opts.logger?.debug(`Could not set journal_mode=WAL on ${this.file}: ${String(err)}`);
    }
    // NORMAL fsyncs at checkpoints instead of on every commit. A power cut can then cost
    // the last commits of a running build, which the next build replaces anyway, but it
    // can never cost the database itself.
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  /**
   * What an existing database says it is, read without writing anything.
   *
   * 'fresh' — no tables at all (a zero-byte file from a handle opened and dropped, which
   * SQLite treats as a valid empty database): safe to create the schema in.
   * 'unstamped' — tables exist but no readable integer stamp: an interrupted first
   * creation, or a file some other program put at this path. Not ours to write into.
   * Otherwise the integer the file is stamped with.
   */
  private storedSchemaVersion(db: Database): number | 'fresh' | 'unstamped' {
    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view')")
      .get() as { n: number };
    if (tables.n === 0) return 'fresh';
    // Inspect rather than catching SELECT failures: a missing or foreign-shaped meta
    // table means "unstamped", but a lock, I/O failure or interruption must propagate.
    // Treating every non-corruption error as an absent stamp could move a healthy database
    // merely because another legitimate Zoteus process held it for longer than the wait.
    const metaColumns = db.prepare('PRAGMA table_info(meta)').all() as Array<{ name: string }>;
    const names = new Set(metaColumns.map((column) => column.name));
    if (!names.has('key') || !names.has('value')) return 'unstamped';
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    const value = row?.value;
    if (value === undefined) return 'unstamped';
    const version = Number(value);
    return Number.isInteger(version) ? version : 'unstamped';
  }

  /**
   * Move a database this build must not write into out of the way, and open fresh.
   *
   * Sideline, never delete: the moved file is a complete database, evidence of the skew
   * and readable by whichever build stamped it. Sidecars travel with it — a fresh database
   * created beside an orphaned `-wal` is the one arrangement that can manufacture a
   * corruption out of this protection, because SQLite would replay a log belonging to a
   * file that no longer exists — and in sidecarsOf order, database last, so an interruption
   * mid-move can only strand sidecars beside the moved file, never beside the fresh one.
   * One notice, on the channel status already reports storage decisions on.
   */
  private async sidelineIfIncompatible(): Promise<void> {
    // A genuinely read-only probe makes the ordering enforceable rather than documentary:
    // in particular, journal_mode=WAL can rewrite bytes in the database header, so even
    // the normal writable connection pragmas must wait until the stamp has been accepted.
    const probe = new DatabaseSync(this.file, { readOnly: true });
    let stored: number | 'fresh' | 'unstamped';
    try {
      probe.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      stored = this.storedSchemaVersion(probe);
    } finally {
      probe.close();
    }
    if (stored === 'fresh' || stored === SCHEMA_VERSION) return;
    const dest = `${this.file}.incompatible-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      for (const src of sidecarsOf(this.file)) {
        const target = src === this.file ? dest : `${dest}${src.slice(this.file.length)}`;
        await rename(src, target).catch((e: NodeJS.ErrnoException) => {
          if (e?.code !== 'ENOENT') throw e;
        });
      }
    } catch (e) {
      // The file is readable — its stamp just said so — but it can neither be written into
      // nor moved aside. That is exactly the state CorruptSearchIndex exists to hold: the
      // server survives, search refuses naming this file, and an explicit
      // `zotero_index action:"build"` may clear it, with the consent that implies (#21).
      throw new SearchIndexCorruptError(this.file, e);
    }
    const said =
      stored === 'unstamped'
        ? 'carries tables but no schema stamp — an interrupted creation, or not a Zoteus index at all'
        : `is stamped schema version ${stored}, which this build does not understand`;
    this.storeNotice =
      `The search index at ${this.file} ${said}. ` +
      `It was moved aside to ${dest} (nothing was deleted) and a fresh index was created; ` +
      `rebuild it with zotero_index action:"build".`;
    this.opts.logger?.warn(this.storeNotice);
  }

  /**
   * Record damage discovered mid-flight and return the error to raise for it.
   *
   * Until this existed, a healthy-looking index that met corruption during a query threw
   * the right sentence and remembered nothing: its status stayed clean and the next call
   * went straight back to the same broken file. Recording it makes the refusal stick, and
   * is what lets `zotero_index action:"build"` see that there is something to repair.
   */
  private noteCorruption(cause: unknown): SearchIndexCorruptError {
    const fault = cause instanceof SearchIndexCorruptError ? cause : new SearchIndexCorruptError(this.file, cause);
    this.noteStoreFault(fault);
    return fault;
  }

  private get handle(): Database {
    if (!this.db) throw new Error('The SQLite search index is not open.');
    return this.db;
  }

  private createSchema(): void {
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS passages (
        pid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT,
        vector BLOB
      );
      CREATE INDEX IF NOT EXISTS passages_item ON passages(item_key);
      CREATE INDEX IF NOT EXISTS passages_source ON passages(source);
      -- External content: the passage text is stored once, in the passages table, and the
      -- index points back at it by rowid. remove_diacritics 2 folds accents, so "Bronte"
      -- finds "Brontë". The query side folds to match, in tokenize.ts, which is where the
      -- JSON backend folds too: one normalizer in front of the tokenizer both share.
      CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
        text,
        content='passages',
        content_rowid='pid',
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    this.handle
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)')
      .run('schemaVersion', String(SCHEMA_VERSION));
  }

  private prepareStatements(): void {
    const db = this.handle;
    this.stmts = {
      insertItem: db.prepare('INSERT OR IGNORE INTO items(item_key, title) VALUES (?, ?)'),
      insertPassage: db.prepare(
        'INSERT INTO passages(id, item_key, title, text, source) VALUES (?, ?, ?, ?, ?)',
      ),
      insertFts: db.prepare('INSERT INTO passages_fts(rowid, text) VALUES (?, ?)'),
      // The external-content delete protocol: FTS5 stores no text of its own, so a row is
      // retired by handing back the exact rowid and text that were indexed. A bare DELETE
      // on `passages` would leave the index pointing at a rowid that no longer resolves,
      // and the next query over those terms fails or returns a stale hit.
      deleteFts: db.prepare("INSERT INTO passages_fts(passages_fts, rowid, text) VALUES('delete', ?, ?)"),
      itemPassages: db.prepare(
        'SELECT pid, text, source, vector IS NOT NULL AS has_vector FROM passages WHERE item_key = ?',
      ),
      deletePassages: db.prepare('DELETE FROM passages WHERE item_key = ?'),
      deleteItemRow: db.prepare('DELETE FROM items WHERE item_key = ?'),
      itemKeys: db.prepare('SELECT item_key AS k FROM items'),
      setVector: db.prepare('UPDATE passages SET vector = ? WHERE id = ?'),
      selectPassage: db.prepare('SELECT id, item_key, title, text, source FROM passages WHERE id = ?'),
      // Deliberately never selects `vector`: a keyword query must not pull vectors into JS.
      keyword: db.prepare(`
        SELECT p.id AS id, bm25(passages_fts) AS rank
        FROM passages_fts JOIN passages p ON p.pid = passages_fts.rowid
        WHERE passages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
      vectors: db.prepare('SELECT id, vector FROM passages WHERE vector IS NOT NULL'),
      vectorWidth: db.prepare('SELECT length(vector) AS bytes FROM passages WHERE vector IS NOT NULL LIMIT 1'),
      setMeta: db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)'),
      getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    };
  }

  /** Open a write transaction on the first mutation; save() is what commits it. */
  private begin(): void {
    if (this.inTransaction) return;
    this.handle.exec('BEGIN');
    this.inTransaction = true;
  }

  private commit(): void {
    if (!this.inTransaction) return;
    this.handle.exec('COMMIT');
    this.inTransaction = false;
  }

  private meta(key: string): string | undefined {
    const row = this.stmts.getMeta.get(key) as { value?: string } | undefined;
    return row?.value;
  }

  private loadMeta(): void {
    this.builtFromVersion = Number(this.meta('builtFromVersion') ?? 0) || 0;
    this.itemsTotal = Number(this.meta('itemsTotal') ?? 0) || 0;
    this.itemsAvailable = Number(this.meta('itemsAvailable') ?? 0) || 0;
    this.vectorEmbedderId = this.meta('embedderId') || undefined;
    // Absent in databases written before incremental updates: version 0 blocks an update,
    // which is the safe answer (one full build stamps it and every later update is cheap).
    this.libraryVersion = Number(this.meta('libraryVersion') ?? 0) || 0;
    const backend = this.meta('libraryBackend');
    this.libraryBackend = backend === 'local' || backend === 'cloud' ? backend : undefined;
    // An index that HOLDS full-text passages counts as full-text-enabled, even before this
    // process runs a build of its own (same rule as the JSON backend's load).
    this.fulltextEnabled = this.c.fulltextPassages > 0;
    this.reconcileVectorProvenance();
  }

  private writeMeta(): void {
    const set = this.stmts.setMeta;
    set.run('builtFromVersion', String(this.builtFromVersion));
    set.run('itemsTotal', String(this.itemsTotal));
    set.run('itemsAvailable', String(this.itemsAvailable));
    set.run('embedderId', this.vectorEmbedderId ?? '');
    set.run('libraryVersion', String(this.libraryVersion));
    set.run('libraryBackend', this.libraryBackend ?? '');
  }

  private refreshCounts(): void {
    const db = this.handle;
    const one = (sql: string): number => Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    this.c = {
      documents: one('SELECT COUNT(*) AS n FROM passages'),
      vectors: one('SELECT COUNT(*) AS n FROM passages WHERE vector IS NOT NULL'),
      items: one('SELECT COUNT(*) AS n FROM items'),
      fulltextItems: 0,
      fulltextPassages: one("SELECT COUNT(*) AS n FROM passages WHERE source = 'fulltext'"),
    };
    this.fulltextKeys = new Set(
      (db.prepare("SELECT DISTINCT item_key AS k FROM passages WHERE source = 'fulltext'").all() as Array<{
        k: string;
      }>).map((r) => r.k),
    );
    this.c.fulltextItems = this.fulltextKeys.size;
  }

  /**
   * Import a legacy JSON index once, when this database is created. The file is left in
   * place: it is the fallback for a downgrade to an older Node, and nothing here needs to
   * delete a user's data to succeed.
   */
  private async importJson(jsonPath: string): Promise<void> {
    let bytes: number;
    try {
      bytes = (await stat(jsonPath)).size;
    } catch {
      return; // no legacy index: a fresh install, or one already migrated
    }
    if (bytes > this.maxMigrationBytes) {
      this.storeNotice =
        `A ${Math.round(bytes / 1024 / 1024)} MB search-index.json was found but NOT imported: reading it needs ` +
        'roughly ten times its size in heap and would crash the server, which is the limit this SQLite index ' +
        'removes. The JSON file was left untouched. Run zotero_index action:"build" once to rebuild the library ' +
        'into the SQLite index.';
      this.opts.logger?.warn(this.storeNotice);
      return;
    }
    let snapshot: IndexSnapshot;
    try {
      snapshot = JSON.parse(await readFile(jsonPath, 'utf8')) as IndexSnapshot;
    } catch (e) {
      this.storeNotice =
        `search-index.json could not be imported (${e instanceof Error ? e.message : String(e)}). ` +
        'Run zotero_index action:"build" to rebuild the index.';
      this.opts.logger?.warn(this.storeNotice);
      return;
    }
    this.begin();
    for (const rec of snapshot.chunks ?? []) {
      this.putItem(rec.itemKey, rec.title);
      this.putPassage(rec);
    }
    for (const v of snapshot.vectors ?? []) this.putVector(v.id, v.vector);
    this.builtFromVersion = snapshot.builtFromVersion ?? 0;
    this.itemsTotal = snapshot.itemsTotal ?? 0;
    this.itemsAvailable = snapshot.itemsAvailable ?? 0;
    this.vectorEmbedderId = snapshot.embedderId;
    this.writeMeta();
    this.commit();
    this.storeNotice =
      `Imported ${this.c.documents} passages and ${this.c.vectors} vectors from search-index.json into the ` +
      'SQLite index. The JSON file was left in place and is no longer read.';
    this.opts.logger?.info(this.storeNotice);
  }

  protected counts(): IndexCounts {
    return { ...this.c };
  }

  protected clearStore(): void {
    this.begin();
    // 'delete-all' is how an external-content FTS5 index is emptied; deleting the content
    // rows alone would leave the index pointing at rowids that no longer exist.
    this.handle.exec("INSERT INTO passages_fts(passages_fts) VALUES('delete-all')");
    this.handle.exec('DELETE FROM passages');
    this.handle.exec('DELETE FROM items');
    this.c = { documents: 0, vectors: 0, items: 0, fulltextItems: 0, fulltextPassages: 0 };
    this.fulltextKeys = new Set();
  }

  protected putItem(itemKey: string, title: string): void {
    this.begin();
    const res = this.stmts.insertItem.run(itemKey, title);
    if (Number(res.changes) > 0) this.c.items++;
  }

  protected putPassage(rec: ChunkRecord): void {
    this.begin();
    const res = this.stmts.insertPassage.run(rec.id, rec.itemKey, rec.title, rec.text, rec.source ?? null);
    this.stmts.insertFts.run(Number(res.lastInsertRowid), rec.text);
    this.c.documents++;
    if (rec.source === 'fulltext') {
      this.c.fulltextPassages++;
      if (!this.fulltextKeys.has(rec.itemKey)) {
        this.fulltextKeys.add(rec.itemKey);
        this.c.fulltextItems++;
      }
    }
  }

  /**
   * Remove one item: its FTS5 rows first (through the external-content delete protocol,
   * while the text they were indexed from is still readable), then the passages that hold
   * that text, then the item row itself. Counts are adjusted from the rows that were
   * actually removed rather than re-counted, so a delete costs the item, not the index.
   */
  protected deleteItem(itemKey: string): void {
    this.begin();
    const rows = this.stmts.itemPassages.all(itemKey) as Array<{
      pid: number;
      text: string;
      source: string | null;
      has_vector: number;
    }>;
    for (const row of rows) {
      this.stmts.deleteFts.run(row.pid, row.text);
      this.c.documents--;
      if (row.has_vector) this.c.vectors--;
      if (row.source === 'fulltext') this.c.fulltextPassages--;
    }
    this.stmts.deletePassages.run(itemKey);
    if (this.fulltextKeys.delete(itemKey)) this.c.fulltextItems--;
    if (Number(this.stmts.deleteItemRow.run(itemKey).changes) > 0) this.c.items--;
  }

  protected listItemKeys(): string[] {
    return (this.stmts.itemKeys.all() as Array<{ k: string }>).map((r) => r.k);
  }

  /**
   * Discard the open transaction, i.e. everything an update wrote, and re-read the
   * database's own view of itself. The in-memory counters and meta fields are derived
   * state: after a rollback they describe rows that no longer exist unless reloaded.
   */
  protected rollback(): boolean {
    if (!this.db) return false;
    if (this.inTransaction) {
      this.handle.exec('ROLLBACK');
      this.inTransaction = false;
    }
    this.refreshCounts();
    this.loadMeta();
    return true;
  }

  protected putVector(id: string, vector: number[]): void {
    this.begin();
    const blob = Buffer.from(Float32Array.from(vector).buffer);
    // Each passage is embedded once per build, so a changed row is a new vector.
    if (Number(this.stmts.setVector.run(blob, id).changes) > 0) this.c.vectors++;
  }

  protected clearVectors(): void {
    this.begin();
    this.handle.exec('UPDATE passages SET vector = NULL');
    this.c.vectors = 0;
  }

  /**
   * Committed straight away, unlike a build's writes: dropping vectors happens on open or
   * mid-query, and an open write transaction would then hold the database's writer lock
   * for the rest of the process.
   */
  protected dropStaleVectors(cause: string): void {
    super.dropStaleVectors(cause);
    this.flush();
  }

  protected vectorDimension(): number | undefined {
    const row = this.stmts.vectorWidth.get() as { bytes?: number } | undefined;
    return row?.bytes === undefined ? undefined : row.bytes / Float32Array.BYTES_PER_ELEMENT;
  }

  /**
   * FTS5 ranks with bm25() (negative, best first), which is negated here so both backends
   * report "higher is better". Terms are OR-ed: FTS5's implicit AND between terms answers
   * far fewer queries than the BM25 index does, where a document matching one term of
   * three still scores. Fusion downstream cares about the ORDER of these hits, not the
   * scale of their scores.
   */
  protected keywordSearch(q: string, topK: number): RankedId[] {
    const terms = [...new Set(tokenize(q))];
    if (!terms.length) return [];
    const match = terms.map(ftsTerm).join(' OR ');
    try {
      const rows = this.stmts.keyword.all(match, topK) as Array<{ id: string; rank: number }>;
      return rows.map((r) => ({ id: r.id, score: -r.rank }));
    } catch (e) {
      // A file that has gone bad under us is not a rejected query, and must not be
      // swallowed into an empty result set: an index that answers "no matches" forever
      // reads as an empty library rather than as a fault.
      if (isCorruptionError(e)) throw this.noteCorruption(e);
      // Everything that is not SQLite rejecting the match string we just built propagates.
      // This catch was written for that one condition and implemented as swallow-anything,
      // so `disk I/O error`, `no such table: passages`, a locked database and an
      // interrupted statement all came back as an empty library (#21).
      if (!isQuerySyntaxError(e)) throw e;
      // A term the FTS5 parser rejects must not take the whole search down with it.
      this.opts.logger?.debug(`FTS5 query rejected (${match}): ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * Cosine over the stored vectors, streamed one row at a time and kept to the top K, so
   * a semantic query costs the size of its result set rather than the size of the index.
   */
  protected vectorSearch(query: number[], topK: number): RankedId[] {
    this.vectorScans++;
    const qn = norm(query);
    if (qn === 0) return [];
    const top: RankedId[] = [];
    for (const row of this.stmts.vectors.iterate() as Iterable<{ id: string; vector: Uint8Array }>) {
      const score = cosine(query, toFloats(row.vector), qn);
      if (score <= 0) continue;
      if (top.length >= topK && score <= top[top.length - 1]!.score) continue;
      let i = top.length;
      while (i > 0 && top[i - 1]!.score < score) i--;
      top.splice(i, 0, { id: row.id, score });
      if (top.length > topK) top.pop();
    }
    return top;
  }

  protected passage(id: string): ChunkRecord | undefined {
    try {
      const row = this.stmts.selectPassage.get(id) as PassageRow | undefined;
      if (!row) return undefined;
      const rec: ChunkRecord = { id: row.id, itemKey: row.item_key, title: row.title, text: row.text };
      if (row.source === 'fulltext') rec.source = 'fulltext';
      return rec;
    } catch (e) {
      // Corruption in the passages b-tree is discovered here — every fused hit hydrates
      // through this read — and must reach the caller as the typed refusal, not as
      // SQLite's bare sentence naming neither the file nor the way out.
      if (isCorruptionError(e)) throw this.noteCorruption(e);
      throw e;
    }
  }

  /** Write the index-level state and commit whatever the build has inserted so far. */
  private flush(): void {
    if (!this.db) return;
    this.begin();
    this.writeMeta();
    this.commit();
  }

  /** Commit the build's open transaction: this is what makes the last passages durable. */
  async save(): Promise<void> {
    this.refuseIfFaulted();
    this.flush();
  }

  async close(): Promise<void> {
    if (!this.db) return;
    // Whatever was indexed is worth keeping; an abandoned transaction would discard it.
    try {
      this.flush();
    } catch {
      this.inTransaction = false;
    }
    this.db.close();
    this.db = undefined;
  }
}

/**
 * One query term, quoted as an FTS5 string so nothing in it is read as syntax. Tokens come
 * from tokenize.ts, whose class is \p{L}\p{N} — no quote can reach here today, and the
 * quoting is what keeps that true of a future tokenizer: an embedded double quote is
 * escaped by doubling it.
 */
function ftsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Float32 view over a BLOB, copying only when the buffer is not 4-byte aligned. */
function toFloats(buf: Uint8Array): Float32Array {
  if (buf.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }
  return new Float32Array(buf.slice().buffer);
}

/**
 * Only ever called with the query. Keeping the parameter `number[]` rather than
 * `ArrayLike<number>` is load-bearing: while this also took each row's `Float32Array`, the
 * call site saw two shapes and stayed polymorphic for the life of the process, which cost
 * about half the scan on its own.
 */
function norm(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

/**
 * Cosine of the query against one stored vector: one traversal, two accumulators.
 *
 * The obvious spelling — `norm(b)`, then a dot-product loop — walks each row twice and
 * shares its `norm()` with the query-side call above. Both cost real time on a scan that
 * touches every vector: measured on a 255 703-row index at 3072 dimensions, 44.8 to 15.5
 * microseconds per row, a 2.9x scan, of which about half was the polymorphic call site and
 * about half the second traversal.
 *
 * The scores are bit-identical, not merely close: the same products are summed in the same
 * order. The tail loop is what keeps that true when the widths disagree, where the old
 * `norm(b)` covered all of `b` while the dot product stopped at the shorter operand. That
 * case is unreachable through `query()`, which drops stale vectors on a width change, but
 * an index holding two generations of vectors reaches it and must rank as it did before.
 */
export function cosine(a: number[], b: Float32Array, an: number): number {
  if (a.length < b.length) return cosineUneven(a, b, an);
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!;
    dot += a[i]! * x;
    sq += x * x;
  }
  const bn = Math.sqrt(sq);
  if (bn === 0) return 0;
  return dot / (an * bn);
}

/**
 * The width-mismatch case, kept out of line so the scan's hot function stays small enough
 * to inline — folding it in costs about a fifth of the gain, measured. Nothing reaches this
 * through `query()`, which drops stale vectors when the query's width stops matching the
 * index's, but an index holding two generations of vectors does, and it must rank as it did
 * before: the old code summed the norm over all of `b` while stopping the product at the
 * shorter operand.
 */
function cosineUneven(a: number[], b: Float32Array, an: number): number {
  let dot = 0;
  let sq = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  for (let i = 0; i < b.length; i++) sq += b[i]! * b[i]!;
  const bn = Math.sqrt(sq);
  if (bn === 0) return 0;
  return dot / (an * bn);
}
