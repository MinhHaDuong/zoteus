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

/** Bumped only when the DDL below changes shape. Nothing migrates yet; there is no field. */
export const LEDGER_SCHEMA_VERSION = 1;

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
