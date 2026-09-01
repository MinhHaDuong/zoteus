import type { ActivityGate } from './activity.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { DocumentSource, DocumentWindow, StreamedDocument } from './document-stream.js';
import { streamFullText } from './document-stream.js';
import type { ExtractAssignment, ExtractDispatcher } from './extract-stage.js';
import { FetchPacer } from './fetch-pacer.js';
import type { WorkerOrphanGuard } from './orphan.js';

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

export type DrainStop = 'drained' | 'orphaned';

export interface ExtractDrainReport {
  stopped: DrainStop;
  /** Which repair noticed, when `stopped` is `orphaned`. */
  orphanReason?: string;
  documents: number;
  windows: number;
  chars: number;
  emptyDocuments: number;
  failures: number;
  delayedFetches: number;
  totalDelayMs: number;
  activityYields: number;
  totalYieldMs: number;
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

  constructor(opts: ExtractWorkerOptions) {
    this.dispatcher = opts.dispatcher;
    this.source = opts.source;
    this.clock = opts.clock ?? systemClock;
    this.sleep = opts.sleep ?? defaultSleep;
    this.pacer = opts.pacer ?? new FetchPacer({ clock: this.clock });
    this.activity = opts.activity;
    this.guard = opts.guard;
    this.windowChars = opts.windowChars;
  }

  get pacerReport(): ReturnType<FetchPacer['report']> {
    return this.pacer.report();
  }

  async drain(): Promise<ExtractDrainReport> {
    let documents = 0;
    let windows = 0;
    let chars = 0;
    let emptyDocuments = 0;
    let failures = 0;

    for (;;) {
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

      const started = this.clock.now();
      let document: StreamedDocument | null;
      try {
        document = await streamFullText({
          source: this.source,
          attachmentKey: assignment.attachmentKey,
          lib: assignment.libRef,
          windowChars: this.windowChars,
          onWindow: (window) => this.onWindow?.(window, assignment),
        });
      } catch (e) {
        // A failed fetch tells the pacer nothing: an error is not a latency, and feeding
        // the time-to-failure into the median would let one refused connection read as the
        // fastest document of the run.
        failures++;
        this.dispatcher.fail(assignment, e instanceof Error ? e.message : String(e));
        continue;
      }
      this.pacer.observe(this.clock.now() - started);

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
      delayedFetches: pace.delayedFetches,
      totalDelayMs: pace.totalDelayMs,
      activityYields: this.activity?.yields ?? 0,
      totalYieldMs: this.activity?.totalYieldMs ?? 0,
    };
  }
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
