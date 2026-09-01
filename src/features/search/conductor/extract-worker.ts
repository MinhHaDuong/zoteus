import type { ActivityGate } from './activity.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { DocumentSource, DocumentWindow, ExtractRead, StreamedDocument } from './document-stream.js';
import { streamFullText } from './document-stream.js';
import type { ExtractAssignment, ExtractDispatcher } from './extract-stage.js';
import type { PacerReport } from './fetch-pacer.js';
import { FetchPacer } from './fetch-pacer.js';
import type { PriorityReport } from './priority.js';
import type { WorkerControl, WorkerOrphanGuard } from './orphan.js';

/**
 * The first pipeline worker: sequential extract, run to drain, exit (SPEC.md §5.2.5).
 *
 * Spawned when the ledger queues hold work, it drains them and exits, so steady state
 * contains no pipeline worker at all. One document at a time, and that is not a
 * configuration: the failure upstream's #39 walked into was concurrency against a Zotero
 * that was also running its own sync engine and PDF indexer, and a sequential fetcher
 * cannot arrive there by that route.
 *
 * **It writes nothing.** No lease, no write handle, no file of its own. Every durable
 * consequence of a fetch — the extract row, the truncation flag, D6's choice, the work
 * order's completion — is applied by the conductor through the dispatcher, which is what
 * makes C3's killable-at-any-time clause structural rather than argued: killing this
 * process loses an in-flight document and nothing else.
 *
 * **Nothing here sleeps by itself.** The pacer and the activity gate report a number of
 * milliseconds and the injected `sleep` takes it. A running server hands over a real timer;
 * a suite hands over a function that advances the manual clock, which is how a four-hundred
 * millisecond latency ramp across thirty-four documents costs a test nothing.
 *
 * Three things end a drain, and the report names which: the queue emptied, the parent died
 * (stdin EOF), or the lease moved to another P0. The last two are `orphan.ts`'s two repairs,
 * composed there rather than re-implemented here — a wedged parent closes no pipe, and only
 * a check scheduled in this process fires then.
 */

export type DrainStop = 'drained' | 'orphaned' | 'killed';

export interface ExtractDrainReport {
  stopped: DrainStop;
  /** Which repair noticed, when `stopped` is `orphaned`; the caller's reason when `killed`. */
  orphanReason?: string;
  documents: number;
  windows: number;
  chars: number;
  emptyDocuments: number;
  failures: number;
  /**
   * Documents *this drain* read whose result the conductor then discarded, because the row
   * had moved on while the fetch was in flight — another holder, or newer work coalesced
   * into it (§5.2.5's duplicated micro-batch). Zero on a healthy drain.
   *
   * Per drain, like every other count here, which takes subtracting: the dispatcher outlives
   * the worker — that is what run-to-drain means — so its own counter is a lifetime total
   * and reporting it raw would have every later drain inherit the first one's discards.
   */
  staleCompletions: number;
  delayedFetches: number;
  totalDelayMs: number;
  activityYields: number;
  totalYieldMs: number;
  /** What the instrument panel shows about the local API's behaviour during this drain. */
  pace: PacerReport;
  /** What the OS floor came to, when this worker was asked to take one. */
  priority?: PriorityReport;
}

export interface ExtractWorkerOptions {
  dispatcher: ExtractDispatcher;
  source: DocumentSource;
  clock?: Clock;
  /** Takes a wait the pacer or the activity gate asked for. */
  sleep?: (ms: number) => Promise<void>;
  pacer?: FetchPacer;
  activity?: ActivityGate;
  guard?: WorkerOrphanGuard;
  windowChars?: number;
  /**
   * Take the OS floor, once, before the first document.
   *
   * A seam and not a call, and deliberately absent by default. `lowerWorkerPriority` renices
   * the process it runs in, and until the worker is a process of its own (the pipe is
   * tranche 4's) that process is the one answering queries — so a worker that reniced itself
   * unasked would put R6's query path on the floor to be polite to Zotero. The entry point
   * that forks the worker passes `lowerWorkerPriority` here; nothing else should.
   */
  priority?: () => PriorityReport;
}

