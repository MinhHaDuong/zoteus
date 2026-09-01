import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
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
 * Bumped only when the DDL below changes shape. Nothing migrates yet; there is no field.
 *
 * 2: tranche 3 added the extract shim's bookkeeping — `extract_state` and
 * `attachment_choice`. Both are the conductor's, per the write line §5.2.4 draws through
 * the shim: all of the shim's bookkeeping is writing, and the worker writes nothing.
 */
export const LEDGER_SCHEMA_VERSION = 2;

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

/**
 * One acquisition of one row, as `claim` granted it.
 *
 * Held by whoever took the row and handed back to complete it. It is a value rather than a
 * handle so it can cross the extract shim's pipe unchanged (§5.2.4) — four fields, all of
 * them already in the row.
 */
export interface ClaimTicket {
  wid: number;
  holder: string;
  claimedInput: string;
  /** The expiry this acquisition was granted, which is what distinguishes it from the next. */
  expiresAt: number;
}

/**
 * The completion guard: this row, still claimed, by this holder, on this acquisition.
 *
 * `claimed_input` is matched NULL-safely (`IS`) because a row may be claimed against no
 * input at all, and `= NULL` would then match nothing and reject every legitimate
 * completion — a guard that rejects everything is as wrong as one that rejects nothing.
 */
const CLAIM_HELD = `wid = :wid
            AND status = 'claimed'
            AND claimed_by = :holder
            AND claimed_input IS :input
            AND claim_expires_at = :expires`;

