import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

/**
 * Required through createRequire rather than imported, for the reason `sqlite-index.ts`
 * gives: `sqlite` is absent from `module.builtinModules` while it is experimental, so a
 * bundler or test runner tries to resolve `node:sqlite` from disk and fails. Node itself
 * requires it as the builtin it is.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Bumped only when the DDL below changes shape.
 *
 * 2 adds §5.2.2's content half — `entries`, `slabs`, `passages`, `fts` — to the same file
 * and the same stamp as tranches 1-2's bookkeeping half. It is not a second schema and
 * there is no second counter: SPEC.md §5.2.2 is "one file, one schema", and a file whose
 * two halves could disagree about their version is a file no reader can reason about.
 *
 * The step is purely additive, so a version-1 file is brought forward by the `CREATE TABLE
 * IF NOT EXISTS` block itself and re-stamped. One thing does not come forward: a version-1
 * file was written before `auto_vacuum` was set, and that cannot be repaired in place —
 * see `autoVacuumIncremental`.
 */
export const LEDGER_SCHEMA_VERSION = 2;

/** Slab ceiling, §5.2.2. Enforced by a CHECK, so an oversized slab cannot be written. */
export const MAX_SLAB_BYTES = 1024 * 1024;

/** Every connection waits this long for a lock rather than failing (§5.2.2). */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * How the FTS5 index stores what it indexes.
 *
 * `contentless` is §5.2.2's choice: FTS5 keeps its own index and no copy of the text,
 * which is what makes a per-field index affordable beside the slab store that already
 * holds every byte. It needs `contentless_delete=1` (SQLite ≥ 3.43) — without that a
 * contentless row cannot be retired at all, and an index that cannot delete is an R12
 * violation waiting for its first update.
 *
 * `external` is v1's layout, kept as the probed fallback for a runtime below that: the
 * text lives in a shadow table and the index points at it by rowid. It costs a second copy
 * of every indexed field, which is exactly why it is the fallback and not the default.
 */
export type FtsStorage = 'contentless' | 'external';

/** The eight per-field FTS columns of §5.2.2, in the order the table declares them. */
export const FTS_FIELDS = ['title', 'abstract', 'creators', 'tags', 'pub', 'ctx', 'own', 'body'] as const;

export type FtsField = (typeof FTS_FIELDS)[number];

/** What one indexed unit contributes to each field. Absent is not the same as empty. */
export type FtsFields = Partial<Record<FtsField, string>>;

/** §5.2.2's five entry kinds. `synthetic` is seg/1's below-confidence fallback cut. */
export type EntryKind = 'record' | 'note' | 'annotation' | 'body' | 'synthetic';

/** Where a slab's text came from. Note the asymmetry with `EntryKind`: there is no
 * `body` source and no `synthetic` one, because a slab is named by the Zotero object it
 * was extracted from, while an entry is named by what seg/1 made of it. */
export type SlabSource = 'attachment' | 'record' | 'note' | 'annotation';

export interface EntryInput {
  lib: number;
  itemKey: string;
  /** Absent for a record or own-words entry, which belong to the item itself. */
  attachmentKey?: string;
  /** Position in this source's entry stream. Unique within it — see the DDL. */
  ordinal: number;
  kind: EntryKind;
  heading?: string;
  /** The heading path, `»`-joined by the segmenter. Charged to the chunk budget (§5.2.2). */
  path?: string;
  /** Character range in the source text this entry was cut from. */
  charStart: number;
  charEnd: number;
  pageEst?: number;
  pageEstKind?: string;
}

/**
 * A stored entry. Not `extends EntryInput`: what is *absent* on the way in comes back as
 * an explicit `null`, and conflating the two is how a caller ends up writing `undefined`
 * into a column and reading it as the string "undefined".
 */
export interface EntryRow extends Omit<EntryInput, 'attachmentKey' | 'heading' | 'path' | 'pageEst' | 'pageEstKind'> {
  eid: number;
  attachmentKey: string | null;
  heading: string | null;
  path: string | null;
  pageEst: number | null;
  pageEstKind: string | null;
}

export interface SlabInput {
  lib: number;
  source: SlabSource;
  sourceKey: string;
  /** The range of the source document this slab holds. Cuts land on entry boundaries. */
  charStart: number;
  charEnd: number;
  /** The text itself. Gzipped on the way in; the column never holds plain text. */
  text: string;
}

export interface PassageInput {
  eid: number;
  lib: number;
  itemKey: string;
  sid: number;
  /** Offsets **within the slab's own text**, not in the source document: the slab range is
   * the dispatch address (§5.2.2), so a passage addresses the slab it will be read from. */
  offStart: number;
  offEnd: number;
  /**
   * The fingerprint the re-derived snippet is verified against. Computed from the slab
   * slice when omitted, which is the only way it is ever right at first write; passing it
   * explicitly is for a writer replaying a fingerprint it already holds.
   */
  fp?: string;
}

export interface PassageRow {
  pid: number;
  eid: number;
  lib: number;
  itemKey: string;
  sid: number;
  offStart: number;
  offEnd: number;
  fp: string;
}

/** What an existing file says it is, read without writing a byte of it. */
type StoredVersion = number | 'fresh' | 'unstamped';

/** Options that change how the file is opened, as opposed to what is in it. */
export interface LedgerOpenOptions {
  /**
   * Force the FTS layout the probe would otherwise choose.
   *
   * The fallback exists for a runtime below SQLite 3.43, and every runtime this is
   * developed and tested on is above it — so without a way to ask for it, the fallback
   * would ship as the one code path nothing has ever executed. That is what this is for,
   * and it is the whole reason it is public.
   */
  ftsStorage?: FtsStorage;
}

export class LedgerVersionError extends Error {
  constructor(
    readonly path: string,
    readonly stored: StoredVersion,
  ) {
    super(
      stored === 'unstamped'
        ? `${path} holds tables but no readable schema stamp, so this build cannot tell what is in it. ` +
            'Move it aside and let a fresh ledger be created; it is not deleted for you.'
        : `${path} was written by a newer build (schema ${String(stored)}; this build understands ` +
            `${LEDGER_SCHEMA_VERSION}). Refusing to open it: re-stamping would destroy the one piece of ` +
            'evidence the stamp exists to carry.',
    );
    this.name = 'LedgerVersionError';
  }
}

/**
 * The three discovery classes, in priority order (SPEC.md §5.2.3): a record before its
 * own words before its body text. The order is a column, not a scheduler — see the
 * `class_rank` generated column below.
 */
