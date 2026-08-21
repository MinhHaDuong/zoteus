import { createReadStream, existsSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '../../lib/logger.js';
import { Fts5PassageStore, loadSqlite } from './fts5-store.js';
import type { ChunkRecord, PassageStore } from './passage-store.js';

/**
 * One-way migration of `search-index.json` into the SQLite/FTS5 database.
 *
 * The whole design follows from one fact: **the indexes that need migrating are exactly
 * the ones `JSON.parse` cannot read.** V8 caps a string at 536 870 888 characters, and the
 * index this work exists for is 463 MB — a slightly larger library exceeds the cap
 * outright. So there is deliberately no `JSON.parse(readFileSync(...))` fast path here,
 * not even behind a try/catch: a fast path that works on every fixture and fails on the
 * only file anyone will ever point at it is worse than no path at all, because it ships
 * untested against its own reason for existing.
 *
 * Instead the file is read as a stream and cut into one top-level `chunks` element at a
 * time; only that element is ever handed to `JSON.parse`. Nothing here takes a dependency
 * either — Node ships no streaming JSON parser, and ticket 0004 already declined a
 * loadable SQLite extension on the same grounds.
 */

/** Bytes of a single `chunks` element we are willing to buffer before calling it runaway. */
const DEFAULT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;

/** Passages per transaction. Per-record autocommit is the cliff `beginBatch` exists for. */
const DEFAULT_BATCH_SIZE = 5000;

/**
 * A failure that names its byte offset in the source file.
 *
 * The offset matters more than it looks: on a 463 MB file "invalid JSON" is unactionable,
 * while "unterminated string at byte 402 653 184" points straight at the truncation an
 * interrupted `saveIndex` left behind.
 */
export class JsonIndexScanError extends Error {
  readonly byteOffset: number;

  constructor(cause: string, byteOffset: number) {
    super(`${cause} at byte offset ${byteOffset} of the JSON search index`);
    this.name = 'JsonIndexScanError';
    this.byteOffset = byteOffset;
  }
}

export interface JsonIndexScanResult {
  /** Chunk records handed to the visitor. */
  chunks: number;
  /** Elements of the `vectors` array, counted and then dropped — see migrateJsonIndex. */
  vectorsSkipped: number;
  builtFromVersion: number;
  /** Size of the file, in bytes, as actually read. */
  bytes: number;
}

export interface JsonIndexScanOptions {
  /**
   * Cap on the buffered window. Exposed so a test can prove the window is bounded by
   * migrating a file orders of magnitude larger than the cap and watching it succeed.
   */
  maxObjectBytes?: number;
}

// Structural characters, compared as code units so the hot loop never allocates.
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const LBRACE = 0x7b;
const RBRACE = 0x7d;

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

/**
 * The incremental scanner.
 *
 * Correctness rests on two pieces of state, and both are load-bearing:
 *
 *  - **container depth**, so an object nested inside a chunk does not end it;
 *  - **in-string and escape state**, so that a `{`, `}` or `"` appearing inside a
 *    passage's `text` is read as data rather than as structure.
 *
 * Dropping the second is the trap this class is written against, and it is invisible on a
 * friendly fixture: a scanner that tracks only depth passes every test whose passages
 * happen to contain no braces, and cuts in the wrong place the moment it meets real
 * academic full text — LaTeX (`\section{Intro}`), source listings, JSON quoted inside a
 * paper. `\"` is not a string terminator, and a lone `}` inside a sentence is not the end
 * of a record.
 */
class JsonIndexScanner {
  /** Open containers, innermost last; holds LBRACE / LBRACKET. Bounded by nesting depth. */
  private readonly stack: number[] = [];
  private inString = false;
  private escaped = false;
  /**
   * Materialised only for strings at the root level, which are the document's keys. A
   * chunk's `text` is never accumulated here — that is what keeps the window bounded.
   */
  private keyBuf: string | null = null;
  private lastRootString = '';
  private rootKey = '';
  /** Verbatim capture of the one `chunks` element under construction. */
  private objBuf = '';
  private capturing = false;
  /** Capture of a root-level scalar value (only `builtFromVersion` is wanted). */
  private scalarBuf: string | null = null;
  private inChunks = false;
  private sawChunks = false;
  private inVectors = false;
  private vectorCommas = 0;
  private vectorNonEmpty = false;
  private rootClosed = false;
  /** Bytes fully decoded before the text currently being fed. */
  private bytesBefore = 0;
  private readonly maxObjectBytes: number;

  chunks = 0;
  vectorsSkipped = 0;
  builtFromVersion = 0;

  constructor(
    private readonly onChunk: (rec: ChunkRecord) => void,
    opts: JsonIndexScanOptions = {},
  ) {
    this.maxObjectBytes = opts.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  feed(text: string): void {
    const n = text.length;
    // Where the current verbatim capture starts *within this text*. Captured by slicing at
    // the end rather than by appending per character: `objBuf += text[i]` over 463 MB is
    // the difference between a migration measured in seconds and one measured in minutes.
    let capFrom = this.capturing ? 0 : -1;

    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);

      if (this.inString) {
        // Inside a string literal nothing is structure. The escape flag is what makes
        // `\"` a quote character rather than the end of the string.
        if (this.escaped) {
          this.escaped = false;
        } else if (c === BACKSLASH) {
          this.escaped = true;
        } else if (c === QUOTE) {
          this.inString = false;
          if (this.keyBuf !== null) {
            this.lastRootString = this.keyBuf;
            this.keyBuf = null;
          }
          continue;
        }
        if (this.keyBuf !== null) this.keyBuf += text[i];
        continue;
      }

      // A root-level scalar under capture: everything up to its terminator belongs to it.
      if (this.scalarBuf !== null && c !== COMMA && c !== RBRACE) this.scalarBuf += text[i];
      // Anything but whitespace and the closer means the vectors array has elements.
      if (this.inVectors && this.stack.length === 2 && c !== RBRACKET && !isWhitespace(c)) {
        this.vectorNonEmpty = true;
      }

      switch (c) {
        case QUOTE:
          this.inString = true;
          if (this.stack.length === 1) this.keyBuf = '';
          break;

        case LBRACE:
        case LBRACKET: {
          const isObject = c === LBRACE;
          if (this.stack.length === 0) {
            if (!isObject) {
              throw new JsonIndexScanError('the search index must be a JSON object', this.at(text, i));
            }
          } else if (this.stack.length === 1) {
            // A container is the value of a root key, so it is not the scalar we wanted.
            this.scalarBuf = null;
            if (!isObject && this.rootKey === 'chunks') {
              this.inChunks = true;
              this.sawChunks = true;
            } else if (!isObject && this.rootKey === 'vectors') {
              this.inVectors = true;
            }
          } else if (this.inChunks && this.stack.length === 2) {
            if (!isObject) {
              throw new JsonIndexScanError('"chunks" must hold objects', this.at(text, i));
            }
            this.capturing = true;
            capFrom = i;
          }
          this.stack.push(c);
          break;
        }

        case RBRACE:
        case RBRACKET: {
          const opener = this.stack.pop();
          if (opener === undefined) {
            throw new JsonIndexScanError('unbalanced closing bracket', this.at(text, i));
          }
          if ((c === RBRACE) !== (opener === LBRACE)) {
            throw new JsonIndexScanError('mismatched brackets', this.at(text, i));
          }
          if (this.capturing && this.stack.length === 2) {
            this.objBuf += text.slice(capFrom, i + 1);
            capFrom = -1;
            this.capturing = false;
            this.emit(this.at(text, i));
          } else if (this.stack.length === 1) {
            // A root-level container closed: the chunks or vectors array, or some other
            // key's value we walked over without caring.
            this.inChunks = false;
            if (this.inVectors) {
              this.inVectors = false;
              this.vectorsSkipped = this.vectorNonEmpty ? this.vectorCommas + 1 : 0;
            }
          } else if (this.stack.length === 0) {
            this.finishScalar(this.at(text, i));
            this.rootClosed = true;
          }
          break;
        }

        case COLON:
          if (this.stack.length === 1) {
            this.rootKey = this.lastRootString;
            if (this.rootKey === 'builtFromVersion') this.scalarBuf = '';
          }
          break;

        case COMMA:
          if (this.stack.length === 1) {
            this.finishScalar(this.at(text, i));
            this.rootKey = '';
          } else if (this.inVectors && this.stack.length === 2) {
            this.vectorCommas++;
          }
          break;

        default:
          break;
      }
    }

    const consumed = Buffer.byteLength(text);
    if (capFrom >= 0) {
      this.objBuf += text.slice(capFrom);
      this.guardWindow(this.bytesBefore + consumed);
    }
    this.bytesBefore += consumed;
  }

  end(): JsonIndexScanResult {
    if (this.inString) throw new JsonIndexScanError('unterminated string', this.bytesBefore);
    if (this.stack.length > 0 || !this.rootClosed) {
      throw new JsonIndexScanError('unexpected end of file inside a JSON value', this.bytesBefore);
    }
    if (!this.sawChunks) {
      throw new JsonIndexScanError('no "chunks" array — this is not a zoteus search index', this.bytesBefore);
    }
    return {
      chunks: this.chunks,
      vectorsSkipped: this.vectorsSkipped,
      builtFromVersion: this.builtFromVersion,
      bytes: this.bytesBefore,
    };
  }

  /** Byte offset of character `i` of `text`. Computed only on the error path. */
  private at(text: string, i: number): number {
    return this.bytesBefore + Buffer.byteLength(text.slice(0, i));
  }

  private guardWindow(offset: number): void {
    if (this.objBuf.length <= this.maxObjectBytes) return;
    // Reached when a string inside a chunk is never terminated: without the cap the
    // scanner would swallow the rest of the file into one buffer, which is precisely the
    // out-of-memory condition the SQLite backend exists to avoid.
    throw new JsonIndexScanError(
      `a single "chunks" element exceeded ${this.maxObjectBytes} bytes (malformed or truncated JSON)`,
      offset,
    );
  }

  private emit(offset: number): void {
    this.guardWindow(offset);
    const raw = this.objBuf;
    this.objBuf = '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new JsonIndexScanError(
        `could not parse a "chunks" element: ${e instanceof Error ? e.message : String(e)}`,
        offset,
      );
    }
    const rec = parsed as Partial<ChunkRecord> | null;
    if (!rec || typeof rec.id !== 'string' || typeof rec.itemKey !== 'string' || typeof rec.text !== 'string') {
      throw new JsonIndexScanError('a "chunks" element is missing id, itemKey or text', offset);
    }
    // Rebuilt field by field rather than passed through, so an unexpected key in an older
    // snapshot cannot reach the store. `source` stays absent for metadata passages —
    // ChunkRecord treats absent and 'fulltext' as the two cases, and `null` is neither.
    const out: ChunkRecord = {
      id: rec.id,
      itemKey: rec.itemKey,
      title: typeof rec.title === 'string' ? rec.title : '',
      text: rec.text,
    };
    if (rec.source === 'fulltext') out.source = 'fulltext';
    this.chunks++;
    this.onChunk(out);
  }

  private finishScalar(offset: number): void {
    const raw = this.scalarBuf;
    this.scalarBuf = null;
    if (raw === null || this.rootKey !== 'builtFromVersion') return;
    let value: unknown;
    try {
      value = JSON.parse(raw.trim());
    } catch {
      throw new JsonIndexScanError('builtFromVersion is not valid JSON', offset);
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new JsonIndexScanError('builtFromVersion is not a number', offset);
    }
    this.builtFromVersion = value;
  }
}