export class ExtractWorker {
  /** Called after each document's windows have all been forwarded. */
  onDocument?: (document: StreamedDocument, seen: number) => void;
  /** Where the windows go. The conductor's segmenter, once tranche 4 exists. */
  onWindow?: (window: DocumentWindow, assignment: ExtractAssignment) => void | Promise<void>;

  private readonly dispatcher: ExtractDispatcher;
  private readonly source: DocumentSource;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pacer: FetchPacer;
  private readonly activity?: ActivityGate;
  private readonly guard?: WorkerOrphanGuard;
  private readonly windowChars?: number;
  private readonly priority?: () => PriorityReport;
  private priorityReport?: PriorityReport;
  private killedFor?: string;
  /** The dispatcher's lifetime discard count when this drain began. See the report field. */
  private staleAtStart = 0;

  constructor(opts: ExtractWorkerOptions) {
    this.dispatcher = opts.dispatcher;
    this.source = opts.source;
    this.clock = opts.clock ?? systemClock;
    this.sleep = opts.sleep ?? defaultSleep;
    this.pacer = opts.pacer ?? new FetchPacer({ clock: this.clock });
    this.activity = opts.activity;
    this.guard = opts.guard;
    this.windowChars = opts.windowChars;
    this.priority = opts.priority;
  }

  get pacerReport(): ReturnType<FetchPacer['report']> {
    return this.pacer.report();
  }

  /**
   * Stand down at the next document boundary.
   *
   * A boundary and not sooner, because the whole-document GET has none inside it (§5.2.4):
   * the honest grain here is the document, and an in-flight one is abandoned by the process
   * dying rather than by a flag it would have to check inside a decode loop. Idempotent —
   * deposition and shutdown both reach it, and the first reason given is the one kept.
   */
  kill(reason: string): void {
    this.killedFor ??= reason;
  }

  get alive(): boolean {
    return this.killedFor === undefined;
  }

  async drain(): Promise<ExtractDrainReport> {
    this.priorityReport ??= this.priority?.();
    this.staleAtStart = this.dispatcher.staleCompletions ?? 0;
    let documents = 0;
    let windows = 0;
    let chars = 0;
    let emptyDocuments = 0;
    let failures = 0;

    for (;;) {
      if (this.killedFor !== undefined) {
        return this.report('killed', { documents, windows, chars, emptyDocuments, failures }, this.killedFor);
      }
      const orphan = this.orphaned();
      if (orphan) return this.report('orphaned', { documents, windows, chars, emptyDocuments, failures }, orphan);

      // Foreground first, and before the assignment rather than after it: a row claimed and
      // then parked for two seconds is a row nobody else may take while nothing happens to
      // it. Level 1 of the priority tree preempts everything, which includes asking.
      const idle = this.activity?.yieldMs() ?? 0;
      if (idle > 0) {
        await this.sleep(idle);
        continue;
      }

      const assignment = this.dispatcher.next();
      if (!assignment) return this.report('drained', { documents, windows, chars, emptyDocuments, failures });

      // The pace is taken before the fetch and after the claim is already held, so a
      // degraded local API slows the request rate without slowing the queue's turnover.
      const delay = this.pacer.delayMs;
      if (delay > 0) {
        this.pacer.recordDelay(delay);
        await this.sleep(delay);
      }

      let read: ExtractRead;
      try {
        read = await streamFullText({
          source: this.source,
          attachmentKey: assignment.attachmentKey,
          lib: assignment.libRef,
          windowChars: this.windowChars,
          clock: this.clock,
          onWindow: (window) => this.onWindow?.(window, assignment),
        });
      } catch (e) {
        // A failed fetch tells the pacer nothing: an error is not a latency, and feeding
        // the time-to-failure into the median would let one refused connection read as the
        // fastest document of the run. A stream cut mid-document arrives here too, which is
        // the point of `document-stream.ts` raising rather than returning a short document.
        failures++;
        this.dispatcher.fail(assignment, e instanceof Error ? e.message : String(e));
        continue;
      }
      if (read.ttfbMs !== null) this.pacer.observe(read.ttfbMs);
      const document: StreamedDocument | null = read.document;

      if (document === null) {
        emptyDocuments++;
        this.dispatcher.noText(assignment);
        documents++;
        this.onDocument?.(emptyDocument(assignment.attachmentKey), documents);
        continue;
      }

      windows += document.windows;
      chars += document.chars;
      documents++;
      this.dispatcher.complete(assignment, document);
      this.onDocument?.(document, documents);
    }
  }