function claimBindings(claim: ClaimTicket): {
  wid: number;
  holder: string;
  input: string;
  expires: number;
} {
  return { wid: claim.wid, holder: claim.holder, input: claim.claimedInput, expires: claim.expiresAt };
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

/** What the extract stage learned about one document, beyond its text. */
export interface ExtractStateInput {
  attachmentKey: string;
  itemKey?: string | null;
  /** The extract key of §5.2.1, over the streamed bytes. Null when there was no text. */
  textHash?: string | null;
  /** The tool identity the key's other half is made of. */
  extractor: string;
  chars: number;
  indexedPages?: number | null;
  totalPages?: number | null;
  truncated: boolean;
  empty: boolean;
}

export interface ExtractStateRow extends Omit<ExtractStateInput, 'itemKey' | 'textHash'> {
  lib: number;
  itemKey: string | null;
  textHash: string | null;
  indexedPages: number | null;
  totalPages: number | null;
  extractedAt: number;
}

/**
 * The two reasons §5.2.3 names, plus the one it cannot name yet.
 *
 * `identical-text` and `different-text` are the SPEC's own vocabulary, and both need the
 * *skipped* attachment's `text_hash` to be honest — which exists only when that attachment
 * was extracted under an earlier choice, the case D6 explicitly contemplates ("if a later
 * extraction gives an earlier attachment text, the choice function's output changes").
 * `not-first-with-text` is what the stage records when it has never read the skipped
 * attachment, and it is the honest statement then: we did not index it, and we are not
 * claiming its text differs from something we never fetched. Claiming otherwise would put a
 * measurement in the ledger that nothing measured.
 */
export type SkipReason = 'identical-text' | 'different-text' | 'not-first-with-text';

export interface AttachmentDecision {
  attachmentKey: string;
  chosen: boolean;
  reason?: SkipReason;
}

export interface AttachmentChoiceRow {
  lib: number;
  attachmentKey: string;
  itemKey: string;
  chosen: boolean;
  reason: SkipReason | null;
  decidedAt: number;
}

/** One candidate for D6, in the order the choice function reads them. */
export interface AttachmentWithText {
  attachmentKey: string;
  dateAdded: string | null;
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
  private readonly clock: Clock;

  private constructor(db: Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  static open(path: string, clock: Clock = systemClock): Ledger {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    const ledger = new Ledger(db, clock);
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

      -- The extract stage's own row per attachment: its key, its tool identity, and what
      -- the fetch learned about the document beyond its text (§5.2.4's per-attachment
      -- truncation flags and extractor-version staleness).
      --
      -- \`text_hash\` is the extract key of §5.2.1, computed over the stream as it passed, so
      -- this table identifies a document without ever having held one. \`extractor\` is the
      -- other half of that key: work is stale exactly when the stored pair differs from the
      -- current one, which is what makes a shim replacement a labeled re-extraction rather
      -- than a silent one.
      CREATE TABLE IF NOT EXISTS extract_state (
        lib            INTEGER NOT NULL REFERENCES libraries(lib),
        attachment_key TEXT NOT NULL,
        item_key       TEXT,
        text_hash      TEXT,
        extractor      TEXT NOT NULL,
        chars          INTEGER NOT NULL DEFAULT 0,
        indexed_pages  INTEGER,
        total_pages    INTEGER,
        -- Zotero indexed fewer pages than the document has: the text is faithful and
        -- partial. Stored because a partial extraction counted as complete is exactly how
        -- coverage overstates itself.
        truncated      INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        empty          INTEGER NOT NULL DEFAULT 0 CHECK (empty IN (0, 1)),
        extracted_at   INTEGER NOT NULL,
        PRIMARY KEY (lib, attachment_key)
      );

      -- D6, first-with-text (§5.2.3): per item, exactly one attachment carries the body
      -- text, and every other one gets a stored reason. The reason is the whole value of
      -- the table — a suppressed attachment that leaves no trace is indistinguishable from
      -- one nobody looked at — and it is honesty rather than a reopening of the decision.
      CREATE TABLE IF NOT EXISTS attachment_choice (
        lib            INTEGER NOT NULL REFERENCES libraries(lib),
        attachment_key TEXT NOT NULL,
        item_key       TEXT NOT NULL,
        chosen         INTEGER NOT NULL DEFAULT 0 CHECK (chosen IN (0, 1)),
        reason         TEXT,
        decided_at     INTEGER NOT NULL,
        PRIMARY KEY (lib, attachment_key),
        -- The chosen attachment carries no reason and a skipped one always does. Without
        -- this the "not indexed, no reason recorded" row is representable, which is the
        -- state D6 exists to forbid.
        CHECK ((chosen = 1) = (reason IS NULL))
      );

      CREATE INDEX IF NOT EXISTS attachment_choice_item ON attachment_choice(lib, item_key, chosen);

      -- One row per named lease. Tranche 1 owes tranche 2 a table the election statement
      -- of §5.2.5 is valid against; the election itself is not here.
      CREATE TABLE IF NOT EXISTS leases (
        name       TEXT PRIMARY KEY,
        holder     TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.db
      .prepare('INSERT OR REPLACE INTO ledger_meta(key, value) VALUES (?, ?)')
      .run('schemaVersion', String(LEDGER_SCHEMA_VERSION));
    // The row must exist for the election UPDATE to have anything to take: an election
    // written as an UPDATE cannot create its own row, and an INSERT-or-UPDATE election is
    // a different (and racier) statement than the one the spec ratified.
    this.db.prepare("INSERT OR IGNORE INTO leases(name, holder, expires_at) VALUES ('conductor', NULL, 0)").run();
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
    return this.claimTicket(wid, holder, claimedInput, ttlMs) !== null;
  }

  /**
   * The same acquisition, handing back the ticket that names *this* claim.
   *
   * A holder is not an identity: one conductor spawns one worker at a time under the same
   * holder string, so a row this holder claimed, lost to expiry, and claimed again is two
   * different claims with the same name. `claim_expires_at` is what separates them — every
   * acquisition writes a fresh one from a monotonic clock — so the ticket is the triple, and
   * carrying it is what lets `markDone`/`markFailed` refuse a completion from the earlier
   * claim (§5.2.5's duplicated micro-batch is redone and discarded, never written twice).
   */
  claimTicket(wid: number, holder: string, claimedInput: string, ttlMs: number): ClaimTicket | null {
    const now = this.clock.now();
    const expiresAt = now + ttlMs;
    const res = this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'claimed', claimed_by = :holder, claimed_input = :input, claim_expires_at = :expires
          WHERE wid = :wid
            AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= :now))`,
      )
      .run({ wid, holder, input: claimedInput, expires: expiresAt, now });
    return Number(res.changes) === 1 ? { wid, holder, claimedInput, expiresAt } : null;
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

  /**
   * Complete a row you hold. False when the claim has moved on and nothing was written.
   *
   * The guard is the other half of `claim`'s compare-and-swap, and it exists because
   * expiry is the recovery mechanism §5.2.5 chose: `releaseExpiredClaims` returns a row a
   * worker is merely *slow* on, another worker takes it and finishes, and the first
   * worker's own late completion then arrives against a row it no longer owns. Unguarded
   * — `WHERE wid = ?` — that write lands, last-write-wins, over a fresher result and with
   * no error anywhere. The accepted cost in §5.2.5 is one duplicated micro-batch, redone
   * and discarded; silent unbounded staleness is not the same thing.
   *
   * A caller that gets `false` has done work nobody wanted: the row is another holder's
   * now, and the right response is to discard the result, not to retry.
   */
  markDone(claim: ClaimTicket): boolean {
    const res = this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'done', claimed_by = NULL, claimed_input = NULL, claim_expires_at = NULL
          WHERE ${CLAIM_HELD}`,
      )
      .run(claimBindings(claim));
    return Number(res.changes) === 1;
  }

  /** As `markDone`, for the failing outcome. False when the claim has moved on. */
  markFailed(claim: ClaimTicket, note?: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE stage_queue
            SET status = 'failed', claimed_by = NULL, claimed_input = NULL, claim_expires_at = NULL,
                note = :note
          WHERE ${CLAIM_HELD}`,
      )
      .run({ ...claimBindings(claim), note: note ?? null });
    return Number(res.changes) === 1;
  }

  // --------------------------------------------------------- extract dispatch

  /**
   * The next document to fetch, in the order §5.2.3 states — and never one whose item still
   * owes upper-class work.
   *
   * **The class order is this query, not a scheduler.** `class_rank` is a stored generated
   * column carried by `stage_queue_priority`, so "metadata, then notes and annotations,
   * then body text, newest first inside each" is an indexed ORDER BY that costs nothing to
   * respect.
   *
   * The `NOT EXISTS` is the per-item half, and it is the half a global ORDER BY cannot
   * give. What §5.2.3 promises is checkable at any instant *per item*: no item's body text
   * is indexed before its record. A worker that merely took the highest-priority row would
   * satisfy a global order and still fetch item B's PDF while item B's own record sat
   * pending behind item A's — the promise is about the item, so the query is too. The
   * reading that record coverage is a strict newest-first *prefix* is a different claim,
   * and it was vetoed on 2026-08-29 (§5.2.3); this asserts neither more nor less than the
   * per-item order.
   *
   * A claimed upper-class row counts as owed. It is being worked on, not done, and the
   * ordering is about what is durable rather than about what is in flight.
   */
  nextExtractOrder(opts: { lib?: number; lane?: WorkLane } = {}): WorkOrderRow | undefined {
    const row = this.db.prepare(extractDispatchSql(opts.lib !== undefined, opts.lane !== undefined)).get({
      ...(opts.lib !== undefined ? { lib: opts.lib } : {}),
      ...(opts.lane !== undefined ? { lane: opts.lane } : {}),
    }) as any;
    return row ? toWorkOrderRow(row) : undefined;
  }

  // ---------------------------------------------------------- extract records

  putExtractState(lib: number, state: ExtractStateInput): void {
    this.db
      .prepare(
        `INSERT INTO extract_state(lib, attachment_key, item_key, text_hash, extractor, chars,
                                   indexed_pages, total_pages, truncated, empty, extracted_at)
           VALUES (:lib, :key, :itemKey, :hash, :extractor, :chars, :indexed, :total, :truncated, :empty, :at)
           ON CONFLICT(lib, attachment_key) DO UPDATE
             SET item_key = excluded.item_key,
                 text_hash = excluded.text_hash,
                 extractor = excluded.extractor,
                 chars = excluded.chars,
                 indexed_pages = excluded.indexed_pages,
                 total_pages = excluded.total_pages,
                 truncated = excluded.truncated,
                 empty = excluded.empty,
                 extracted_at = excluded.extracted_at`,
      )
      .run({
        lib,
        key: state.attachmentKey,
        itemKey: state.itemKey ?? null,
        hash: state.textHash ?? null,
        extractor: state.extractor,
        chars: state.chars,
        indexed: state.indexedPages ?? null,
        total: state.totalPages ?? null,
        truncated: state.truncated ? 1 : 0,
        empty: state.empty ? 1 : 0,
        at: this.clock.now(),
      });
  }

  extractState(lib: number, attachmentKey: string): ExtractStateRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM extract_state WHERE lib = ? AND attachment_key = ?')
      .get(lib, attachmentKey) as any;
    return r ? toExtractStateRow(r) : undefined;
  }

  /**
   * Attachments whose stored text was produced by a different shim than the current one.
   *
   * Staleness is a comparison, never a date: the extract key is `(text_hash, extractor)`,
   * so a row is stale exactly when its tool identity differs — which is also why a shim
   * that changed nothing observable can decline to bump `EXTRACTOR_ID` and cost no
   * re-extraction at all.
   */
  staleExtracts(lib: number, extractor: string): ExtractStateRow[] {
    const rows = this.db
      .prepare('SELECT * FROM extract_state WHERE lib = ? AND extractor <> ? ORDER BY attachment_key')
      .all(lib, extractor) as any[];
    return rows.map(toExtractStateRow);
  }

  // ------------------------------------------------------- first-with-text (D6)

  /** Record the choice for one item: one chosen attachment, every other one with a reason. */
  putAttachmentChoice(lib: number, itemKey: string, decisions: AttachmentDecision[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO attachment_choice(lib, attachment_key, item_key, chosen, reason, decided_at)
         VALUES (:lib, :key, :itemKey, :chosen, :reason, :at)
         ON CONFLICT(lib, attachment_key) DO UPDATE
           SET item_key = excluded.item_key,
               chosen = excluded.chosen,
               reason = excluded.reason,
               decided_at = excluded.decided_at`,
    );
    const at = this.clock.now();
    for (const d of decisions) {
      stmt.run({
        lib,
        key: d.attachmentKey,
        itemKey,
        chosen: d.chosen ? 1 : 0,
        reason: d.chosen ? null : (d.reason ?? null),
        at,
      });
    }
  }

  attachmentChoices(lib: number, itemKey: string): AttachmentChoiceRow[] {
    const rows = this.db
      .prepare('SELECT * FROM attachment_choice WHERE lib = ? AND item_key = ? ORDER BY attachment_key')
      .all(lib, itemKey) as any[];
    return rows.map(toAttachmentChoiceRow);
  }

  attachmentChoice(lib: number, attachmentKey: string): AttachmentChoiceRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM attachment_choice WHERE lib = ? AND attachment_key = ?')
      .get(lib, attachmentKey) as any;
    return r ? toAttachmentChoiceRow(r) : undefined;
  }

  /**
   * Every attachment of one item that the full-text census says has text, with the sort key
   * D6 chooses on. Ascending `dateAdded`, attachment key as the tie-break, both applied in
   * SQL so the choice function has nothing to decide about ordering.
   *
   * A NULL `date_added` sorts last rather than first: the census learned of the attachment
   * before the delta read filled its detail in, and treating "unknown" as "oldest" would
   * hand the body text to whichever attachment happened to be least known about.
   */
  attachmentsWithText(lib: number, itemKey: string): AttachmentWithText[] {
    const rows = this.db
      .prepare(
        `SELECT c.attachment_key AS attachment_key, i.date_added AS date_added
           FROM fulltext_census c
           JOIN item_census i ON i.lib = c.lib AND i.item_key = c.attachment_key
          WHERE c.lib = :lib AND i.parent_item = :itemKey
          ORDER BY (i.date_added IS NULL) ASC, i.date_added ASC, c.attachment_key ASC`,
      )
      .all({ lib, itemKey }) as any[];
    return rows.map((r) => ({ attachmentKey: r.attachment_key, dateAdded: r.date_added ?? null }));
  }

  // ------------------------------------------------------------------ leases

  lease(name: string): LeaseRow | undefined {
    const r = this.db.prepare('SELECT name, holder, expires_at FROM leases WHERE name = ?').get(name) as
      | { name: string; holder: string | null; expires_at: number }
      | undefined;
    return r ? { name: r.name, holder: r.holder, expiresAt: r.expires_at } : undefined;
  }
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

/**
 * The dispatch query, built per filter shape rather than written once with
 * `(:lib IS NULL OR lib = :lib)`.
 *
 * That idiom reads well and costs the index. SQLite cannot know at plan time that the
 * parameter is non-null, so it will not use `lib` as an index prefix and falls back to
 * scanning `status`; measured in review, ~2,0 ms per call at 2 000 rows against ~24,5 ms at
 * 20 000, which is the shape of a scan rather than a seek. This is called once per document
 * on a library whose backfill is the largest queue the system ever holds.
 *
 * Four statements, all prepared and cached by `DatabaseSync`, is the whole cost of the fix.
 */
function extractDispatchSql(byLib: boolean, byLane: boolean): string {
  return `SELECT q.* FROM stage_queue q
            WHERE q.status = 'pending'
              AND q.class = 'body'
              AND q.op = 'index'
              AND q.attachment_key IS NOT NULL
              ${byLib ? 'AND q.lib = :lib' : ''}
              ${byLane ? 'AND q.lane = :lane' : ''}
              AND NOT EXISTS (
                SELECT 1 FROM stage_queue p
                  WHERE p.lib = q.lib
                    AND p.item_key IS NOT NULL
                    AND p.item_key = q.item_key
                    AND p.class_rank < q.class_rank
                    AND p.status IN ('pending', 'claimed'))
            ORDER BY q.class_rank ASC, q.band ASC, q.date_added DESC, q.wid ASC
            LIMIT 1`;
}

function toExtractStateRow(r: any): ExtractStateRow {
  return {
    lib: r.lib,
    attachmentKey: r.attachment_key,
    itemKey: r.item_key ?? null,
    textHash: r.text_hash ?? null,
    extractor: r.extractor,
    chars: r.chars,
    indexedPages: r.indexed_pages ?? null,
    totalPages: r.total_pages ?? null,
    truncated: r.truncated === 1,
    empty: r.empty === 1,
    extractedAt: r.extracted_at,
  };
}

function toAttachmentChoiceRow(r: any): AttachmentChoiceRow {
  return {
    lib: r.lib,
    attachmentKey: r.attachment_key,
    itemKey: r.item_key,
    chosen: r.chosen === 1,
    reason: (r.reason ?? null) as SkipReason | null,
    decidedAt: r.decided_at,
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