/**
 * Stream `jsonPath`, calling `onChunk` once per element of its `chunks` array.
 *
 * The `StringDecoder` is not decoration: a UTF-8 character can be split across two stream
 * chunks, and `buffer.toString('utf8')` per chunk turns that character into a pair of
 * replacement characters — silently, in the middle of somebody's abstract. The decoder
 * holds the incomplete tail back until its continuation bytes arrive.
 */
export async function scanJsonIndex(
  jsonPath: string,
  onChunk: (rec: ChunkRecord) => void,
  opts: JsonIndexScanOptions = {},
): Promise<JsonIndexScanResult> {
  const scanner = new JsonIndexScanner(onChunk, opts);
  const decoder = new StringDecoder('utf8');
  const stream = createReadStream(jsonPath);
  try {
    for await (const buf of stream as AsyncIterable<Buffer>) {
      const text = decoder.write(buf);
      if (text) scanner.feed(text);
    }
  } finally {
    stream.destroy();
  }
  const tail = decoder.end();
  if (tail) scanner.feed(tail);
  return scanner.end();
}

export interface MigrationReport extends JsonIndexScanResult {
  /** Wall-clock duration, milliseconds. */
  ms: number;
}

export interface MigrateOptions extends JsonIndexScanOptions {
  jsonPath: string;
  batchSize?: number;
}