export type WorkClass = 'metadata' | 'own_words' | 'body';

/**
 * The two body lanes SPEC.md §5.2.5 level 3 interleaves at r = 3: work the reconcile tick
 * found because something changed, against the initial sweep. The ledger stores the lane
 * and orders inside it; the arbitration between lanes belongs to the conductor.
 */
export type WorkLane = 'fresh' | 'backfill';

/** What a work order asks for. `verify` is §5.2.1's one-fetch-one-hash, not a recompute. */
export type WorkOp = 'index' | 'verify' | 'delete';

export type WorkStatus = 'pending' | 'claimed' | 'done' | 'failed';

/** `local` is the desktop API's own sequence; `cloud` is the Web API's. They never mix. */
export type LibraryScope = 'local' | 'cloud';

export interface LibraryInput {
  oid: number;
  kind: 'user' | 'group';
  remoteId: number;
  scope: LibraryScope;
}

export interface LibraryRow extends LibraryInput {
  lib: number;
  itemWatermark: number;
  fulltextWatermark: number | null;
}

export interface WorkOrderInput {
  lib: number;
  class: WorkClass;
  op: WorkOp;
  itemKey?: string;
  attachmentKey?: string;
  /** 0 is the frontier, 1 the tail of a long item (§5.2.3). Tranche 1 only ever writes 0. */
  band?: 0 | 1;
  lane?: WorkLane;
  /** Zotero's own `dateAdded`, the newest-first sort key inside a class. */
  dateAdded?: string;
  /** The signal (§5.2.1) this order was derived from, for the claim to compare against. */
  signal?: string;
}

export interface WorkOrderRow {
  wid: number;
  lib: number;
  class: WorkClass;
  op: WorkOp;
  itemKey: string | null;
  attachmentKey: string | null;
  band: number;
  lane: WorkLane;
  dateAdded: string | null;
  status: WorkStatus;
  signal: string | null;
  claimedBy: string | null;
  claimedInput: string | null;
  claimExpiresAt: number | null;
  enqueuedAt: number;
}

export interface LeaseRow {
  name: string;
  holder: string | null;
  expiresAt: number;
}

/** What the delta read knows about an item beyond its version. */
export interface ItemDetail {
  dateAdded: string | null;
  itemType: string | null;
  parentItem: string | null;
}

/** One attachment's row in the full-text census, carrying both halves of §5.2.4's signal. */
export interface FulltextCensusEntry {
  ftVersion: number;
  itemVersion: number;
}

/**
 * The conductor's ledger: `search-index-v2`'s bookkeeping half.
 *
 * It holds what Zotero last told us (the two censuses and the watermarks), what is
 * therefore owed (the stage queue), who is working each row (the claims), and who may
 * write at all (the lease). It stores no content: slabs, entries and passages are the
 * later tranches' and are deliberately absent here rather than stubbed, because a table
 * nobody writes is a claim that the design has been built.
 *
 * **Priority is an ORDER BY over these columns; there is no scheduler object.** The
 * class order of §5.2.3 rides a stored generated column so the index can carry it, the
 * band is a column, recency is `date_added DESC`, and the lane is a filter the caller
 * applies when it wants to interleave. Everything a dispatcher needs is a query.
 *
 * **One writer.** SPEC.md §5.2.5 elects exactly one conductor and gives it the only write
 * handle, which is what lets `enqueue` read-then-write without a race and why the lease
 * table is here rather than in a lock file.
 */
export class Ledger {
  /**
   * The raw handle. Exposed because the election statement in §5.2.5 is quoted verbatim
   * in the spec and belongs to tranche 2: the ledger owes it a valid table, not a method
   * wrapping a statement it does not yet implement.
   */
  readonly db: Database;
  /**
   * Whether the file this handle holds is *actually* on incremental vacuum — read back
   * from the header, never assumed from the statement that asked for it.
   *
   * §5.2.2 says the pragma is a no-op if set after the first table. Measured, it is worse:
   * `PRAGMA journal_mode = WAL` writes the header too, so setting auto_vacuum after WAL
   * loses it with no table in the file yet. `open()` therefore sets it before both, and
   * this flag reports what came of that. False on a file some earlier build created
   * without it — which no pragma can repair, only a full `VACUUM` — so a future migration
   * and an operator can both see the difference between intent and header.
   */
  get autoVacuumIncremental(): boolean {
    return readAutoVacuum(this.db) === 2;
  }
  /** Which FTS layout this file uses. Probed once at creation and then read, not re-probed. */
  readonly ftsStorage: FtsStorage;
  private readonly clock: Clock;

  private constructor(db: Database, clock: Clock, ftsStorage: FtsStorage) {
    this.db = db;
    this.clock = clock;
    this.ftsStorage = ftsStorage;
  }

  /**
   * Open the ledger, applying §5.2.2's connection settings in the order it requires.
   *
   * The order below is the specification, not a style choice, and two steps of it are
   * load-bearing in ways nothing would report if they were wrong:
   *
   * 1. **The stamp is read first**, through a genuinely read-only handle, because the
   *    pragmas underneath rewrite header bytes. A file from a build this one does not
   *    understand is refused, never re-stamped — v1's own lesson (`sqlite-index.ts`), where
   *    stamping before reading destroyed the evidence at the moment it mattered.
   * 2. **`auto_vacuum` is set before WAL and before the first table.** Either one after it
   *    makes it a silent no-op, and §5.2.7's idle `incremental_vacuum` would then never
   *    reclaim a page — a defect with no symptom but a file that keeps growing. Not
   *    unrecoverable: `PRAGMA auto_vacuum=INCREMENTAL` followed by a full `VACUUM` does
   *    restore it (measured, and it survives reopen). What it is not is *self*-correcting,
   *    and nothing here would ever notice it needed correcting — which is why the order is
   *    a rule rather than advice, and why `autoVacuumIncremental` reports the header.
   */
  static open(path: string, clock: Clock = systemClock, opts: LedgerOpenOptions = {}): Ledger {
    if (path !== ':memory:' && existsSync(path)) {
      const stored = readStoredVersion(path);
      if (stored === 'unstamped' || (typeof stored === 'number' && stored > LEDGER_SCHEMA_VERSION)) {
        throw new LedgerVersionError(path, stored);
      }
    }

    const db = new DatabaseSync(path);
    // Before anything that takes a lock, so every statement below inherits the wait.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Before WAL and before the first table. See the class docstring above.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    // WAL for the same reason v1 takes it: a pipeline commits constantly, and WAL makes
    // those commits cheap while still leaving a complete database behind a crash. The mode
    // is a property of the file, so a second process that already set it has settled the
    // question and failing to set what is already set is not worth refusing to open over.
    // `:memory:` has no WAL at all and reports `memory`; that is not a failure either.
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // Left as whatever mode the file is in. Nothing here depends on WAL for correctness.
    }
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');