  /**
   * Both worker-side repairs, asked between documents.
   *
   * The pipe has already fired by the time it is read here — `watchPipe` is an event
   * listener, so a parent that died mid-fetch is noticed at the next boundary — while the
   * lease poll is due-driven and is what covers a parent that is wedged rather than dead. A
   * SIGSTOP'd conductor closes no pipe.
   */
  private orphaned(): string | undefined {
    if (!this.guard) return undefined;
    if (this.guard.orphanedAlready) return 'pipe-closed';
    if (this.guard.checkParentIfDue() === false) return 'lease-lost';
    return undefined;
  }

  private report(
    stopped: DrainStop,
    counts: { documents: number; windows: number; chars: number; emptyDocuments: number; failures: number },
    orphanReason?: string,
  ): ExtractDrainReport {
    const pace = this.pacer.report();
    return {
      stopped,
      ...(orphanReason ? { orphanReason } : {}),
      ...counts,
      staleCompletions: (this.dispatcher.staleCompletions ?? 0) - this.staleAtStart,
      delayedFetches: pace.delayedFetches,
      totalDelayMs: pace.totalDelayMs,
      activityYields: this.activity?.yields ?? 0,
      totalYieldMs: this.activity?.totalYieldMs ?? 0,
      pace,
      ...(this.priorityReport ? { priority: this.priorityReport } : {}),
    };
  }
}

/**
 * The conductor's handle on the one worker it owns (`orphan.ts`'s `WorkerControl`), over a
 * worker that runs in this process.
 *
 * Tranche 2 built the call site — a deposed P0 kills its worker before anything else — with
 * nothing behind it, deliberately: what it owed was the ordering, not an implementation.
 * This is the implementation, and it is honest about which half it is. The **lifecycle** is
 * real: spawned when the queues hold work, run to drain, gone when the drain ends, killable
 * at any document boundary. The **process boundary** is not. In the running server the
 * worker is a separate process and windows cross a pipe; there is nothing on the far side of
 * that pipe to forward them to until the segmenter exists (§5.2.2, tranche 4), and a pipe
 * protocol written against no consumer is machinery that claims the design has been built.
 * `ExtractDispatcher` is where that boundary falls — what crosses it is already an
 * assignment and a result, which is what the pipe will carry.
 */
export class ExtractWorkerControl implements WorkerControl {
  /** Resolves when the drain ends, however it ended. Never rejects. */
  readonly finished: Promise<ExtractDrainReport>;

  private readonly worker: ExtractWorker;
  private done = false;

  constructor(worker: ExtractWorker) {
    this.worker = worker;
    this.finished = worker
      .drain()
      .catch((e: unknown) => failedReport(e))
      .then((report) => {
        this.done = true;
        return report;
      });
  }

  kill(reason: string): void {
    this.worker.kill(reason);
  }

  alive(): boolean {
    return !this.done && this.worker.alive;
  }
}

/**
 * A drain that threw is reported, never rethrown.
 *
 * The conductor polls this handle for liveness; a rejected promise nobody awaited would take
 * the server down over a worker whose whole design contract is that killing it is cheap.
 */
function failedReport(e: unknown): ExtractDrainReport {
  return {
    stopped: 'killed',
    orphanReason: e instanceof Error ? e.message : String(e),
    documents: 0,
    windows: 0,
    chars: 0,
    emptyDocuments: 0,
    failures: 1,
    staleCompletions: 0,
    delayedFetches: 0,
    totalDelayMs: 0,
    activityYields: 0,
    totalYieldMs: 0,
    pace: new FetchPacer().report(),
  };
}

/** The one real timer in the tranche, and it belongs to the running server, not the design. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms)); // wall-clock: intentional
}

function emptyDocument(attachmentKey: string): StreamedDocument {
  return {
    attachmentKey,
    textHash: '',
    chars: 0,
    windows: 0,
    indexedPages: null,
    totalPages: null,
    truncated: false,
    empty: true,
  };
}
