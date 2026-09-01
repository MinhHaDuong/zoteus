import { randomUUID } from 'node:crypto';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Ledger } from './ledger.js';

/**
 * The lease: who is allowed to write, and the one statement that decides it.
 *
 * SPEC.md §5.2.5 elects exactly one conductor out of N × P0 through a row, not a file:
 *
 *     UPDATE leases SET holder=:uuid, expires_at=…
 *     WHERE name='conductor' AND (holder=:uuid OR expires_at < :now)
 *
 * Three properties of that statement are load-bearing, and each rules an alternative out.
 *
 * **It is one statement, so acquisition and renewal are the same act.** A holder matches
 * the first disjunct and extends itself; a stranger matches the second only once the
 * lease has run out. Nothing reads the row first and then writes it: a read-then-write
 * lets two candidates both read "expired" and both write "mine", which is the race the
 * whole design exists to prevent.
 *
 * **The holder is a UUID, not a pid.** Pids are recycled. A stale row naming pid 4711
 * cannot be told apart from a live one once the operating system has handed 4711 to
 * something else, so a pid-keyed lease is a lease that can be stolen by an unrelated
 * process starting up. A UUID is never reissued.
 *
 * **Expiry is in the row, so death needs no cleanup.** A lockfile was rejected for the
 * property that makes it appealing: it goes stale exactly when its holder dies, which is
 * the case it was bought for. Here a dead holder simply stops renewing and its row falls
 * out of the future.
 *
 * The timing constants below are the spec's, and they satisfy the R13 soak gate's
 * `lease migration < 30 s` by arithmetic rather than by measurement — see
 * `LEASE_MIGRATION_BOUND_MS`.
 */

/** §5.2.5: the renewal beat. Half the TTL, so one lost renewal is survivable. */
export const HEARTBEAT_MS = 10_000;

/** §5.2.5: TTL = 2 × heartbeat. Two renewals must be missed before the row is takeable. */
export const LEASE_TTL_MS = 2 * HEARTBEAT_MS;

/** §5.2.5: every server checks the election on this cadence, holder or not. */
export const ELECTION_CADENCE_MS = 10_000;

/**
 * The worst-case handover, and the reason the constants "satisfy their own gate".
 *
 * Let a holder renew at r and die immediately after. Its row expires at r + TTL. A rival
 * checking on the cadence can have just checked at r + TTL — where `expires_at < :now` is
 * still false — so its next check is at r + TTL + cadence, and that one takes the row.
 * The handover therefore completes at r + 30 s at the latest, and since death happened
 * strictly after r, the time *from the death* is strictly under 30 s: R13's
 * `lease migration < 30 s` holds with no measurement, on every machine.
 */
export const LEASE_MIGRATION_BOUND_MS = LEASE_TTL_MS + ELECTION_CADENCE_MS;

/** The one lease this tranche elects. The table is keyed by name so others can follow. */
export const CONDUCTOR_LEASE = 'conductor';

export interface LeaseOptions {
  ledger: Ledger;
  /** Defaults to the conductor lease; named so a second lease needs no new class. */
  name?: string;
  /** This process's identity. Generated when absent — a caller supplies one only in tests. */
  holder?: string;
  clock?: Clock;
  ttlMs?: number;
}

export interface CommitResult<T> {
  /** False means this holder was deposed: the write did not happen and nothing changed. */
  committed: boolean;
  value?: T;
}

/** Rolls the guarded transaction back without becoming an error the caller has to catch. */
class Deposed extends Error {
  constructor() {
    super('lease lost');
  }
}

export class Lease {
  readonly name: string;
  /** This process's identity in the row. A UUID, generated once, never recycled. */
  readonly holder: string;
  readonly ttlMs: number;
  private readonly ledger: Ledger;
  private readonly clock: Clock;

  constructor(opts: LeaseOptions) {
    this.ledger = opts.ledger;
    this.name = opts.name ?? CONDUCTOR_LEASE;
    this.holder = opts.holder ?? randomUUID();
    this.clock = opts.clock ?? systemClock;
    this.ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  }

  /**
   * The statement §5.2.5 quotes, run once. True means this process holds the lease.
   *
   * Acquisition and renewal are deliberately indistinguishable here. A conductor that
   * calls this every heartbeat renews; a follower that calls it every cadence acquires
   * the moment the holder's row expires; and neither needs to know which it did.
   */
  take(): boolean {
    const now = this.clock.now();
    const res = this.ledger.db
      .prepare(
        `UPDATE leases SET holder = :uuid, expires_at = :expires
           WHERE name = :name AND (holder = :uuid OR expires_at < :now)`,
      )
      .run({ uuid: this.holder, expires: now + this.ttlMs, now, name: this.name });
    return Number(res.changes) === 1;
  }