    const ledger = new Ledger(db, clock, resolveFtsStorage(db, opts.ftsStorage));
    ledger.createSchema();
    return ledger;
  }

  close(): void {
    this.db.close();
  }

  /** Run `fn` inside one transaction. A tick's whole set of writes lands or none does. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT);

      -- The Zotero-Server-ID partition C1 mandates. Two Zotero installations both serve
      -- users/0; without this every row of the second would collide with the first.
      CREATE TABLE IF NOT EXISTS origins (
        oid       INTEGER PRIMARY KEY,
        server_id TEXT NOT NULL UNIQUE
      );

      -- Libraries hang under origins, and every downstream row carries \`lib\`.
      --
      -- The CHECK is the point of this table. SPEC.md §5.2.4(2): a LOCAL scope has no
      -- monotonic full-text sequence — one attachment's version may be a web sync stamp,
      -- a local client version, or 0 for locally extracted text — so a \`?since=\` cursor
      -- over it silently loses work. Cloud scopes do have one. Rather than document that
      -- and hope, the column simply cannot hold a value for a local scope: the trap is
      -- unrepresentable. \`item_watermark\` needs no such guard, because library versions
      -- ARE monotonic per backend, which is exactly what scoping by server id buys.
      CREATE TABLE IF NOT EXISTS libraries (
        lib                INTEGER PRIMARY KEY,
        oid                INTEGER NOT NULL REFERENCES origins(oid),
        kind               TEXT NOT NULL CHECK (kind IN ('user', 'group')),
        remote_id          INTEGER NOT NULL,
        scope              TEXT NOT NULL CHECK (scope IN ('local', 'cloud')),
        item_watermark     INTEGER NOT NULL DEFAULT 0,
        fulltext_watermark INTEGER,
        UNIQUE (oid, kind, remote_id),
        CHECK (fulltext_watermark IS NULL OR scope = 'cloud')
      );

      -- Cursors a stage other than the two Zotero sequences needs. The CHECK closes the
      -- back door the table would otherwise open: without it a caller refused a full-text
      -- watermark by the libraries CHECK could store the identical cursor here.
      CREATE TABLE IF NOT EXISTS cursors (
        lib        INTEGER NOT NULL REFERENCES libraries(lib),
        name       TEXT NOT NULL CHECK (name <> 'fulltext'),
        value      INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (lib, name)
      );

      -- What Zotero said existed, last time we asked. Kept because the local API has no
      -- /deleted endpoint (C2): subtracting this from a fresh census is the only route to
      -- a deletion, and R35 gives that a one-minute bound.
      -- The version is the signal; the other three columns are what the delta read hands
      -- over on its way past and nothing else would ever ask Zotero for again. \`date_added\`
      -- is the newest-first sort key of §5.2.3, \`item_type\` decides the discovery class,
      -- and \`parent_item\` is how a full-text census entry — which carries an attachment
      -- key and nothing else — finds the item it belongs to.
      CREATE TABLE IF NOT EXISTS item_census (
        lib         INTEGER NOT NULL REFERENCES libraries(lib),
        item_key    TEXT NOT NULL,
        version     INTEGER NOT NULL,
        date_added  TEXT,
        item_type   TEXT,
        parent_item TEXT,
        PRIMARY KEY (lib, item_key)
      );

      -- The extract stage's signal, both halves of it (§5.2.4, version-0 residue (i)):
      -- the full-text version, and the attachment ITEM's version. Full-text version alone
      -- cannot see a re-extraction that stamps 0 again; a replaced file bumps the item
      -- version in the sequence the tick already sweeps, so pairing them catches it free.
      CREATE TABLE IF NOT EXISTS fulltext_census (
        lib            INTEGER NOT NULL REFERENCES libraries(lib),
        attachment_key TEXT NOT NULL,
        ft_version     INTEGER NOT NULL,
        item_version   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (lib, attachment_key)
      );

      -- The stage queue. \`class_rank\` is stored rather than computed at read time so the
      -- covering index below carries the priority order itself: dispatch is one indexed
      -- ORDER BY, and nothing between the ledger and the pipe has to know the ranking.
      CREATE TABLE IF NOT EXISTS stage_queue (
        wid              INTEGER PRIMARY KEY,
        lib              INTEGER NOT NULL REFERENCES libraries(lib),
        class            TEXT NOT NULL CHECK (class IN ('metadata', 'own_words', 'body')),
        class_rank       INTEGER GENERATED ALWAYS AS (
                           CASE class WHEN 'metadata' THEN 0 WHEN 'own_words' THEN 1 ELSE 2 END
                         ) STORED,
        band             INTEGER NOT NULL DEFAULT 0 CHECK (band IN (0, 1)),
        lane             TEXT NOT NULL DEFAULT 'fresh' CHECK (lane IN ('fresh', 'backfill')),
        op               TEXT NOT NULL CHECK (op IN ('index', 'verify', 'delete')),
        item_key         TEXT,
        attachment_key   TEXT,
        date_added       TEXT,
        signal           TEXT,
        status           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'claimed', 'done', 'failed')),
        claimed_by       TEXT,
        claimed_input    TEXT,
        claim_expires_at INTEGER,
        enqueued_at      INTEGER NOT NULL,
        note             TEXT,
        -- A claim is a holder, an input and an expiry, or it is nothing. A row claimed by
        -- nobody until some time is a shape the recovery path would read as live.
        CHECK ((status = 'claimed') = (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL))
      );

      CREATE INDEX IF NOT EXISTS stage_queue_priority
        ON stage_queue(status, lib, class_rank, band, date_added DESC, wid);
      CREATE INDEX IF NOT EXISTS stage_queue_identity
        ON stage_queue(lib, class, op, item_key, attachment_key, band, status);
      CREATE INDEX IF NOT EXISTS stage_queue_claims
        ON stage_queue(status, claim_expires_at);

      -- One row per named lease. Tranche 1 owes tranche 2 a table the election statement
      -- of §5.2.5 is valid against; the election itself is not here.
      CREATE TABLE IF NOT EXISTS leases (
        name       TEXT PRIMARY KEY,
        holder     TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0
      );

      -- ------------------------------------------------------------------ content
      -- SPEC.md §5.2.2's entry layer. Same file, same schema, same stamp as everything
      -- above: the bookkeeping half knows what is owed, this half holds what was made of
      -- it, and a reader that could find one without the other would have no way to tell
      -- a half-built index from a finished one.

      -- The text store. Record and own-words text is slabbed too, not only attachment
      -- bodies: without it the first 100 % (phase A) would ship hits whose snippets
      -- cannot be re-derived, which is a hit that cannot be shown.
      --
      -- \`bytes\` is gzip, never plain text, and the CHECK is §5.2.2's 1 MiB ceiling
      -- stated where it cannot be forgotten. A slab past it is not a big slab, it is a
      -- cut that was made by byte count instead of on an entry boundary.
      CREATE TABLE IF NOT EXISTS slabs (
        sid          INTEGER PRIMARY KEY,
        lib          INTEGER NOT NULL REFERENCES libraries(lib),
        source       TEXT NOT NULL CHECK (source IN ('attachment', 'record', 'note', 'annotation')),
        source_key   TEXT NOT NULL,
        char_start   INTEGER NOT NULL,
        char_end     INTEGER NOT NULL,
        bytes        BLOB NOT NULL,
        content_hash TEXT NOT NULL,
        CHECK (char_end >= char_start),
        CHECK (length(bytes) <= ${MAX_SLAB_BYTES})
      );
      CREATE INDEX IF NOT EXISTS slabs_source ON slabs(lib, source, source_key, char_start);

      -- What seg/1 cut the text into. The dictionary case is the point of the table: 1 850
      -- headwords become 1 850 first-class peers rather than one document.
      --
      -- \`page_est_kind\` carries no CHECK deliberately. §5.2.2 names the column and not
      -- its vocabulary, and a CHECK over values nobody has ratified would have to be
      -- guessed — which is how a schema starts refusing rows the design intends.
      CREATE TABLE IF NOT EXISTS entries (
        eid            INTEGER PRIMARY KEY,
        lib            INTEGER NOT NULL REFERENCES libraries(lib),
        item_key       TEXT NOT NULL,
        attachment_key TEXT,
        ordinal        INTEGER NOT NULL,
        heading        TEXT,
        path           TEXT,
        kind           TEXT NOT NULL
                         CHECK (kind IN ('record', 'note', 'annotation', 'body', 'synthetic')),
        char_start     INTEGER NOT NULL,
        char_end       INTEGER NOT NULL,
        page_est       INTEGER,
        page_est_kind  TEXT,
        CHECK (char_end >= char_start)
      );
      -- An expression index rather than \`UNIQUE (lib, item_key, attachment_key, ordinal)\`,
      -- because SQLite treats NULLs as distinct in a UNIQUE constraint: a record or
      -- own-words stream, whose \`attachment_key\` is NULL, would slip through the
      -- constraint entirely and accept a second entry at the same ordinal. \`ifnull\` closes
      -- that hole, and an ordinal that repeats inside one stream is not a duplicate row —
      -- it is two different texts claiming the same position.
      CREATE UNIQUE INDEX IF NOT EXISTS entries_stream_ordinal
        ON entries(lib, item_key, ifnull(attachment_key, ''), ordinal);
      CREATE INDEX IF NOT EXISTS entries_item ON entries(lib, item_key);

      -- References, not text (§5.2.2). A snippet is re-derived from our own slab store and
      -- never from Zotero: gunzip the slab, slice it, verify \`fp\`, and return nothing
      -- rather than the wrong words. \`off_start\`/\`off_end\` are offsets INTO THE SLAB, not
      -- into the source document, because the slab range is also the dispatch address an
      -- embed work order carries (§5.2.5) — so text already stored never crosses the pipe
      -- again, and a passage addresses the thing it will actually be read from.
      CREATE TABLE IF NOT EXISTS passages (
        pid       INTEGER PRIMARY KEY,
        eid       INTEGER NOT NULL REFERENCES entries(eid),
        lib       INTEGER NOT NULL REFERENCES libraries(lib),
        item_key  TEXT NOT NULL,
        sid       INTEGER NOT NULL REFERENCES slabs(sid),
        off_start INTEGER NOT NULL,
        off_end   INTEGER NOT NULL,
        fp        TEXT NOT NULL,
        CHECK (off_end >= off_start)
      );
      CREATE INDEX IF NOT EXISTS passages_entry ON passages(eid);
      CREATE INDEX IF NOT EXISTS passages_item ON passages(lib, item_key);
    `);
    this.createFts();
    this.db
      .prepare('INSERT OR REPLACE INTO ledger_meta(key, value) VALUES (?, ?)')
      .run('schemaVersion', String(LEDGER_SCHEMA_VERSION));
    // Recorded because it is a decision, not a fact about this run: the layout is chosen
    // once, when the file is created, and every later open must build statements for the
    // layout the rows are actually in — not for the one this runtime would pick today.
    this.db
      .prepare('INSERT OR REPLACE INTO ledger_meta(key, value) VALUES (?, ?)')
      .run('ftsStorage', this.ftsStorage);
    // The row must exist for the election UPDATE to have anything to take: an election
    // written as an UPDATE cannot create its own row, and an INSERT-or-UPDATE election is
    // a different (and racier) statement than the one the spec ratified.
    this.db.prepare("INSERT OR IGNORE INTO leases(name, holder, expires_at) VALUES ('conductor', NULL, 0)").run();
  }

  /**
   * The per-field FTS5 table of §5.2.2, in whichever layout this file was created under.
   *
   * Per-field columns, not v1's two joined ones, for two reasons the spec states and this
   * file's tests pin: fields keep their identity for ranking, so a tag match no longer
   * scores like a title match; and joined fields break phrase search, because unicode61
   * treats the `'. '` join as a separator and a quoted phrase can match across the seam.
   *
   * bm25 column weights are deliberately absent. §5.2.2 ships them "as a starting point
   * and tuned against the golden set once it is re-pinned at entry granularity, not
   * before" — a weight written here now would be a design number invented at the keyboard.
   */
  private createFts(): void {
    const cols = FTS_FIELDS.join(', ');
    if (this.ftsStorage === 'contentless') {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
           ${cols},
           tokenize = 'unicode61 remove_diacritics 2',
           content = '',
           contentless_delete = 1
         );`,
      );
      return;
    }
    // v1's external-content layout: the text lives in a shadow table keyed by the passage
    // id, and the index points back at it by rowid.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fts_content (
        pid INTEGER PRIMARY KEY REFERENCES passages(pid),
        ${FTS_FIELDS.map((f) => `${f} TEXT`).join(',\n        ')}
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        ${cols},
        content = 'fts_content',
        content_rowid = 'pid',
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  // ---------------------------------------------------------------- identity

  registerOrigin(serverId: string): number {
    this.db.prepare('INSERT OR IGNORE INTO origins(server_id) VALUES (?)').run(serverId);
    const row = this.db.prepare('SELECT oid FROM origins WHERE server_id = ?').get(serverId) as
      | { oid: number }
      | undefined;
    if (!row) throw new Error(`origin ${serverId} did not register`);
    return row.oid;
  }

  registerLibrary(input: LibraryInput): number {
    this.db
      .prepare('INSERT OR IGNORE INTO libraries(oid, kind, remote_id, scope) VALUES (?, ?, ?, ?)')
      .run(input.oid, input.kind, input.remoteId, input.scope);
    const row = this.db
      .prepare('SELECT lib FROM libraries WHERE oid = ? AND kind = ? AND remote_id = ?')
      .get(input.oid, input.kind, input.remoteId) as { lib: number } | undefined;
    if (!row) throw new Error(`library ${input.kind}/${input.remoteId} did not register`);
    return row.lib;
  }

  library(lib: number): LibraryRow | undefined {
    const r = this.db.prepare('SELECT * FROM libraries WHERE lib = ?').get(lib) as any;
    return r ? toLibraryRow(r) : undefined;
  }

  libraries(): LibraryRow[] {
    return (this.db.prepare('SELECT * FROM libraries ORDER BY lib').all() as any[]).map(toLibraryRow);
  }

  // -------------------------------------------------------------- watermarks

  itemWatermark(lib: number): number {
    const r = this.db.prepare('SELECT item_watermark AS v FROM libraries WHERE lib = ?').get(lib) as
      | { v: number }
      | undefined;
    return r?.v ?? 0;
  }

  setItemWatermark(lib: number, value: number): void {
    this.db.prepare('UPDATE libraries SET item_watermark = ? WHERE lib = ?').run(value, lib);
  }

  fulltextWatermark(lib: number): number | null {
    const r = this.db.prepare('SELECT fulltext_watermark AS v FROM libraries WHERE lib = ?').get(lib) as
      | { v: number | null }
      | undefined;
    return r?.v ?? null;
  }

  /** Throws on a local-scope library: the CHECK, not a guard in front of it, is the rule. */
  setFulltextWatermark(lib: number, value: number): void {
    this.db.prepare('UPDATE libraries SET fulltext_watermark = ? WHERE lib = ?').run(value, lib);
  }

  cursor(lib: number, name: string): number | undefined {
    const r = this.db.prepare('SELECT value AS v FROM cursors WHERE lib = ? AND name = ?').get(lib, name) as
      | { v: number }
      | undefined;
    return r?.v;
  }

  setCursor(lib: number, name: string, value: number): void {
    this.db
      .prepare(
        `INSERT INTO cursors(lib, name, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(lib, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(lib, name, value, this.clock.now());
  }

  // ---------------------------------------------------------------- censuses

  itemCensus(lib: number): Map<string, number> {
    const rows = this.db.prepare('SELECT item_key, version FROM item_census WHERE lib = ?').all(lib) as Array<{
      item_key: string;
      version: number;
    }>;
    return new Map(rows.map((r) => [r.item_key, r.version]));
  }

  /**
   * Record the versions the full census reported. Version only: the census is a map of
   * key to number and knows nothing else, so an upsert that also wrote the detail columns
   * would blank what the delta read had just filled in.
   */
  putItemCensus(lib: number, entries: Iterable<[string, number]>): void {
    const stmt = this.db.prepare(
      `INSERT INTO item_census(lib, item_key, version) VALUES (?, ?, ?)
         ON CONFLICT(lib, item_key) DO UPDATE SET version = excluded.version`,
    );
    for (const [key, version] of entries) stmt.run(lib, key, version);
  }

  /** Record what the delta read said about one item, beyond its version. */
  putItemDetail(lib: number, key: string, detail: ItemDetail): void {
    this.db
      .prepare(
        `INSERT INTO item_census(lib, item_key, version, date_added, item_type, parent_item)
           VALUES (:lib, :key, 0, :dateAdded, :itemType, :parentItem)
           ON CONFLICT(lib, item_key) DO UPDATE
             SET date_added = excluded.date_added,
                 item_type = excluded.item_type,
                 parent_item = excluded.parent_item`,
      )
      .run({
        lib,
        key,
        dateAdded: detail.dateAdded ?? null,
        itemType: detail.itemType ?? null,
        parentItem: detail.parentItem ?? null,
      });
  }

  itemDetail(lib: number, key: string): ItemDetail | undefined {
    const r = this.db
      .prepare('SELECT date_added, item_type, parent_item FROM item_census WHERE lib = ? AND item_key = ?')
      .get(lib, key) as { date_added: string | null; item_type: string | null; parent_item: string | null } | undefined;
    if (!r) return undefined;
    return { dateAdded: r.date_added, itemType: r.item_type, parentItem: r.parent_item };
  }

  deleteItemCensus(lib: number, keys: Iterable<string>): void {
    const stmt = this.db.prepare('DELETE FROM item_census WHERE lib = ? AND item_key = ?');
    for (const key of keys) stmt.run(lib, key);
  }

  fulltextCensus(lib: number): Map<string, FulltextCensusEntry> {
    const rows = this.db
      .prepare('SELECT attachment_key, ft_version, item_version FROM fulltext_census WHERE lib = ?')
      .all(lib) as Array<{ attachment_key: string; ft_version: number; item_version: number }>;
    return new Map(rows.map((r) => [r.attachment_key, { ftVersion: r.ft_version, itemVersion: r.item_version }]));
  }

  putFulltextCensus(lib: number, entries: Iterable<[string, FulltextCensusEntry]>): void {
    const stmt = this.db.prepare(
      `INSERT INTO fulltext_census(lib, attachment_key, ft_version, item_version) VALUES (?, ?, ?, ?)
         ON CONFLICT(lib, attachment_key)
         DO UPDATE SET ft_version = excluded.ft_version, item_version = excluded.item_version`,
    );
    for (const [key, entry] of entries) stmt.run(lib, key, entry.ftVersion, entry.itemVersion);
  }

  deleteFulltextCensus(lib: number, keys: Iterable<string>): void {
    const stmt = this.db.prepare('DELETE FROM fulltext_census WHERE lib = ? AND attachment_key = ?');
    for (const key of keys) stmt.run(lib, key);
  }

  // ------------------------------------------------------------- stage queue

  /**
   * Add a work order, or refresh the one already owed.
   *
   * Re-enqueueing is the normal case, not an edge: the tick re-derives what should exist
   * every 60 s, so an order the worker has not reached yet is rediscovered up to sixty
   * times a minute-long backlog. Without the merge the queue grows without bound while
   * nothing new has happened. Read-then-write is safe because the conductor is the only
   * writer (§5.2.5); a second writer would need this as one statement.
   */
  enqueue(input: WorkOrderInput): number {
    const band = input.band ?? 0;
    // An order about an attachment is identified by the attachment, not by the pair. The
    // parent item is learned later than the attachment key is — the full-text census
    // carries only the key — so keying on both would file a second row for the same work
    // the moment the parent became known.
    const existing = (
      input.attachmentKey
        ? this.db
            .prepare(
              `SELECT wid FROM stage_queue
                 WHERE lib = ? AND class = ? AND op = ? AND band = ? AND attachment_key IS ?
                   AND status IN ('pending', 'claimed')
                 ORDER BY wid LIMIT 1`,
            )
            .get(input.lib, input.class, input.op, band, input.attachmentKey)
        : this.db
            .prepare(
              `SELECT wid FROM stage_queue
                 WHERE lib = ? AND class = ? AND op = ? AND band = ?
                   AND item_key IS ? AND attachment_key IS NULL
                   AND status IN ('pending', 'claimed')
                 ORDER BY wid LIMIT 1`,
            )
            .get(input.lib, input.class, input.op, band, input.itemKey ?? null)
    ) as { wid: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE stage_queue
              SET lane = COALESCE(?, lane),
                  date_added = COALESCE(?, date_added),
                  signal = COALESCE(?, signal),
                  item_key = COALESCE(?, item_key)
            WHERE wid = ?`,
        )
        .run(input.lane ?? null, input.dateAdded ?? null, input.signal ?? null, input.itemKey ?? null, existing.wid);
      return existing.wid;
    }

    const res = this.db
      .prepare(
        `INSERT INTO stage_queue(lib, class, band, lane, op, item_key, attachment_key, date_added, signal, enqueued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.lib,
        input.class,
        band,
        input.lane ?? 'fresh',
        input.op,
        input.itemKey ?? null,
        input.attachmentKey ?? null,
        input.dateAdded ?? null,
        input.signal ?? null,
        this.clock.now(),
      );
    return Number(res.lastInsertRowid);
  }

  /**
   * The next thing to do, in the order §5.2.3 states: class, then band, then newest first.
   *
   * `lane` narrows the read to one side of the level-3 interleave. Unfiltered, this is a
   * single order over both lanes — which is not the arbitration, deliberately: r = 3
   * weighted round robin is a policy the conductor applies by choosing which lane to ask.
   */
  nextWorkOrder(opts: { lib?: number; lane?: WorkLane } = {}): WorkOrderRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM stage_queue
           WHERE status = 'pending'
             AND (:lib IS NULL OR lib = :lib)
             AND (:lane IS NULL OR lane = :lane)
           ORDER BY class_rank ASC, band ASC, date_added DESC, wid ASC
           LIMIT 1`,
      )
      .get({ lib: opts.lib ?? null, lane: opts.lane ?? null }) as any;
    return row ? toWorkOrderRow(row) : undefined;
  }

  row(wid: number): WorkOrderRow | undefined {
    const r = this.db.prepare('SELECT * FROM stage_queue WHERE wid = ?').get(wid) as any;
    return r ? toWorkOrderRow(r) : undefined;
  }

  pending(lib?: number): WorkOrderRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM stage_queue
           WHERE status = 'pending' AND (:lib IS NULL OR lib = :lib)
           ORDER BY class_rank ASC, band ASC, date_added DESC, wid ASC`,
      )
      .all({ lib: lib ?? null }) as any[];
    return rows.map(toWorkOrderRow);
  }

  /**
   * Take a row, recording the input it was taken against.
   *
   * `claimed_input` is what makes a recovered claim safe to reason about: a row released
   * by expiry and re-claimed may be re-derived from a different input than the dead
   * holder saw, and a stage that compares the two can tell a duplicated micro-batch from
   * a stale one. Returns false when someone else holds a live claim.
   */
  claim(wid: number, holder: string, claimedInput: string, ttlMs: number): boolean {
    const now = this.clock.now();
    const res = this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'claimed', claimed_by = :holder, claimed_input = :input, claim_expires_at = :expires
          WHERE wid = :wid
            AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= :now))`,
      )
      .run({ wid, holder, input: claimedInput, expires: now + ttlMs, now });
    return Number(res.changes) === 1;
  }

  /**
   * Return every row whose claim has run out to the queue.
   *
   * The claim is dropped rather than kept for comparison: the row's own `signal` already
   * records what the tick derived it from, so nothing is lost, and a released row that
   * still carries a dead holder's input reads as claimed to every query that looks.
   */
  releaseExpiredClaims(): number {
    const res = this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'pending', claimed_by = NULL, claimed_input = NULL, claim_expires_at = NULL
          WHERE status = 'claimed' AND claim_expires_at <= :now`,
      )
      .run({ now: this.clock.now() });
    return Number(res.changes);
  }

  markDone(wid: number): void {
    this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'done', claimed_by = NULL, claimed_input = NULL, claim_expires_at = NULL
          WHERE wid = ?`,
      )
      .run(wid);
  }

  markFailed(wid: number, note?: string): void {
    this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'failed', claimed_by = NULL, claimed_input = NULL, claim_expires_at = NULL, note = ?
          WHERE wid = ?`,
      )
      .run(note ?? null, wid);
  }

  // ----------------------------------------------------------------- content

  /**
   * Store one slab, gzipped, and return its id.
   *
   * The compression is not an optimisation detail the caller may opt out of: §5.2.2 sizes
   * the ceiling in *gzip* bytes, so a plain-text column would put the CHECK on a different
   * quantity than the spec bounds. `content_hash` is over the text, not the bytes — gzip
   * is not deterministic across implementations, and a hash that changed with the
   * compressor would break every identity comparison built on it.
   */
  putSlab(input: SlabInput): number {
    const bytes = gzipSync(Buffer.from(input.text, 'utf8'));
    const res = this.db
      .prepare(
        `INSERT INTO slabs(lib, source, source_key, char_start, char_end, bytes, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.lib, input.source, input.sourceKey, input.charStart, input.charEnd, bytes, fingerprint(input.text));
    return Number(res.lastInsertRowid);
  }

  /** The slab's text, gunzipped. Undefined when there is no such slab. */
  slabText(sid: number): string | undefined {
    const row = this.db.prepare('SELECT bytes FROM slabs WHERE sid = ?').get(sid) as { bytes: Uint8Array } | undefined;
    return row ? gunzipSync(Buffer.from(row.bytes)).toString('utf8') : undefined;
  }

  putEntry(input: EntryInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO entries(lib, item_key, attachment_key, ordinal, heading, path, kind,
                             char_start, char_end, page_est, page_est_kind)
           VALUES (:lib, :itemKey, :attachmentKey, :ordinal, :heading, :path, :kind,
                   :charStart, :charEnd, :pageEst, :pageEstKind)`,
      )
      .run({
        lib: input.lib,
        itemKey: input.itemKey,
        attachmentKey: input.attachmentKey ?? null,
        ordinal: input.ordinal,
        heading: input.heading ?? null,
        path: input.path ?? null,
        kind: input.kind,
        charStart: input.charStart,
        charEnd: input.charEnd,
        pageEst: input.pageEst ?? null,
        pageEstKind: input.pageEstKind ?? null,
      });
    return Number(res.lastInsertRowid);
  }

  entry(eid: number): EntryRow | undefined {
    const r = this.db.prepare('SELECT * FROM entries WHERE eid = ?').get(eid) as any;
    return r ? toEntryRow(r) : undefined;
  }

  /** One item's entries, in the order seg/1 cut them. */
  entries(lib: number, itemKey: string): EntryRow[] {
    const rows = this.db
      .prepare('SELECT * FROM entries WHERE lib = ? AND item_key = ? ORDER BY ifnull(attachment_key, \'\'), ordinal')
      .all(lib, itemKey) as any[];
    return rows.map(toEntryRow);
  }

  /**
   * File a passage against a slab range, fingerprinting the slice it addresses.
   *
   * The fingerprint is taken here, from the bytes actually stored, rather than handed in
   * by the segmenter: a fingerprint computed over the text the caller *meant* to store
   * would verify the caller's intent against itself and pass on every mismatch this exists
   * to catch.
   */
  putPassage(input: PassageInput): number {
    const fp = input.fp ?? this.sliceFingerprint(input.sid, input.offStart, input.offEnd);
    if (fp === undefined) throw new Error(`slab ${input.sid} does not exist, or does not cover the passage range`);
    const res = this.db
      .prepare('INSERT INTO passages(eid, lib, item_key, sid, off_start, off_end, fp) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.eid, input.lib, input.itemKey, input.sid, input.offStart, input.offEnd, fp);
    return Number(res.lastInsertRowid);
  }

  passage(pid: number): PassageRow | undefined {
    const r = this.db.prepare('SELECT * FROM passages WHERE pid = ?').get(pid) as any;
    if (!r) return undefined;
    return {
      pid: r.pid,
      eid: r.eid,
      lib: r.lib,
      itemKey: r.item_key,
      sid: r.sid,
      offStart: r.off_start,
      offEnd: r.off_end,
      fp: r.fp,
    };
  }

  /**
   * The passage's own words, re-derived from our slab store — or null.
   *
   * Null rather than wrong words is the whole contract (§5.2.2). Every route to a mismatch
   * ends here: a slab replaced under the passage, an offset that no longer lands where it
   * did, a re-extraction that moved the text. A snippet is shown to a reader as a quotation
   * from their own library, and a plausible wrong one costs more than a missing one.
   */
  snippet(pid: number): string | null {
    const row = this.db.prepare('SELECT sid, off_start, off_end, fp FROM passages WHERE pid = ?').get(pid) as
      | { sid: number; off_start: number; off_end: number; fp: string }
      | undefined;
    if (!row) return null;
    const text = this.slabText(row.sid);
    if (text === undefined) return null;
    // A range past the end of the slab slices short in JavaScript rather than throwing,
    // which would hash a truncated string and fail the comparison below anyway — but it is
    // refused here so the reason is the range, not a fingerprint that "just did not match".
    if (row.off_end > text.length) return null;
    const slice = text.slice(row.off_start, row.off_end);
    return fingerprint(slice) === row.fp ? slice : null;
  }

  /** The fingerprint of a slab slice, or undefined when the slab cannot cover the range. */
  private sliceFingerprint(sid: number, offStart: number, offEnd: number): string | undefined {
    const text = this.slabText(sid);
    if (text === undefined || offEnd > text.length) return undefined;
    return fingerprint(text.slice(offStart, offEnd));
  }

  // --------------------------------------------------------------------- FTS

  /**
   * Index one passage's fields. Replaces whatever was indexed for it.
   *
   * Body rows put the chunk in `body` and the heading path plus item title in `ctx`, so a
   * context match counts (weighted) without polluting `body`'s document frequencies or its
   * phrase positions — which is a thing per-field columns make possible and v1's joined
   * ones make unrepresentable.
   */
  indexText(pid: number, fields: FtsFields): void {
    this.unindexText(pid);
    const values = FTS_FIELDS.map((f) => fields[f] ?? null);
    if (this.ftsStorage === 'external') {
      this.db
        .prepare(`INSERT INTO fts_content(pid, ${FTS_FIELDS.join(', ')}) VALUES (${placeholders(1 + FTS_FIELDS.length)})`)
        .run(pid, ...values);
    }
    this.db
      .prepare(`INSERT INTO fts(rowid, ${FTS_FIELDS.join(', ')}) VALUES (${placeholders(1 + FTS_FIELDS.length)})`)
      .run(pid, ...values);
  }

  /**
   * Retire a passage from the index.
   *
   * The two layouts retire a row by different protocols, and getting it wrong is silent
   * either way: a contentless table needs `contentless_delete`, while an external-content
   * one has to be handed back the exact text it indexed before the shadow row goes — a
   * bare delete would leave the index pointing at a rowid that no longer resolves, and the
   * next query over those terms fails or returns a stale hit.
   */
  unindexText(pid: number): void {
    if (this.ftsStorage === 'contentless') {
      this.db.prepare('DELETE FROM fts WHERE rowid = ?').run(pid);
      return;
    }
    const row = this.db.prepare(`SELECT ${FTS_FIELDS.join(', ')} FROM fts_content WHERE pid = ?`).get(pid) as
      | Record<FtsField, string | null>
      | undefined;
    if (!row) return;
    this.db
      .prepare(
        `INSERT INTO fts(fts, rowid, ${FTS_FIELDS.join(', ')}) VALUES ('delete', ?, ${placeholders(FTS_FIELDS.length)})`,
      )
      .run(pid, ...FTS_FIELDS.map((f) => row[f]));
    this.db.prepare('DELETE FROM fts_content WHERE pid = ?').run(pid);
  }

  /**
   * The passage ids matching an FTS5 query, best first.
   *
   * Ranked by bm25 with the default column weights, which is what §5.2.2 says ships now:
   * the weights are tuned against the golden set once it is re-pinned at entry
   * granularity, and until then a hand-set weight would be a design number with no
   * measurement behind it.
   */
  searchFts(query: string, limit = 100): number[] {
    const rows = this.db
      .prepare('SELECT rowid AS pid FROM fts WHERE fts MATCH ? ORDER BY bm25(fts) LIMIT ?')
      .all(query, limit) as Array<{ pid: number }>;
    return rows.map((r) => r.pid);
  }

  // ------------------------------------------------------------------ leases

  lease(name: string): LeaseRow | undefined {
    const r = this.db.prepare('SELECT name, holder, expires_at FROM leases WHERE name = ?').get(name) as
      | { name: string; holder: string | null; expires_at: number }
      | undefined;
    return r ? { name: r.name, holder: r.holder, expiresAt: r.expires_at } : undefined;
  }
}

