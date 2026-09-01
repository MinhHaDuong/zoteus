import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Ledger } from './ledger.js';
import { ELECTION_CADENCE_MS, Lease, LEASE_TTL_MS } from './lease.js';

/**
 * The election check every P0 runs, holder or not (SPEC.md §5.2.5).
 *
 * There is no leader-election protocol here and there is not meant to be one: the check
 * is the lease statement, run on a cadence, and the row is the arbiter. A follower's
 * check is an attempted acquisition that fails while the holder is alive and succeeds the
 * first time it is run after the holder's row expires. That is why every server runs the
 * *same* check — a design where followers merely watch would need a second mechanism to
 * decide which watcher promotes itself, and that second mechanism is the hard part.
 *
 * **Nothing here sleeps.** Due-ness is arithmetic on the injected clock and the caller
 * pumps the loop, for the reason `clock.ts` gives: a cadence a test has to wait for is a
 * cadence no test asserts. It also makes the soak assertion exact — "another P0 takes
 * over within TTL + cadence" is a statement about *when*, and a suite that slept could
 * only say that it happened eventually.
 *
 * **Deposition is an event, not a state to be discovered later.** A P0 that observes it
 * no longer holds the lease "kills its worker before anything else", because an orphaned
 * worker pins the write-ahead log as a long-lived reader while the new conductor spawns
 * its own. So the deposition callback runs inside the check that noticed, before the
 * result is returned and therefore before any caller can act on it.
 */

export type ElectionRole = 'conductor' | 'follower';

export interface ElectionResult {
  holder: string;
  role: ElectionRole;
  /** What this process was before the check. A transition is `was !== role`. */
  was: ElectionRole;
  /** A follower that just won, or a conductor that just started. */
  acquired: boolean;
  /** A conductor that just lost. The deposition callback has already run. */
  deposed: boolean;
  at: number;
  nextCheckAt: number;
}

export interface ElectionOptions {
  ledger: Ledger;
  clock?: Clock;
  /** §5.2.5's 10 s. Every server, whether or not it holds the row. */
  cadenceMs?: number;
  ttlMs?: number;
  /** This process's UUID. Generated when absent. */
  holder?: string;
  leaseName?: string;
  /**
   * Run the instant this process stops being the holder — before the check returns. Its
   * job in the full design is to kill the pipeline worker.
   *
   * The reason is passed because the two ways of ceasing to be conductor are not the same
   * event to anything downstream: `lease lost` is a failure this process did not choose
   * and may want to log as one, while `standing down` is an orderly exit. Deriving one
   * from the other at the call site is what makes a deliberate shutdown report itself as
   * a deposition.
   */
  onDeposed?: (reason: DepositionReason, holder: string) => void;
}

export type DepositionReason = 'lease lost' | 'standing down';

export class ConductorElection {
  readonly lease: Lease;
  readonly cadenceMs: number;
  private readonly clock: Clock;
  private readonly onDeposed?: (reason: DepositionReason, holder: string) => void;
  private currentRole: ElectionRole = 'follower';
  /**
   * When the next check is owed. Zero, not `now`, so a process that has never checked is
   * owed one immediately whatever the clock's epoch: `now >= 0` is true on every timeline
   * a test can install, where `now >= now` would depend on the order of two reads.
   */
  private nextCheckAt = 0;

  constructor(opts: ElectionOptions) {
    this.clock = opts.clock ?? systemClock;
    this.cadenceMs = opts.cadenceMs ?? ELECTION_CADENCE_MS;
    this.onDeposed = opts.onDeposed;
    this.lease = new Lease({
      ledger: opts.ledger,
      name: opts.leaseName,
      holder: opts.holder,
      clock: this.clock,
      ttlMs: opts.ttlMs ?? LEASE_TTL_MS,
    });
  }

  /** This process's UUID: the value that appears in the row and in a worker's poll. */
  get holder(): string {
    return this.lease.holder;
  }

  /**
   * The standing as of the last check.
   *
   * In-memory on purpose. Asking the row would be a read whose answer is stale the
   * instant it returns, and every write is guarded by the CAS idiom anyway, so this
   * value decides scheduling — whether to run a tick — and never safety.
   */
  get role(): ElectionRole {
    return this.currentRole;
  }

  isConductor(): boolean {
    return this.currentRole === 'conductor';
  }

  dueAt(): number {
    return this.nextCheckAt;
  }

  isDue(): boolean {
    return this.clock.now() >= this.nextCheckAt;
  }

  /** One election check, whether or not it was due. Rearms the cadence. */
  check(): ElectionResult {
    return this.attempt(true);
  }

  checkIfDue(): ElectionResult | undefined {
    return this.isDue() ? this.check() : undefined;
  }

  /**
   * §5.2.5's second renewal call site: "renewed immediately before any long unit of
   * work", on top of — not instead of — the cadence.
   *
   * It deliberately leaves `nextCheckAt` alone. The periodic renewal "stays on a timer
   * decoupled from stage progress", and rearming the cadence here would recouple them:
   * a conductor running long units back to back would keep pushing its own check into
   * the future, and would stop checking exactly while it was busiest.
   *
   * It returns the same result shape as a check, transitions included, because losing the
   * lease at this call site is the interesting case: the caller is one statement away
   * from starting something long, and a deposition noticed here is a worker killed and a
   * unit of work not started.
   */
  renewBeforeLongWork(): ElectionResult {
    return this.attempt(false);
  }

  private attempt(rearmCadence: boolean): ElectionResult {
    const at = this.clock.now();
    const was = this.currentRole;
    const held = this.lease.take();
    this.currentRole = held ? 'conductor' : 'follower';
    const deposed = was === 'conductor' && !held;
    // Before anything else, per §5.2.5, and specifically before this result reaches a
    // caller that might go on to run a tick or hand work to a worker that is now an
    // orphan pinning the write-ahead log.
    if (deposed) this.onDeposed?.('lease lost', this.holder);
    if (rearmCadence) this.nextCheckAt = at + this.cadenceMs;
    return {
      holder: this.holder,
      role: this.currentRole,
      was,
      acquired: held && was === 'follower',
      deposed,
      at,
      nextCheckAt: this.nextCheckAt,
    };
  }

  /**
   * Leave the election deliberately: give the row up and stand down as a conductor would
   * on shutdown, so the successor's wait is one cadence rather than one TTL plus one.
   *
   * The deposition callback fires here too. A conductor that releases the lease has the
   * same orphaned worker as one that lost it, and a shutdown path that skipped the kill
   * would leave the process it spawned outliving it — the exact orphan the two repairs
   * exist to retire.
   */
  standDown(): boolean {
    const released = this.lease.release();
    if (this.currentRole === 'conductor') {
      this.currentRole = 'follower';
      this.onDeposed?.('standing down', this.holder);
    }
    return released;
  }
}
