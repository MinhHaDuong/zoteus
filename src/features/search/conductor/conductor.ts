import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { ConductorElection } from './election.js';
import type { ElectionResult } from './election.js';
import type { Ledger } from './ledger.js';
import type { WorkerControl } from './orphan.js';
import type { ReconcileTick, TickReport } from './reconcile-tick.js';

/**
 * One P0's scheduling loop: elect, and write only if elected (SPEC.md §5.2.5).
 *
 * Every zoteus server runs one of these. Most of them will lose every election and do
 * nothing here for their whole lifetime, which is the point — the pipeline does not
 * multiply with N, and a follower's query path stays exactly what it was.
 *
 * Three orderings inside `poll` are the design rather than the implementation:
 *
 * 1. **The election runs first.** A tick decided on last cadence's standing is a tick a
 *    deposed conductor runs.
 * 2. **A deposition kills the worker before anything else**, so the orphan stops pinning
 *    the write-ahead log before the successor spawns its own.
 * 3. **The lease is renewed immediately before the tick**, which is the long unit of work
 *    at this tranche's disposal, and the tick does not run if that renewal fails.
 * 4. **The standing is re-read after the ticks**, because 3 is where a deposition is most
 *    often noticed and the rest of the pass — the claim sweep, the spawn — is a
 *    conductor's work. A pass that ran them on the way out would be a follower writing to
 *    the ledger and a second worker starting under the successor's lease.
 *
 * **A follower writes nothing at all.** Not "writes nothing important": the follower path
 * below reaches no ledger statement, which is what keeps R6's query path write-free in
 * the database sense as well as the design sense. This holds for a P0 deposed *during* a
 * pass and not only for one that began it as a follower: the two are the same process
 * writing under a lease it does not hold, and only the timing differs.
 *
 * **Nothing here sleeps**, per `clock.ts`. `poll` is one pass and the host drives it; how
 * often it is driven changes only latency, never correctness, since every decision inside
 * is due-ness arithmetic rather than an assumption about when the last pass ran.
 */

/**
 * The two questions a run-to-drain worker needs answered, and nothing about how.
 *
 * `hasWork` is a ledger read the conductor is already entitled to make; `spawn` is the
 * process-shaped half, which is why it is a seam rather than a call — a suite hands over an
 * in-process worker and the running server hands over a child process, and the ordering
 * under test is the same either way.
 */
export interface WorkerPipeline {
  hasWork(): boolean;
  spawn(): WorkerControl;
}

export interface ConductorOptions {
  ledger: Ledger;
  clock?: Clock;
  /** Absent in a P0 built before the tick is wired; the election still runs. */
  tick?: ReconcileTick;
  /** This P0's one pipeline worker, when it has spawned one. Tranche 3 supplies it. */
  worker?: WorkerControl;
  /**
   * How this P0 gets a worker: whether there is anything to do, and how to start one.
   *
   * Absent in a P0 built before the pipeline is wired, exactly as `tick` is. Present, it
   * makes the worker run-to-drain (§5.2.5): spawned when the ledger queues hold work, gone
   * when it has drained them, so steady state contains no pipeline worker at all.
   */
  pipeline?: WorkerPipeline;
  holder?: string;
  cadenceMs?: number;
  ttlMs?: number;
  /** Which libraries the tick sweeps. Defaults to every registered one. */
  libraries?: () => number[];
}

export interface ConductorPollReport {
  holder: string;
  role: 'conductor' | 'follower';
  /** Undefined when the cadence was not yet due and no check ran. */
  election?: ElectionResult;
  /** Set when this pass killed the worker, with the reason it gave. */
  workerKilled?: string;
  /** Whether this pass started a worker, and whether one is running now. */
  workerSpawned?: boolean;
  workerAlive: boolean;
  /** Claims this P0 has returned to the queue by expiry, cumulative over its life. */
  releasedClaims: number;
  /** Empty for a follower, and for a conductor with nothing due. */
  ticks: TickReport[];
}

export class Conductor {
  readonly election: ConductorElection;
  private readonly ledger: Ledger;
  private readonly clock: Clock;
  private readonly tick?: ReconcileTick;
  private readonly pipeline?: WorkerPipeline;
  private readonly listLibraries: () => number[];
  private worker?: WorkerControl;
  /** Set by the deposition callback, read by the pass that caused it. */
  private killedThisPass?: string;
  private spawnedThisPass?: boolean;
  /** Claims returned to the queue by the sweep, cumulative. Surfaced for the panel. */
  private released = 0;