/**
 * What an existing file says it is, read through a genuinely read-only handle.
 *
 * Read-only matters: `journal_mode = WAL` rewrites bytes in the database header, so the
 * normal connection pragmas cannot run until the stamp has been accepted. A file this
 * build refuses must be left exactly as it was found.
 */
function readStoredVersion(path: string): StoredVersion {
  const probe = new DatabaseSync(path, { readOnly: true });
  try {
    probe.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // A zero-byte file is a valid empty database, which is what a handle opened and
    // dropped leaves behind. Nothing to refuse there.
    const tables = probe.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type IN ('table', 'view')").get() as {
      n: number;
    };
    if (tables.n === 0) return 'fresh';
    // Inspected rather than caught: a missing or foreign-shaped meta table means
    // "unstamped", but a lock or an I/O failure must propagate. Reading every error as an
    // absent stamp would refuse a healthy file merely because another process held it.
    const names = new Set((probe.prepare('PRAGMA table_info(ledger_meta)').all() as Array<{ name: string }>).map((c) => c.name));
    if (!names.has('key') || !names.has('value')) return 'unstamped';
    const row = probe.prepare("SELECT value FROM ledger_meta WHERE key = 'schemaVersion'").get() as
      | { value: string }
      | undefined;
    if (row?.value === undefined) return 'unstamped';
    const version = Number(row.value);
    return Number.isInteger(version) ? version : 'unstamped';
  } finally {
    probe.close();
  }
}

