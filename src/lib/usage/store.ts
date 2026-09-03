/**
 * The usage log: one SQLite file, two tables, and a promise that neither can hurt a call.
 *
 * Modelled on the search index's store (src/features/search/sqlite-index.ts) because that
 * one has already been through the failure modes: the busy timeout goes on before anything
 * takes a lock, WAL is set but never insisted on, and a file SQLite calls malformed is
 * moved aside rather than deleted or retried forever. What is different here is the stakes.
 * The search index is a derived cache, so losing it costs a rebuild; this file is the only
 * copy of its history, so a corrupt one is sidelined under a dated name for salvage instead
 * of being unlinked, and a store that cannot open at all degrades to recording nothing
 * rather than taking the server down. Usage data is worth having and worth nothing next to
 * answering the call.
 *
 * `node:sqlite` is required through createRequire and this module is only ever reached by
 * the dynamic import in ./index.ts, after that module has confirmed the runtime has it.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
// store-faults.ts is deliberately dependency-free (see its header), so importing it here
// buys SQLite's corruption vocabulary without pulling the search index into the logger.
import { isCorruptionError } from '../../features/search/store-faults.js';
import type { Logger } from '../logger.js';
import type { UsageEvent, UsageRecorder } from './event.js';
import { aggregate, dayOf, type AggregableEvent, type DailyRow } from './rollup.js';

const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');

type Database = InstanceType<typeof DatabaseSync>;

/** Bumped when the shape below changes; an unknown stamp sidelines the file. */
export const USAGE_SCHEMA_VERSION = 1;

/** Wait rather than fail when another connection holds the write lock. */
const BUSY_TIMEOUT_MS = 10_000;

export interface UsageStoreOptions {
  /** Absolute path of the database. `:memory:` for tests. */
  path: string;
  logger?: Logger;
  /** Days of raw events to keep. Rollups are never pruned. */
  retentionDays?: number;
  /** Hard ceiling on raw rows, as a guard against a traffic spike, not a retention policy. */
  maxRows?: number;
  /** Buffered events that trigger a flush. */
  flushEvery?: number;
}

const DEFAULTS = { retentionDays: 30, maxRows: 500_000, flushEvery: 64 };

const DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    user_id INTEGER,
    client_id TEXT,
    session_id TEXT,
    ok INTEGER NOT NULL,
    error_kind TEXT,
    ms INTEGER NOT NULL,
    status INTEGER,
    bytes INTEGER,
    shape TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
  CREATE TABLE IF NOT EXISTS daily (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    user_id INTEGER,
    calls INTEGER NOT NULL,
    errors INTEGER NOT NULL,
    ms_sum INTEGER NOT NULL,
    ms_p50 INTEGER NOT NULL,
    ms_p95 INTEGER NOT NULL,
    ms_max INTEGER NOT NULL,
    PRIMARY KEY (day, kind, name, user_id)
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/**
 * A usage recorder backed by SQLite.
 *
 * Writes are buffered and flushed in one transaction, which is what keeps the cost off the
 * call path: a tool call appends to an array, and the fsync happens on a timer or at
 * shutdown. The buffer is bounded by `flushEvery`, so a burst flushes early rather than
 * growing without limit.
 */
export class SqliteUsageStore implements UsageRecorder {
  private db: Database;
  private pending: UsageEvent[] = [];
  private readonly retentionDays: number;
  private readonly maxRows: number;
  private readonly flushEvery: number;
  private closed = false;

  private constructor(
    db: Database,
    private readonly opts: UsageStoreOptions,
  ) {
    this.db = db;
    this.retentionDays = opts.retentionDays ?? DEFAULTS.retentionDays;
    this.maxRows = opts.maxRows ?? DEFAULTS.maxRows;
    this.flushEvery = opts.flushEvery ?? DEFAULTS.flushEvery;
  }

  /**
   * Open (creating if needed) the usage database.
   *
   * A file this build cannot read — corrupt, or stamped by a newer schema — is renamed out
   * of the way and a fresh one opened in its place. That is the one destructive-looking act
   * in here and it is deliberately not a delete: the operator keeps the bytes and gets a
   * working log, instead of choosing between the two.
   */
  static open(opts: UsageStoreOptions): SqliteUsageStore {
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    try {
      return new SqliteUsageStore(openHandle(opts.path, opts.logger), opts);
    } catch (err) {
      if (!isCorruptionError(err) && !(err instanceof UnknownUsageSchemaError)) throw err;
      const moved = sideline(opts.path);
      opts.logger?.warn(
        `Usage log at ${opts.path} could not be read (${err instanceof Error ? err.message : String(err)}); ` +
          `moved to ${moved} and started a new one. History before now is in the moved file.`,
      );
      return new SqliteUsageStore(openHandle(opts.path, opts.logger), opts);
    }
  }

  /**
   * Buffer one event. Never throws: instrumentation that can fail a tool call is worse
   * than no instrumentation, and there is nothing a caller could usefully do about it.
   */
  record(ev: UsageEvent): void {
    if (this.closed) return;
    this.pending.push(ev);
    if (this.pending.length >= this.flushEvery) void this.flush();
  }

  /** Write the buffer in one transaction. A write fault costs the buffer, not the server. */
  async flush(): Promise<void> {
    this.writeBuffer();
  }

  /**
   * The write itself, which `node:sqlite` makes synchronous. `flush` is async only because
   * the UsageRecorder interface has to accommodate a sink that is not a local file.
   */
  private writeBuffer(): void {
    if (!this.pending.length || this.closed) return;
    const batch = this.pending;
    this.pending = [];
    try {
      const insert = this.db.prepare(
        `INSERT INTO events (ts, kind, name, user_id, client_id, session_id, ok, error_kind, ms, status, bytes, shape)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.db.exec('BEGIN');
      try {
        for (const e of batch) {
          insert.run(
            Math.trunc(e.ts),
            e.kind,
            e.name,
            e.userId ?? null,
            e.clientId ?? null,
            e.sessionId ?? null,
            e.ok ? 1 : 0,
            e.errorKind ?? null,
            Math.max(0, Math.trunc(e.ms)),
            e.status ?? null,
            e.bytes ?? null,
            e.shape ?? null,
          );
        }
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      this.opts.logger?.warn(
        `Usage log: dropped ${batch.length} buffered events — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Recompute the rollup for every day that still has raw events at or after `from`.
   *
   * Idempotent by construction: a day is recomputed from its own rows and the result
   * replaces whatever was there, so running it twice, or after a crash mid-day, cannot
   * double-count. There is deliberately no high-water mark. One was tried, and it created
   * exactly one bug: any event whose timestamp landed before the mark — a backdated row, a
   * clock that stepped back, a restore from a backup — was never rolled up at all, and
   * silently. Re-reading the retained window instead costs a scan of a table the retention
   * policy already bounds, and cannot be wrong.
   *
   * Days whose raw events have been pruned keep their rollup: they have no rows in this
   * scan, so nothing clears them.
   */
  rollup(now = Date.now(), from = 0): void {
    this.writeBuffer();
    const rows = this.db
      .prepare(
        'SELECT ts, kind, name, user_id AS userId, ok, ms FROM events WHERE ts >= ? ORDER BY ts',
      )
      .all(from) as Array<{
      ts: number;
      kind: string;
      name: string;
      userId: number | null;
      ok: number;
      ms: number;
    }>;
    const events: AggregableEvent[] = rows.map((r) => ({ ...r, ok: r.ok === 1 }));
    const aggregated = aggregate(events);
    const days = [...new Set(aggregated.map((r) => r.day))];
    const upsert = this.db.prepare(
      `INSERT INTO daily (day, kind, name, user_id, calls, errors, ms_sum, ms_p50, ms_p95, ms_max)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, kind, name, user_id) DO UPDATE SET
         calls = excluded.calls, errors = excluded.errors, ms_sum = excluded.ms_sum,
         ms_p50 = excluded.ms_p50, ms_p95 = excluded.ms_p95, ms_max = excluded.ms_max`,
    );
    const clear = this.db.prepare('DELETE FROM daily WHERE day = ?');
    this.db.exec('BEGIN');
    try {
      // Cleared then rewritten rather than upserted alone: a (day, tool, user) group whose
      // rows were pruned or never existed must disappear from the rollup, and an upsert
      // can only ever add.
      for (const day of days) clear.run(day);
      for (const r of aggregated) {
        upsert.run(
          r.day,
          r.kind,
          r.name,
          r.userId,
          r.calls,
          r.errors,
          r.msSum,
          r.msP50,
          r.msP95,
          r.msMax,
        );
      }
      this.setMeta('rolledThrough', dayOf(now));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Drop raw events past the retention window, and past the row cap.
   *
   * Rollups are never touched: they are the point of the arrangement. The cap is second
   * because retention is the policy and the cap is only there so a scanner storm or a
   * runaway client cannot fill the disk between two daily runs.
   */
  prune(now = Date.now()): { byAge: number; byCap: number } {
    const cutoff = now - this.retentionDays * 86_400_000;
    const byAge = Number(
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff).changes ?? 0,
    );
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    let byCap = 0;
    if (total > this.maxRows) {
      byCap = Number(
        this.db
          .prepare('DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT ?)')
          .run(total - this.maxRows).changes ?? 0,
      );
    }
    return { byAge, byCap };
  }

  /** Roll up, then prune. What the daily maintenance timer and startup both call. */
  maintain(now = Date.now()): void {
    try {
      // The full pass: every retained day, so a backdated or recovered row is picked up.
      this.rollup(now, 0);
      this.prune(now);
    } catch (err) {
      this.opts.logger?.warn(
        `Usage log maintenance skipped — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Rollup rows from `fromDay` (inclusive, UTC `YYYY-MM-DD`) onwards, with today's
   * partial day folded in first so a report never reads as if the day had not started.
   */
  dailyRows(fromDay?: string): DailyRow[] {
    // Only the last two days are recomputed on a read: today is still accumulating and
    // yesterday may have been open when the last full pass ran. Everything older was
    // settled by `maintain`, and re-deriving it on every request would put a scan of the
    // whole retained window on the endpoint's critical path.
    const now = Date.now();
    this.rollup(now, startOfDay(now) - 86_400_000);
    const rows = fromDay
      ? this.db.prepare(`${SELECT_DAILY} WHERE day >= ? ORDER BY day, kind, name`).all(fromDay)
      : this.db.prepare(`${SELECT_DAILY} ORDER BY day, kind, name`).all();
    return rows as unknown as DailyRow[];
  }

  /** Row counts, for tests and for the operational line the server logs at startup. */
  counts(): { events: number; daily: number } {
    return {
      events: (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      daily: (this.db.prepare('SELECT COUNT(*) AS n FROM daily').get() as { n: number }).n,
    };
  }

  /**
   * The salt used to pseudonymise user ids, created on first use and kept with the data.
   *
   * In the file rather than in the environment because the two must not be able to drift:
   * a salt that changed on redeploy would make yesterday's user a different user today,
   * and every retention number computed across that boundary would be wrong.
   */
  identitySalt(make: () => string): string {
    const existing = this.getMeta('identitySalt');
    if (existing) return existing;
    const salt = make();
    this.setMeta('identitySalt', salt);
    return salt;
  }

  /** Flush, roll the partial day up so it is not lost with the buffer, and let go. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.writeBuffer();
    try {
      this.rollup(Date.now(), 0);
    } catch {
      // A rollup that fails on the way out is not worth a message: the raw events are
      // committed, and the next startup rolls them up.
    }
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closed, or closing on a broken handle. Nothing left to protect.
    }
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}

/** Midnight UTC of the day containing `ts`. */
function startOfDay(ts: number): number {
  return Date.parse(`${dayOf(ts)}T00:00:00Z`);
}

const SELECT_DAILY = `SELECT day, kind, name, user_id AS userId, calls, errors,
  ms_sum AS msSum, ms_p50 AS msP50, ms_p95 AS msP95, ms_max AS msMax FROM daily`;

/** A usage database written by a build whose schema this one does not know. */
class UnknownUsageSchemaError extends Error {
  constructor(found: number) {
    super(`usage log schema v${found} is newer than this build's v${USAGE_SCHEMA_VERSION}`);
    this.name = 'UnknownUsageSchemaError';
  }
}

function openHandle(path: string, logger?: Logger): Database {
  const db = new DatabaseSync(path);
  // Before anything that takes a lock, so every statement below inherits the wait.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch (err) {
    if (isCorruptionError(err)) throw err;
    logger?.debug(`Could not set journal_mode=WAL on ${path}: ${String(err)}`);
  }
  // NORMAL rather than FULL: a power cut can cost the last few events, which is the right
  // trade for a log that must not add an fsync to a tool call.
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
    | { value?: string }
    | undefined;
  const found = row?.value === undefined ? undefined : Number(row.value);
  if (found !== undefined && found > USAGE_SCHEMA_VERSION) {
    db.close();
    throw new UnknownUsageSchemaError(found);
  }
  if (found === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'schemaVersion',
      String(USAGE_SCHEMA_VERSION),
    );
  }
  return db;
}

/** Move an unreadable database and its write-ahead sidecars aside, and say where they went. */
function sideline(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${path}.corrupt-${stamp}`;
  for (const [from, to] of [
    [path, target],
    [`${path}-wal`, `${target}-wal`],
    [`${path}-shm`, `${target}-shm`],
  ]) {
    if (existsSync(from!)) {
      try {
        renameSync(from!, to!);
      } catch {
        // Best effort: a sideline that cannot rename leaves the caller to open over the
        // file, which is the same outcome the rename was buying more politely.
      }
    }
  }
  return target;
}
