import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Ledger } from './ledger.js';
import { CONDUCTOR_LEASE, HEARTBEAT_MS } from './lease.js';

/**
 * Orphan repair: three checks over two processes, because a wedged parent is not a dead
 * one (SPEC.md §5.2.5).
 *
 * The conductor owns at most one pipeline worker. An orphan — a worker whose parent is no
 * longer the conductor — writes nothing and so corrupts nothing, but it pins the
 * write-ahead log as a long-lived reader while the new conductor spawns its own, and it
 * breaks the one-worker bound that keeps the pipeline from multiplying with N.
 *
 * **Why two repairs on the worker's side.** The pipe covers a parent that *died*: the
 * kernel closes it, stdin sees EOF, the worker stands down and nothing had to be
 * scheduled. It cannot cover a parent that is merely *wedged* — SIGSTOP'd through a
 * migration, or thrashing — because a stopped process closes no pipe and runs no cleanup,
 * and its lease quietly expires while its worker waits on a stream that will never end.
 * Only a check scheduled inside the worker's own process fires then, which is why the
 * lease poll is kept rather than replaced by the pipe.
 *
 * **And why a third on the conductor's side.** The poll's grain is a micro-batch, so a
 * worker stuck deep inside one runs on. The deposed P0 is the process best placed to
 * notice, and it kills its worker before anything else. R13's soak gate exercises both
 * halves — kill -9 twice for the pipe, SIGSTOP once for the poll — and each alone leaves
 * a case the other covers.
 *
 * **Nothing here sleeps.** The poll's cadence is arithmetic on the injected clock, for
 * the reason `clock.ts` gives; the worker pumps it between micro-batches, which is the
 * grain §5.2.5 states and also the only point at which standing down is cheap.
 */

/** The little of `process.stdin` this needs, so a test can hand it an ordinary emitter. */
export interface EofSource {
  once(event: string, listener: () => void): unknown;
}

export type OrphanReason = 'pipe-closed' | 'lease-lost';

/**
 * Worker-side repair (a): the pipe.
 *
 * `end` and `close` are both watched and the first one wins. A pipe closed politely
 * raises `end` then `close`; a far side torn down rather than closed raises `close`
 * alone. Watching one of them is a repair that works in one of the two cases — which is
 * the failure mode this whole file is about — and watching both costs a boolean.
 *
 * This mirrors the server's own stdio shutdown, deliberately rather than by import: that
 * one belongs to an MCP session and flushes an index. A worker holds no store, opens no
 * write handle, and has nothing to checkpoint, so its ending is the callback and no more.
 */
export function watchParentEof(opts: { stdin?: EofSource; onParentGone: (reason: OrphanReason) => void }): void {
  const stdin = opts.stdin ?? process.stdin;
  let fired = false;
  const gone = (): void => {
    if (fired) return;
    fired = true;
    opts.onParentGone('pipe-closed');
  };
  stdin.once('end', gone);
  stdin.once('close', gone);
}

/** Read the lease row's holder. The worker is a reader like any sibling P0; it never writes. */
export function leaseHolderReader(ledger: Ledger, name: string = CONDUCTOR_LEASE): () => string | null {
  return () => ledger.lease(name)?.holder ?? null;
}

export interface OrphanGuardOptions {
  /**
   * The UUID of the P0 that spawned this worker, handed over at spawn.
   *
   * A UUID and not a pid, for the reason the lease itself uses one: a recycled pid makes
   * a stale parent indistinguishable from a live one, and this check's entire job is to
   * tell those two apart.
   */
  parent: string;
  /** How the worker sees the row. `leaseHolderReader` is the ordinary one. */
  readHolder: () => string | null;
  clock?: Clock;
  /** §5.2.5 puts the poll on the worker's own timer; the heartbeat is its natural beat. */
  cadenceMs?: number;
  /** Fired at most once, whichever repair noticed first. */
  onOrphaned: (reason: OrphanReason) => void;
}

/**
 * The worker's two repairs, composed, so a worker cannot wire one and believe it is safe.
 *
 * Composed rather than merely co-located: the callback fires at most once across both, so
 * a parent that dies while its lease has already moved on stands the worker down exactly
 * once instead of racing two shutdown paths.
 */
export class WorkerOrphanGuard {
  readonly parent: string;
  readonly cadenceMs: number;
  private readonly clock: Clock;
  private readonly readHolder: () => string | null;
  private readonly onOrphaned: (reason: OrphanReason) => void;
  private fired = false;
  private nextCheckAt = 0;

  constructor(opts: OrphanGuardOptions) {
    this.parent = opts.parent;
    this.readHolder = opts.readHolder;
    this.clock = opts.clock ?? systemClock;
    this.cadenceMs = opts.cadenceMs ?? HEARTBEAT_MS;
    this.onOrphaned = opts.onOrphaned;
  }

  /** Repair (a). Call once, at startup, before the first micro-batch. */
  watchPipe(stdin?: EofSource): void {
    watchParentEof({ stdin, onParentGone: (reason) => this.orphaned(reason) });
  }

  dueAt(): number {
    return this.nextCheckAt;
  }

  isDue(): boolean {
    return this.clock.now() >= this.nextCheckAt;
  }

  /**
   * Repair (b), run whether or not it was due. True means still parented.
   *
   * The comparison is against the *holder*, not against liveness: a parent that is alive
   * but no longer the conductor is exactly as orphaning as a dead one, since the new
   * conductor is about to spawn a worker of its own and the bound is one worker, not one
   * live parent.
   */
  checkParent(): boolean {
    this.nextCheckAt = this.clock.now() + this.cadenceMs;
    if (this.fired) return false;
    if (this.readHolder() === this.parent) return true;
    this.orphaned('lease-lost');
    return false;
  }

  /** Repair (b) on its cadence. Returns true while still parented, or nothing when not due. */
  checkParentIfDue(): boolean | undefined {
    return this.isDue() ? this.checkParent() : undefined;
  }

  /** Whether either repair has already stood this worker down. */
  get orphanedAlready(): boolean {
    return this.fired;
  }

  private orphaned(reason: OrphanReason): void {
    if (this.fired) return;
    this.fired = true;
    this.onOrphaned(reason);
  }
}

/**
 * The conductor's side of the bound: the handle a P0 holds on its one worker.
 *
 * An interface rather than an implementation because the worker process is a later
 * tranche's; what this tranche owes it is the call site — a deposed P0 kills before it
 * does anything else — and a call site with nothing behind it is still the ordering under
 * test. `kill` is idempotent by contract: deposition and shutdown can both reach it.
 */
export interface WorkerControl {
  kill(reason: string): void;
  alive(): boolean;
}