function readAutoVacuum(db: Database): number {
  return (db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
}

/**
 * Which FTS layout this file uses: the one already recorded in it, or — for a file being
 * created — the best this runtime can actually build.
 *
 * The recorded value wins over the probe, always. A runtime that gained
 * `contentless_delete` since the file was written must still speak the delete protocol the
 * existing rows are in; re-probing on every open would switch protocols under live data.
 *
 * The probe itself is an attempt, not a version comparison. `sqlite_version()` would have
 * to be parsed and trusted, and a build with the option compiled out would pass that test
 * and fail the DDL — an all-clear indistinguishable from "I could not look".
 */
function resolveFtsStorage(db: Database, forced?: FtsStorage): FtsStorage {
  if (forced) return forced;
  const recorded = readRecordedFtsStorage(db);
  if (recorded) return recorded;
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts_probe USING fts5(x, content='', contentless_delete=1)");
    db.exec('DROP TABLE temp.fts_probe');
    return 'contentless';
  } catch {
    return 'external';
  }
}

function readRecordedFtsStorage(db: Database): FtsStorage | undefined {
  try {
    const row = db.prepare("SELECT value FROM ledger_meta WHERE key = 'ftsStorage'").get() as
      | { value: string }
      | undefined;
    return row?.value === 'contentless' || row?.value === 'external' ? row.value : undefined;
  } catch {
    // No `ledger_meta` yet: this file is being created, and the probe below decides.
    return undefined;
  }
}