/**
 * Migrate through the `PassageStore` port, so the same code path is exercised against the
 * in-memory store in tests and against FTS5 in production.
 *
 * `vectors` are deliberately **not** carried: the vector column is ticket 0004's and has
 * not landed. They are counted and reported, never silently dropped — a user whose
 * semantic search stops working deserves a line in the log saying why, not a mystery.
 */
export async function migrateJsonIndex(opts: MigrateOptions & { store: PassageStore }): Promise<MigrationReport> {
  const started = Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  opts.store.clear();
  let sinceCommit = 0;
  opts.store.beginBatch();
  const result = await scanJsonIndex(
    opts.jsonPath,
    (rec) => {
      opts.store.add(rec);
      if (++sinceCommit >= batchSize) {
        opts.store.commitBatch();
        opts.store.beginBatch();
        sinceCommit = 0;
      }
    },
    { maxObjectBytes: opts.maxObjectBytes },
  );
  opts.store.commitBatch();
  return { ...result, ms: Date.now() - started };
}

/** Remove a database file and the sidecars WAL mode leaves beside it. */
async function removeDatabase(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((p) => unlink(p).catch(() => {})));
}

/**
 * Migrate into `dbPath`, atomically.
 *
 * Two hazards are handled here, and neither is visible to a green test that reads the
 * store it just wrote through the connection that wrote it:
 *
 *  1. **Atomicity.** The database is built under a temporary name and renamed into place
 *     only on success, so an interrupted migration leaves nothing that looks complete.
 *     A half-populated `search-index.sqlite` is worse than none: it answers queries, with
 *     part of the library missing and nothing saying so.
 *  2. **The WAL.** `Fts5PassageStore` opens in WAL mode, so committed rows can still be
 *     sitting in `<db>-wal` when the writing connection goes away. Renaming the main file
 *     alone would land a database whose data is in a sidecar left behind under the old
 *     name. Closing the last connection normally checkpoints and removes the WAL, but
 *     "normally" is not a guarantee worth a library, so the fold-in is made explicit:
 *     `PRAGMA journal_mode = DELETE` on a fresh connection checkpoints the WAL into the
 *     main file and drops it, leaving one self-contained file to rename.
 */