  /**
   * §5.2.5: "Lease renewal stays on a timer decoupled from stage progress, renewed
   * immediately before any long unit of work."
   *
   * The same statement, at a second call site, and the second call site is the point. A
   * renewal that rode stage progress would stop when a stage got slow — which is when the
   * lease matters most — and a conductor about to spend a long time inside one unit of
   * work would be deposed for being busy rather than for being dead. The name is the
   * documentation: a reader who sees `take()` before a long stage cannot tell whether the
   * decoupling was intended.
   */
  renewBeforeLongWork(): boolean {
    return this.take();
  }

  /**
   * The CAS commit guard of §5.2.5, on its own: one conditional UPDATE, never a read.
   *
   * "Safety never depends on the singleton: during a handover two P0s can each believe
   * they are conductor, so every record commit carries the guard **in the same
   * transaction as the write**." This is that guard's own statement, exposed because a
   * later tranche's record commit inlines exactly this condition into its own UPDATE
   * (`… WHERE holder = :uuid AND key = :computed_key`) rather than calling out to it.
   * Callers with nothing of their own to update use `commit` below.
   *
   * `SET holder = :uuid` writes the value that is already there. The write is not the
   * point — the condition evaluated under the transaction's write lock is — and rewriting
   * the identity keeps the statement the same shape as the acquisition above.
   *
   * **`expires_at` is deliberately not in the condition**, and the spec's clause has no
   * expiry term either. A holder whose row has run out but whom nobody has replaced is
   * still the only writer, because SQLite serializes: a successor's acquisition and this
   * commit cannot interleave, so whichever lands first is seen whole by the other. Adding
   * an expiry term would throw away completed work whenever a garbage collection pause
   * outran the TTL, and would buy no safety at all.
   */
  guard(): boolean {
    const res = this.ledger.db
      .prepare('UPDATE leases SET holder = :uuid WHERE name = :name AND holder = :uuid')
      .run({ uuid: this.holder, name: this.name });
    return Number(res.changes) === 1;
  }

  /**
   * Run `write` under the guard, in one transaction, or not at all.
   *
   * The transaction is what makes this the CAS idiom rather than a check-then-write: the
   * guard's condition and the caller's write commit together or roll back together, so a
   * deposed-but-running conductor cannot pass the check and then write into the state its
   * successor has since taken over. `BEGIN IMMEDIATE` (the ledger's transaction) takes
   * the write lock before the condition is evaluated, so the loser reads the winner's
   * committed row and changes nothing.
   */
  commit<T>(write: () => T): CommitResult<T> {
    try {
      const value = this.ledger.transaction(() => {
        if (!this.guard()) throw new Deposed();
        return write();
      });
      return { committed: true, value };
    } catch (e) {
      if (e instanceof Deposed) return { committed: false };
      throw e;
    }
  }

  /**
   * Give the row up, conditionally.
   *
   * The condition is not politeness: a shutting-down conductor that had already been
   * deposed would otherwise blank its successor's claim on the way out, handing the
   * cluster a free-for-all at exactly the moment one process is known to be leaving.
   * Expiry is set to 0 rather than to `now` so the successor's `expires_at < :now` is
   * true whatever clock skew exists between the two machines' views of the row.
   */
  release(): boolean {
    const res = this.ledger.db
      .prepare('UPDATE leases SET holder = NULL, expires_at = 0 WHERE name = :name AND holder = :uuid')
      .run({ uuid: this.holder, name: this.name });
    return Number(res.changes) === 1;
  }

  /** Who the row says holds it, right now. A read: never use it to decide a write. */
  holderNow(): string | null {
    return this.ledger.lease(this.name)?.holder ?? null;
  }

  expiresAt(): number {
    return this.ledger.lease(this.name)?.expiresAt ?? 0;
  }

  /**
   * Whether the row currently names this process, unexpired.
   *
   * A read, and reads are for reporting and for the worker's own orphan poll — never for
   * gating a write. `guard()` and `commit()` are what gate writes, precisely because this
   * answer is stale the instant it is returned.
   */
  heldByMe(): boolean {
    const row = this.ledger.lease(this.name);
    return row?.holder === this.holder && row.expiresAt > this.clock.now();
  }
}