/**
 * The fingerprint a re-derived snippet is verified against, and a slab's `content_hash`.
 *
 * Over the text, never over the compressed bytes: gzip output is not stable across
 * implementations or levels, so a hash of the bytes would change with the compressor and
 * invalidate every passage in the file for no reason anyone could see.
 */
function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

function toEntryRow(r: any): EntryRow {
  return {
    eid: r.eid,
    lib: r.lib,
    itemKey: r.item_key,
    attachmentKey: r.attachment_key ?? null,
    ordinal: r.ordinal,
    heading: r.heading ?? null,
    path: r.path ?? null,
    kind: r.kind,
    charStart: r.char_start,
    charEnd: r.char_end,
    pageEst: r.page_est ?? null,
    pageEstKind: r.page_est_kind ?? null,
  };
}

function toLibraryRow(r: any): LibraryRow {
  return {
    lib: r.lib,
    oid: r.oid,
    kind: r.kind,
    remoteId: r.remote_id,
    scope: r.scope,
    itemWatermark: r.item_watermark,
    fulltextWatermark: r.fulltext_watermark ?? null,
  };
}

function toWorkOrderRow(r: any): WorkOrderRow {
  return {
    wid: r.wid,
    lib: r.lib,
    class: r.class,
    op: r.op,
    itemKey: r.item_key ?? null,
    attachmentKey: r.attachment_key ?? null,
    band: r.band,
    lane: r.lane,
    dateAdded: r.date_added ?? null,
    status: r.status,
    signal: r.signal ?? null,
    claimedBy: r.claimed_by ?? null,
    claimedInput: r.claimed_input ?? null,
    claimExpiresAt: r.claim_expires_at ?? null,
    enqueuedAt: r.enqueued_at,
  };
}