export async function migrateJsonIndexToSqlite(opts: MigrateOptions & { dbPath: string }): Promise<MigrationReport> {
  const tmp = `${opts.dbPath}.migrating-${process.pid}-${Date.now()}`;
  await removeDatabase(tmp);
  const store = new Fts5PassageStore(tmp);
  let report: MigrationReport;
  try {
    report = await migrateJsonIndex({ ...opts, store });
    // Carried across unlabelled, deliberately. In a JSON snapshot this field holds what
    // pre-0006 builds put there — the item COUNT, not a library version — and no snapshot
    // records which client produced it. An unlabelled watermark is refused by the freshness
    // check (see delta.ts), so a migrated index rebuilds once instead of computing a delta
    // against a number from an entirely different quantity.
    store.setMeta('builtFromVersion', String(report.builtFromVersion));
    store.close();
  } catch (e) {
    try {
      store.close();
    } catch {
      // The store is being discarded; a failure to close it must not mask the real cause.
    }
    await removeDatabase(tmp);
    throw e;
  }

  const { DatabaseSync } = loadSqlite();
  const folded = new DatabaseSync(tmp);
  folded.exec('PRAGMA journal_mode = DELETE');
  folded.close();
  // Belt and braces: whatever the pragma did, no sidecar may travel with the rename, and
  // none may survive at the destination either — a stale `<db>-wal` beside a freshly
  // renamed database is read as that database's journal.
  await Promise.all(
    [`${tmp}-wal`, `${tmp}-shm`, `${opts.dbPath}-wal`, `${opts.dbPath}-shm`].map((p) => unlink(p).catch(() => {})),
  );
  await rename(tmp, opts.dbPath);
  return report;
}

/** True when `dbPath` holds no passages — a fresh file, or one an aborted run left behind. */
function isEmptyDatabase(dbPath: string): boolean {
  const store = new Fts5PassageStore(dbPath);
  try {
    return store.size === 0;
  } finally {
    store.close();
  }
}

/**
 * The startup trigger: migrate when the JSON index is there and the database is not.
 *
 * The JSON file is left untouched, which is what makes the move reversible — a user who
 * dislikes the SQLite backend sets `ZOTEUS_SEARCH_BACKEND=json` and gets their index back
 * exactly as it was.
 *
 * Failure propagates. It must: falling back to an empty index presents as an empty library
 * and sends the user into a rebuild, which on the library that motivated this work is the
 * hours-long operation they were escaping.
 */
export async function maybeMigrateJsonIndex(opts: {
  jsonPath: string;
  dbPath: string;
  logger?: Logger;
  batchSize?: number;
}): Promise<MigrationReport | null> {
  if (!existsSync(opts.jsonPath)) return null;
  if (existsSync(opts.dbPath) && !isEmptyDatabase(opts.dbPath)) return null;

  opts.logger?.info(`Migrating ${opts.jsonPath} into ${opts.dbPath} (SQLite/FTS5 backend); this runs once.`);
  try {
    const report = await migrateJsonIndexToSqlite(opts);
    opts.logger?.info(
      `Migrated ${report.chunks} passages from ${Math.round(report.bytes / 1e6)} MB of JSON in ` +
        `${(report.ms / 1000).toFixed(1)} s (builtFromVersion=${report.builtFromVersion}). ` +
        (report.vectorsSkipped > 0
          ? `${report.vectorsSkipped} embedding vectors were NOT carried over — semantic search will be ` +
            'keyword-only until the next index build.'
          : 'No embedding vectors were present.'),
    );
    return report;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Could not migrate ${opts.jsonPath} into the SQLite search index: ${why}. ` +
        'The JSON file has not been modified. Set ZOTEUS_SEARCH_BACKEND=json to keep using it, ' +
        'or move it aside to start from an empty SQLite index.',
      { cause: e },
    );
  }
}