  constructor(opts: ConductorOptions) {
    this.ledger = opts.ledger;
    this.clock = opts.clock ?? systemClock;
    this.tick = opts.tick;
    this.pipeline = opts.pipeline;
    this.worker = opts.worker;
    this.listLibraries = opts.libraries ?? ((): number[] => this.ledger.libraries().map((l) => l.lib));
    this.election = new ConductorElection({
      ledger: opts.ledger,
      clock: this.clock,
      cadenceMs: opts.cadenceMs,
      ttlMs: opts.ttlMs,
      holder: opts.holder,
      onDeposed: (reason) => this.killWorker(reason),
    });
  }

  get holder(): string {
    return this.election.holder;
  }

  isConductor(): boolean {
    return this.election.isConductor();
  }

  /** Hand over the worker this P0 spawned. Replacing a live one kills it first. */
  attachWorker(worker: WorkerControl | undefined): void {
    if (this.worker && this.worker !== worker) this.killWorker('replaced');
    this.worker = worker;
  }

  /**
   * One pass. Safe to call as often as the host likes; everything inside is due-driven.
   */
  async poll(): Promise<ConductorPollReport> {
    this.killedThisPass = undefined;
    this.spawnedThisPass = undefined;
    const election = this.election.checkIfDue();
    if (!this.election.isConductor()) {
      return this.report(election);
    }
    const ticks = await this.runTicks();
    // The standing is re-read here, not assumed from the check above. `runTicks` renews
    // immediately before every library's tick, so it is exactly where a deposition is most
    // likely to be noticed — and everything below this line is a conductor's work: the sweep
    // is a ledger write, and the spawn puts a worker under whatever lease is current. Run by
    // a P0 that has just been deposed, they are §5.2.5's single writer becoming two, and the
    // spawn undoes the kill the deposition callback has this instant performed.
    if (!this.election.isConductor()) return this.report(election, ticks);
    // Rows whose holder died mid-document come back to the queue here, and this is the only
    // place that returns them. §5.2.5 recovers a stuck worker by claim expiry at the cost of
    // at most one duplicated micro-batch — but expiry is a *timestamp*, not an event, so
    // without someone running the sweep the row simply stays `claimed` and the attachment is
    // never indexed again. A hard-killed worker would otherwise strand every row it held.
    this.released += this.ledger.releaseExpiredClaims();
    // After the tick, not before: the tick is what writes the work orders, so a spawn
    // decided on the pre-tick queue would idle through the cadence that just found
    // something to do. A worker that has drained is simply gone, and the next pass with
    // work in the queue starts another — which is what run-to-drain means.
    this.reapWorker();
    this.maybeSpawnWorker();
    return this.report(election, ticks);
  }

  /**
   * Stand down deliberately: release the row and kill the worker.
   *
   * Worth calling on shutdown, and worth nothing to correctness — a P0 that exits without
   * it is covered by expiry, which is the property the lease was chosen for. What it buys
   * is time: the successor waits one cadence instead of one TTL plus one.
   */
  standDown(): void {
    // The kill rides the election's deposition callback rather than being repeated here.
    // Two call sites racing to name the same event is how a deliberate shutdown ends up
    // reported as a lost lease: whichever fires first wins, and it is not the one that
    // knows why.
    this.election.standDown();
  }

  private async runTicks(): Promise<TickReport[]> {
    if (!this.tick) return [];
    const reports: TickReport[] = [];
    for (const lib of this.listLibraries()) {
      if (!this.tick.isDue(lib)) continue;
      // The renewal §5.2.5 puts "immediately before any long unit of work". A tick is a
      // round trip to Zotero and a full census diff; a conductor that entered one with
      // 200 ms of lease left would be deposed in the middle of it and would find out
      // afterwards, having already written.
      if (this.election.renewBeforeLongWork().deposed) break;
      reports.push(await this.tick.runOnce(lib));
    }
    return reports;
  }

  /** Drop a handle whose drain has ended, so the next pass can start a fresh one. */
  private reapWorker(): void {
    if (this.worker && !this.worker.alive()) this.worker = undefined;
  }

  private maybeSpawnWorker(): void {
    if (!this.pipeline || this.worker) return;
    if (!this.pipeline.hasWork()) return;
    // The bound is one worker per P0, and this is the only place that creates one: the
    // `this.worker` guard above is what enforces it, which is why the check and the spawn
    // are not separated by an await.
    this.worker = this.pipeline.spawn();
    this.spawnedThisPass = true;
  }

  private killWorker(reason: string): void {
    if (!this.worker) return;
    this.worker.kill(reason);
    this.killedThisPass = reason;
  }

  private report(election: ElectionResult | undefined, ticks: TickReport[] = []): ConductorPollReport {
    return {
      holder: this.holder,
      role: this.election.role,
      election,
      workerKilled: this.killedThisPass,
      ...(this.spawnedThisPass ? { workerSpawned: true } : {}),
      workerAlive: this.worker?.alive() ?? false,
      releasedClaims: this.released,
      ticks,
    };
  }
}
