import { createRequire } from 'node:module';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { toMatchQuery } from './match-query.js';
import type { ChunkRecord, PassageStore } from './passage-store.js';
import type { VectorEntry } from './vector-store.js';

/**
 * Schema for the keyword side of the index.
 *
 * `passage_meta` is a plain table rather than a set of `UNINDEXED` FTS5 columns, and the
 * difference is not cosmetic: an UNINDEXED column is, as the name says, not indexed, so
 * looking a passage up by its item means a full scan of the virtual table. Measured on a
 * 408 628-passage corpus, that is 362 ms per lookup by item against 0 ms for an indexed
 * MATCH. The delta-rebuild path deletes by item on every run, so the side table with a
 * real index on `item` is what makes that path affordable.
 *
 * `passage_meta.rowid` is the FTS5 rowid, which is how the two halves are joined. The
 * vector table below keeps the same rowid, so all three join on one key.
 */
const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
  body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS passage_meta(
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  item TEXT NOT NULL,
  ord INTEGER NOT NULL,
  title TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS passage_meta_item ON passage_meta(item);
CREATE UNIQUE INDEX IF NOT EXISTS passage_meta_id ON passage_meta(id);
CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** The vec0 virtual table holding one embedding per passage, keyed by the FTS5 rowid. */
const VEC_TABLE = 'passage_vectors';
/** `index_meta` key under which the embedding dimension is recorded. See ensureVecTable. */
export const VEC_DIM_KEY = 'vectorDim';
/** npm package that ships the vec0 loadable extension (optional, not bundled; see below). */
export const SQLITE_VEC_MODULE = 'sqlite-vec';

/**
 * `node:sqlite` landed in Node 22.5, and package.json declares `engines: >=20.19`. The
 * floor stays where it is, so the module is loaded lazily — a user who never asks for the
 * SQLite backend never touches it. `createRequire` rather than `await import()` because
 * PassageStore.add/search are synchronous and cannot await anything.
 *
 * A failure here is reported, never worked around: falling back to the in-memory index
 * would hand a user who asked for FTS5 precisely the out-of-memory condition they were
 * escaping, with nothing in the output saying so.
 */
export function loadSqlite(): typeof import('node:sqlite') {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch (e) {
    throw new Error(
      `ZOTEUS_SEARCH_BACKEND=sqlite requires Node >= 22.5 (node:sqlite unavailable): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** How the vec0 extension gets into a connection. Injectable so a test can deny it. */
export type VecLoader = (db: DatabaseSync) => void;

/**
 * Resolve sqlite-vec and load it into the connection, the way embeddings.ts resolves the
 * transformers runtime: lazily, from an `optionalDependencies` entry that may simply not
 * be there. Absence throws here and is caught by the caller, which turns it into a
 * reported degradation rather than a dead backend.
 */
export function defaultVecLoader(db: DatabaseSync): void {
  const vec = createRequire(import.meta.url)(SQLITE_VEC_MODULE) as { load(db: DatabaseSync): void };
  vec.load(db);
}

/**
 * Actionable explanation for "the SQLite backend cannot store vectors". The FIRST sentence
 * is the short cause (shortCause in index-manager truncates on it); everything after it is
 * the remedy. Same contract as missingTransformersHint.
 */
export function missingSqliteVecHint(cause: string): string {
  return (
    `${SQLITE_VEC_MODULE} could not be loaded (${cause}). Embeddings are not stored, so this ` +
    'index is keyword-only (BM25) and mode:"semantic" has nothing to rank. Install it with ' +
    `\`npm i ${SQLITE_VEC_MODULE}\` — it is a small prebuilt SQLite extension with no compile ` +
    'step — then rebuild the index. Or set ZOTEUS_SEARCH_BACKEND=json to go back to the ' +
    'resident vector index, or ZOTEUS_EMBEDDINGS=off to accept keyword-only search.'
  );
}

/** Row shapes returned by the prepared statements below. */
interface MetaRow {
  id: string;
  item: string;
  title: string | null;
  text: string;
  source: string | null;
}
interface HitRow {
  id: string;
  score: number;
}

/**
 * The chunk ordinal, recovered from the id (`KEY#3`, `KEY#f3`). Nothing reads it yet; it
 * is in the schema so a delta rebuild can address a single passage of an item without
 * parsing ids in SQL. Ids that do not follow the convention are stored at 0 rather than
 * rejected — the store's contract is over `ChunkRecord.id` as an opaque key.
 */
function ordinalOf(id: string): number {
  const m = /#f?(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * A vector as vec0 wants it: a little-endian float32 blob.
 *
 * float32, not float64, because that is what `float[N]` declares and what the extension
 * reads; handing it a Float64Array of the same length is not a precision upgrade, it is a
 * dimension error (the blob is twice as long, so vec0 reports twice as many dimensions).
 */
function float32Blob(v: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(v).buffer);
}

/** The inverse of {@link float32Blob}: read a vec0 blob back as float32 values. */
function floats(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/**
 * Passages held in SQLite: FTS5 for the keyword side, vec0 for the vector side, both on
 * disk and out of the JS heap.
 */
export class Fts5PassageStore implements PassageStore {
  private readonly db: DatabaseSync;
  private readonly stmtInsertBody: StatementSync;
  private readonly stmtInsertMeta: StatementSync;
  private readonly stmtRowidOf: StatementSync;
  private readonly stmtDeleteBodyRow: StatementSync;
  private readonly stmtDeleteMetaRow: StatementSync;
  private readonly stmtDeleteBodyByItem: StatementSync;
  private readonly stmtDeleteMetaByItem: StatementSync;
  private readonly stmtSearch: StatementSync;
  private readonly stmtGet: StatementSync;
  private readonly stmtAll: StatementSync;
  private readonly stmtCount: StatementSync;
  private readonly stmtItems: StatementSync;
  private readonly stmtFulltextStats: StatementSync;
  private readonly stmtGetMeta: StatementSync;
  private readonly stmtSetMeta: StatementSync;
  private readonly stmtDelMeta: StatementSync;
  /** Whether a `BEGIN` is outstanding. SQLite errors on a COMMIT with no transaction. */
  private inBatch = false;

  /** Undefined while the vec0 extension is loaded and no reason to think otherwise. */
  private readonly vecReason: string | undefined;
  /**
   * The embedding dimension this database was built at, or undefined while no vector has
   * ever been stored. Mirrored in `index_meta` so a reopened database knows it too.
   */
  private vecDim: number | undefined;
  /** Prepared only once the vec0 table exists; see prepareVecStatements. */
  private stmtVecInsert: StatementSync | undefined;
  private stmtVecDeleteRow: StatementSync | undefined;
  private stmtVecDeleteByItem: StatementSync | undefined;
  private stmtVecSearch: StatementSync | undefined;
  private stmtVecCount: StatementSync | undefined;
  private stmtVecAll: StatementSync | undefined;

  /** `path` may be `':memory:'`, which is what the tests use. */
  constructor(path: string, opts: { loadVec?: VecLoader } = {}) {
    const { DatabaseSync: Ctor } = loadSqlite();
    // `allowExtension` only *permits* enableLoadExtension to be called; loading is still
    // off until armVec asks for it, and off again the moment it is done.
    this.db = new Ctor(path, { allowExtension: true });
    // WAL lets a reader query while a build writes; NORMAL trades an fsync per commit for
    // throughput, which is the right side of the trade for an index that can be rebuilt.
    // Both are no-ops on ':memory:'.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.vecReason = this.armVec(opts.loadVec ?? defaultVecLoader);

    this.stmtInsertBody = this.db.prepare('INSERT INTO passages(body) VALUES(?)');
    this.stmtInsertMeta = this.db.prepare(
      'INSERT INTO passage_meta(rowid, id, item, ord, title, source) VALUES(?, ?, ?, ?, ?, ?)',
    );
    this.stmtRowidOf = this.db.prepare('SELECT rowid FROM passage_meta WHERE id = ?');
    this.stmtDeleteBodyRow = this.db.prepare('DELETE FROM passages WHERE rowid = ?');
    this.stmtDeleteMetaRow = this.db.prepare('DELETE FROM passage_meta WHERE rowid = ?');
    this.stmtDeleteBodyByItem = this.db.prepare(
      'DELETE FROM passages WHERE rowid IN (SELECT rowid FROM passage_meta WHERE item = ?)',
    );
    this.stmtDeleteMetaByItem = this.db.prepare('DELETE FROM passage_meta WHERE item = ?');
    // bm25() is negative and sorts best-first ASCENDING; see search() for the sign flip.
    this.stmtSearch = this.db.prepare(
      'SELECT m.id AS id, -bm25(passages) AS score' +
        ' FROM passages JOIN passage_meta m ON m.rowid = passages.rowid' +
        ' WHERE passages MATCH ? ORDER BY bm25(passages) LIMIT ?',
    );
    this.stmtGet = this.db.prepare(
      'SELECT m.id AS id, m.item AS item, m.title AS title, m.source AS source, passages.body AS text' +
        ' FROM passage_meta m JOIN passages ON passages.rowid = m.rowid WHERE m.id = ?',
    );
    this.stmtAll = this.db.prepare(
      'SELECT m.id AS id, m.item AS item, m.title AS title, m.source AS source, passages.body AS text' +
        ' FROM passage_meta m JOIN passages ON passages.rowid = m.rowid ORDER BY m.rowid',
    );
    this.stmtCount = this.db.prepare('SELECT count(*) AS n FROM passage_meta');
    // Both of these read `item`, which is why passage_meta carries a real index on it (see
    // SCHEMA): they run on every delta, against a table with one row per passage.
    this.stmtItems = this.db.prepare('SELECT DISTINCT item FROM passage_meta');
    this.stmtFulltextStats = this.db.prepare(
      "SELECT item, count(*) AS n FROM passage_meta WHERE source = 'fulltext' GROUP BY item",
    );
    this.stmtGetMeta = this.db.prepare('SELECT value FROM index_meta WHERE key = ?');
    this.stmtSetMeta = this.db.prepare(
      'INSERT INTO index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    this.stmtDelMeta = this.db.prepare('DELETE FROM index_meta WHERE key = ?');
    this.adoptRecordedDimension();
  }

  /**
   * Load vec0, with the extension-loading window held open for exactly one call.
   *
   * Leaving `enableLoadExtension(true)` armed for the lifetime of the process hands any
   * later holder of this connection the ability to load arbitrary native code — a
   * capability nothing here needs after startup. So: open, load, close, in a `finally` so
   * a throwing loader cannot leave it armed.
   *
   * The return value is the *reason it did not work*, not a thrown error: a missing
   * optional dependency degrades the backend to keyword-only, exactly as a missing
   * transformers runtime degrades the embedder, and both have to be able to say so.
   */
  private armVec(loadVec: VecLoader): string | undefined {
    try {
      this.db.enableLoadExtension(true);
      try {
        loadVec(this.db);
      } finally {
        this.db.enableLoadExtension(false);
      }
      return undefined;
    } catch (e) {
      return missingSqliteVecHint(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Recover the dimension a previous session built this database at.
   *
   * The vec0 table cannot declare `float[N]` without an N, and zoteus does not know N in
   * advance — embeddings.ts reads it off the model's output tensor at runtime, and it
   * changes with the model. So the table is created on the first setVector and the
   * dimension is written to `index_meta`; this is the read-back half, and it is what makes
   * a reopened database able to keep inserting into the table it already has.
   */
  private adoptRecordedDimension(): void {
    if (this.vecReason !== undefined) return;
    const raw = this.getMeta(VEC_DIM_KEY);
    const n = raw === undefined ? NaN : Number(raw);
    if (!Number.isInteger(n) || n <= 0) return;
    try {
      this.prepareVecStatements();
      this.vecDim = n;
    } catch {
      // The dimension was recorded but the table is not there (a database written by a
      // build that died between the CREATE and the COMMIT). Treat it as "no vectors yet"
      // so the next setVector recreates the table, rather than failing every query. The
      // statements go with it: prepare() may have succeeded for the first few before
      // failing, and a live statement against a missing table is a delayed crash.
      this.vecDim = undefined;
      this.forgetVecStatements();
    }
  }

  /** Prepare the vec0 statements. Throws if the table does not exist — see the caller. */
  private prepareVecStatements(): void {
    this.stmtVecInsert = this.db.prepare(`INSERT INTO ${VEC_TABLE}(rowid, embedding) VALUES(?, ?)`);
    this.stmtVecDeleteRow = this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE rowid = ?`);
    this.stmtVecDeleteByItem = this.db.prepare(
      `DELETE FROM ${VEC_TABLE} WHERE rowid IN (SELECT rowid FROM passage_meta WHERE item = ?)`,
    );
    // THE SIGN, second half. vec0 answers with `distance`, ascending-best (0 = identical);
    // under distance_metric=cosine that distance is 1 - cos, so `1.0 - distance` is the
    // cosine similarity the resident VectorStore returns, on the same scale. Ordering by
    // distance ASC is therefore ordering by score DESC, which is what the port promises
    // and what rrf() — which reads position, never magnitude — depends on. Negating
    // bm25() and subtracting the vec0 distance are the same act, done once each, here.
    this.stmtVecSearch = this.db.prepare(
      `SELECT m.id AS id, 1.0 - v.distance AS score` +
        ` FROM ${VEC_TABLE} v JOIN passage_meta m ON m.rowid = v.rowid` +
        ` WHERE v.embedding MATCH ? AND v.k = ? ORDER BY v.distance`,
    );
    this.stmtVecCount = this.db.prepare(`SELECT count(*) AS n FROM ${VEC_TABLE}`);
    this.stmtVecAll = this.db.prepare(
      `SELECT m.id AS id, v.embedding AS embedding` +
        ` FROM ${VEC_TABLE} v JOIN passage_meta m ON m.rowid = v.rowid ORDER BY v.rowid`,
    );
  }

  /**
   * Create the vec0 table at `dim` if this is the first vector, or check `dim` against the
   * one already in force.
   *
   * A mismatch **throws**, naming both dimensions. The alternative — silently rebuilding
   * the table — was rejected because it would discard every vector already stored without
   * saying so, mid-build, and the legitimate path to a new dimension does not come through
   * here anyway: changing ZOTEUS_EMBEDDINGS and rebuilding runs SearchIndex.reset() →
   * clear(), which drops the table and forgets the dimension, so the next setVector
   * creates it afresh at the new size. What is left reaching this branch is one embedder
   * emitting two different widths inside a single build, which is not a configuration
   * change but an incoherence — and mixed-dimension vectors in one table is exactly the
   * failure that produces plausible nonsense rankings.
   */
  private ensureVecTable(dim: number): void {
    if (this.vecDim === dim) return;
    if (this.vecDim !== undefined) {
      throw new Error(
        `Embedding dimension changed mid-index: this database stores ${this.vecDim}-dimension vectors ` +
          `and a ${dim}-dimension vector arrived. Vectors of different widths cannot share one table. ` +
          'Rebuild the index (zotero_index action:"build") so every passage is embedded by the same model.',
      );
    }
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`Refusing to create a vector table for a ${dim}-dimension embedding.`);
    }
    // `dim` is interpolated because vec0 needs the width in the DDL, where a bound
    // parameter is not allowed. The guard above is what makes that safe: it is an integer.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    );
    this.setMeta(VEC_DIM_KEY, String(dim));
    this.prepareVecStatements();
    this.vecDim = dim;
  }

  add(rec: ChunkRecord): void {
    // Last write wins on a repeated id, matching the Map the memory store wraps. Without
    // this, a second loadFromJSON into a file-backed store would trip the UNIQUE index.
    const existing = this.stmtRowidOf.get(rec.id) as { rowid: number } | undefined;
    if (existing) {
      this.stmtDeleteBodyRow.run(existing.rowid);
      this.stmtDeleteMetaRow.run(existing.rowid);
      // The replacement gets a fresh rowid, so any vector filed under the old one would
      // outlive its passage and answer a KNN query with an id nothing can resolve.
      if (this.vecDim !== undefined) this.stmtVecDeleteRow!.run(BigInt(existing.rowid));
    }
    const rowid = Number(this.stmtInsertBody.run(rec.text).lastInsertRowid);
    this.stmtInsertMeta.run(rowid, rec.id, rec.itemKey, ordinalOf(rec.id), rec.title, rec.source ?? null);
  }

  search(query: string, topK: number): Array<{ id: string; score: number }> {
    const match = toMatchQuery(query);
    // Nothing survived tokenisation (empty, whitespace, punctuation, all stopwords). Issue
    // no MATCH at all: FTS5 rejects an empty expression, and "no terms" means "no hits".
    if (match === null) return [];
    // The sign flip. FTS5's bm25() is a NEGATIVE quantity whose best result is the most
    // negative, so best-first is ORDER BY ... ASC. Every consumer here expects the opposite
    // convention: rrf() ranks by list position (so the order must already be best-first)
    // and callers elsewhere filter on `score > 0`. Negating gives both at once. A green
    // suite would not catch getting this backwards — the ORDER BY alone keeps the ranking
    // right — which is exactly why it is spelled out.
    return this.stmtSearch.all(match, topK) as unknown as HitRow[];
  }

  get(id: string): ChunkRecord | undefined {
    const row = this.stmtGet.get(id) as unknown as MetaRow | undefined;
    return row ? toChunk(row) : undefined;
  }

  values(): Iterable<ChunkRecord> {
    // Materialised rather than streamed: the one caller is toJSON(), which builds an array
    // of the whole store anyway.
    return (this.stmtAll.all() as unknown as MetaRow[]).map(toChunk);
  }

  /**
   * File one embedding against an already-added passage.
   *
   * A no-op when vec0 is unavailable: the reason is on `vectorReason` and reported by
   * status, so the build finishes and stays useful for keyword search instead of dying
   * 30 000 passages in over an optional dependency.
   */
  setVector(id: string, v: number[]): void {
    if (this.vecReason !== undefined) return;
    const row = this.stmtRowidOf.get(id) as { rowid: number } | undefined;
    if (!row) {
      throw new Error(`setVector: no passage with id "${id}" — add() the passage before embedding it.`);
    }
    this.ensureVecTable(v.length);
    const rowid = BigInt(row.rowid);
    // Idempotent: vec0 has no upsert, and a second insert at the same rowid would either
    // fail or duplicate depending on the version.
    this.stmtVecDeleteRow!.run(rowid);
    // node:sqlite binds every JS number as SQLite REAL, and vec0 requires an INTEGER
    // primary key — so the rowid goes in as a BigInt. This is the whole of the reason;
    // there is nothing large about these numbers.
    this.stmtVecInsert!.run(rowid, float32Blob(v));
  }

  vectorSearch(q: number[], topK: number): Array<{ id: string; score: number }> {
    if (this.vecReason !== undefined || this.vecDim === undefined || topK <= 0) return [];
    // A zero query vector has no direction, so no similarity is defined and vec0 answers
    // with a NULL distance. VectorStore returns [] for the same input; match it.
    if (!q.some((x) => x !== 0)) return [];
    if (q.length !== this.vecDim) {
      // Thrown rather than silently emptied: SearchIndex.query runs this inside the same
      // try that catches embedder failures, so the message reaches status().embedderReason
      // and the search still returns its keyword half. Silence here would look like a
      // library with nothing to say on the subject.
      throw new Error(
        `Query vector has ${q.length} dimensions but this index stores ${this.vecDim}-dimension vectors. ` +
          'The embedding model changed since the index was built; rebuild it with zotero_index action:"build".',
      );
    }
    const hits = this.stmtVecSearch!.all(float32Blob(q), BigInt(topK)) as unknown as HitRow[];
    // `> 0` for parity with VectorStore, which drops orthogonal and opposed passages rather
    // than ranking them last. Under cosine distance in [0, 2] that is everything past 90°.
    return hits.filter((h) => h.score > 0);
  }

  get vectorCount(): number {
    if (this.vecReason !== undefined || this.vecDim === undefined) return 0;
    return Number((this.stmtVecCount!.get() as unknown as { n: number }).n);
  }

  /** Why no vectors are being stored, when something is preventing it. */
  get vectorReason(): string | undefined {
    return this.vecReason;
  }

  /**
   * Every vector, for the JSON snapshot. Materialises the lot in the JS heap, which is the
   * condition this backend exists to avoid — so the caller that matters,
   * `SqliteSearchIndex.toJSON`, refuses before ever arriving here. What is left is the
   * parity suites, which round-trip a handful of passages through JSON on both stores.
   *
   * The values come back float32-rounded, because that is the width vec0 stores. A
   * snapshot taken from this store is therefore not bit-identical to one taken from the
   * resident store; it is the same vectors at the precision they were kept at.
   */
  vectorEntries(): VectorEntry[] {
    if (this.vecReason !== undefined || this.vecDim === undefined) return [];
    const rows = this.stmtVecAll!.all() as unknown as Array<{ id: string; embedding: Uint8Array }>;
    return rows.map((r) => ({ id: r.id, vector: Array.from(floats(r.embedding)) }));
  }

  /** Every item the index holds a passage for — the delta's "what do I currently have". */
  itemKeys(): string[] {
    return (this.stmtItems.all() as unknown as Array<{ item: string }>).map((r) => r.item);
  }

  fulltextStats(): { items: string[]; passages: number } {
    const rows = this.stmtFulltextStats.all() as unknown as Array<{ item: string; n: number }>;
    return { items: rows.map((r) => r.item), passages: rows.reduce((sum, r) => sum + Number(r.n), 0) };
  }

  deleteByItem(itemKey: string): void {
    // Vectors and FTS5 rows are both located through passage_meta, so both go before the
    // meta rows do. A vector outliving its passage is a KNN hit pointing at nothing.
    if (this.vecDim !== undefined) this.stmtVecDeleteByItem!.run(itemKey);
    this.stmtDeleteBodyByItem.run(itemKey);
    this.stmtDeleteMetaByItem.run(itemKey);
  }

  clear(): void {
    this.db.exec('DELETE FROM passages; DELETE FROM passage_meta;');
    if (this.vecDim === undefined) return;
    // The vector table goes entirely, not just its rows, and this is what makes changing
    // the embedding model a supported operation: the width is baked into the vec0 DDL, so
    // an emptied 384-wide table would still refuse the first 768-wide vector of the
    // rebuild. Dropping it here means the next setVector creates it at whatever the new
    // model produces. See ensureVecTable for the mismatch that survives this.
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    this.stmtDelMeta.run(VEC_DIM_KEY);
    this.vecDim = undefined;
    this.forgetVecStatements();
  }

  /** Forget the prepared vec0 statements: they name a table that no longer exists. */
  private forgetVecStatements(): void {
    this.stmtVecInsert = undefined;
    this.stmtVecDeleteRow = undefined;
    this.stmtVecDeleteByItem = undefined;
    this.stmtVecSearch = undefined;
    this.stmtVecCount = undefined;
    this.stmtVecAll = undefined;
  }

  /**
   * One transaction per batch of inserts, not one per insert.
   *
   * SQLite autocommits every statement it is not told to group, and each autocommit is a
   * durability barrier. On the standalone bench over 408 628 passages, committing every
   * 500 documents indexed the whole corpus in 46,6 s; per-passage autocommit is orders of
   * magnitude slower, and it is the only thing that makes the FTS5 backend look unusable.
   *
   * Re-entrant by design: buildIncremental opens a batch it may already hold open, and a
   * nested BEGIN is a SQLite error rather than a no-op.
   */
  beginBatch(): void {
    if (this.inBatch) return;
    this.db.exec('BEGIN');
    this.inBatch = true;
  }

  /**
   * Commit whatever the open batch holds. Harmless with nothing open — the flag is what
   * makes that true, since `COMMIT` outside a transaction throws.
   *
   * The flag is cleared in a `finally` so a failed COMMIT cannot wedge the store into a
   * state where every later beginBatch believes a transaction is already running.
   */
  commitBatch(): void {
    if (!this.inBatch) return;
    try {
      this.db.exec('COMMIT');
    } finally {
      this.inBatch = false;
    }
  }

  get size(): number {
    return Number((this.stmtCount.get() as unknown as { n: number }).n);
  }

  /**
   * Index-level scalars that belong to the database rather than to any passage —
   * `builtFromVersion`, which the JSON snapshot carried at its top level and which would
   * otherwise be lost when a migrated index is reopened, and the embedding dimension the
   * vec0 table was created at.
   *
   * Not part of the PassageStore port, for the same reason `close()` is not: a Map has no
   * answer for it, and no code on the resident path asks the question.
   */
  getMeta(key: string): string | undefined {
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }

  /**
   * Forget one scalar. Needed because absence and presence mean different things to the
   * delta: a watermark carrying no backend label is refused outright, so writing an empty
   * label would be read as a label rather than as "unknown".
   */
  deleteMeta(key: string): void {
    this.stmtDelMeta.run(key);
  }

  /** Release the database handle. Not part of the port; useful for a file-backed store. */
  close(): void {
    // Closing on an open batch would discard it. Same rule as every other exit path here:
    // what was written stays written.
    this.commitBatch();
    this.db.close();
  }
}

function toChunk(row: MetaRow): ChunkRecord {
  const rec: ChunkRecord = { id: row.id, itemKey: row.item, title: row.title ?? '', text: row.text };
  // Kept absent rather than null for metadata passages: `source` is an optional field on
  // ChunkRecord and toJSON's output has to stay loadable by an older build.
  if (row.source === 'fulltext') rec.source = 'fulltext';
  return rec;
}
