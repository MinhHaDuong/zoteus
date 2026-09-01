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
 *
 * **A follower writes nothing at all.** Not "writes nothing important": the follower path
 * below reaches no ledger statement, which is what keeps R6's query path write-free in
 * the database sense as well as the design sense.
 *
 * **Nothing here sleeps**, per `clock.ts`. `poll` is one pass and the host drives it; how
 * often it is driven changes only latency, never correctness, since every decision inside
 * is due-ness arithmetic rather than an assumption about when the last pass ran.
 */

export interface ConductorOptions {
  ledger: Ledger;
  clock?: Clock;
  /** Absent in a P0 built before the tick is wired; the election still runs. */
  tick?: ReconcileTick;
  /** This P0's one pipeline worker, when it has spawned one. Tranche 3 supplies it. */
  worker?: WorkerControl;
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
  /** Empty for a follower, and for a conductor with nothing due. */
  ticks: TickReport[];
}

export class Conductor {
  readonly election: ConductorElection;
  private readonly ledger: Ledger;
  private readonly clock: Clock;
  private readonly tick?: ReconcileTick;
  private readonly listLibraries: () => number[];
  private worker?: WorkerControl;
  /** Set by the deposition callback, read by the pass that caused it. */
  private killedThisPass?: string;

  constructor(opts: ConductorOptions) {
    this.ledger = opts.ledger;
    this.clock = opts.clock ?? systemClock;
    this.tick = opts.tick;
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
    const election = this.election.checkIfDue();
    if (!this.election.isConductor()) {
      return this.report(election);
    }
    return this.report(election, await this.runTicks());
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
      ticks,
    };
  }
}
