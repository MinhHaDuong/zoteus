import type { LibraryRef } from '../../../api/web-client.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { EXTRACTOR_ID } from './document-stream.js';
import type { StreamedDocument } from './document-stream.js';
import type { AttachmentDecision, Ledger, SkipReason, WorkOrderRow } from './ledger.js';
import { LEASE_TTL_MS } from './lease.js';

/**
 * The conductor's half of the extract shim (SPEC.md §5.2.4).
 *
 * The shim splits along the write line, and everything on this side of it is a write: the
 * item cursor, the full-text census, extractor-version staleness, the per-attachment
 * truncation flags, and D6's choice of which attachment carries an item's body text. The
 * worker's one duty is the read — the whole-document GET — and it holds no write handle at
 * all (§5.2.5). So this class claims the row, decides whether the document is wanted, and
 * records what came back; the worker never touches the ledger.
 *
 * Written as a dispatcher rather than a loop because the boundary between the two halves is
 * a pipe in the running server. Here they are wired in-process and the interface is the
 * seam: what crosses it is an assignment and a result, which is exactly what the pipe will
 * carry.
 */

export interface ExtractAssignment {
  wid: number;
  lib: number;
  libRef: LibraryRef;
  attachmentKey: string;
  itemKey: string | null;
  /** The signal the tick derived this order from, carried through for the claim's record. */
  signal: string | null;
}

/**
 * What the worker pulls from and reports to. An interface so the worker can be driven by
 * the pipe reader in the running server and by the stage itself in a test, without either
 * one knowing which it has.
 */
export interface ExtractDispatcher {
  next(): ExtractAssignment | undefined;
  complete(assignment: ExtractAssignment, document: StreamedDocument): void;
  /** Zotero has no text for this attachment: a 404, not a failure. */
  noText(assignment: ExtractAssignment): void;
  fail(assignment: ExtractAssignment, reason: string): void;
}

export interface ExtractStageOptions {
  ledger: Ledger;
  clock?: Clock;
  /** The one worker this conductor spawned, identified for its claims. */
  holder?: string;
  claimTtlMs?: number;
  extractor?: string;
  lib?: number;
}

export class ExtractStage implements ExtractDispatcher {
  private readonly ledger: Ledger;
  private readonly clock: Clock;
  private readonly holder: string;
  private readonly claimTtlMs: number;
  private readonly extractor: string;
  private readonly lib?: number;

  /** Counted for the instrument panel: skips are work done, not work absent. */
  skipped = 0;

  constructor(opts: ExtractStageOptions) {
    this.ledger = opts.ledger;
    this.clock = opts.clock ?? systemClock;
    this.holder = opts.holder ?? 'extract';
    this.claimTtlMs = opts.claimTtlMs ?? LEASE_TTL_MS;
    this.extractor = opts.extractor ?? EXTRACTOR_ID;
    this.lib = opts.lib;
  }

  /**
   * The next document worth fetching, with every row D6 suppresses resolved on the way.
   *
   * The loop is what makes the skip cheap: a suppressed attachment is decided from the
   * census and the choice table, marked done, and never fetched — which is the whole point
   * of first-with-text, since fetching it to find out would cost exactly what the rule
   * exists to save.
   */
  next(): ExtractAssignment | undefined {
    for (;;) {
      const order = this.ledger.nextExtractOrder({ lib: this.lib });
      if (!order) return undefined;
      const attachmentKey = order.attachmentKey;
      if (!attachmentKey) {
        // `nextExtractOrder` filters these out; reaching here would mean the query and this
        // reader disagree, which is worth failing loudly rather than skipping quietly.
        this.ledger.markFailed(order.wid, 'body order without an attachment key');
        continue;
      }

      if (!this.claim(order)) continue;

      const itemKey = order.itemKey ?? this.ledger.itemDetail(order.lib, attachmentKey)?.parentItem ?? null;
      if (itemKey && !this.isChosen(order.lib, itemKey, attachmentKey)) {
        this.ledger.markDone(order.wid);
        this.skipped++;
        continue;
      }

      const library = this.ledger.library(order.lib);
      if (!library) {
        this.ledger.markFailed(order.wid, `library ${order.lib} is not registered`);
        continue;
      }
      return {
        wid: order.wid,
        lib: order.lib,
        libRef: { type: library.kind, id: library.remoteId },
        attachmentKey,
        itemKey,
        signal: order.signal,
      };
    }
  }

  complete(assignment: ExtractAssignment, document: StreamedDocument): void {
    this.ledger.transaction(() => {
      this.ledger.putExtractState(assignment.lib, {
        attachmentKey: assignment.attachmentKey,
        itemKey: assignment.itemKey,
        textHash: document.textHash,
        extractor: this.extractor,
        chars: document.chars,
        indexedPages: document.indexedPages,
        totalPages: document.totalPages,
        truncated: document.truncated,
        empty: document.empty,
      });
      // The chosen attachment's hash is what lets a *later* choice say whether a suppressed
      // sibling carried identical text, so recording it is what makes D6's two named
      // reasons reachable rather than aspirational.
      if (assignment.itemKey) this.decide(assignment.lib, assignment.itemKey);
      this.ledger.markDone(assignment.wid);
    });
  }

  /**
   * A 404 from the local API: the attachment is in the census and Zotero has no text.
   *
   * Recorded as an empty extraction rather than a failure. The distinction is D1's: an
   * attachment with nothing to extract is covered as metadata-only, which is a settled
   * state with a reason, where a failure is a thing to retry forever. The terminal-state
   * vocabulary itself is ticket 0019's and is not built here; what this owes it is a row
   * that says empty rather than one that says nothing.
   */
  noText(assignment: ExtractAssignment): void {
    this.ledger.transaction(() => {
      this.ledger.putExtractState(assignment.lib, {
        attachmentKey: assignment.attachmentKey,
        itemKey: assignment.itemKey,
        textHash: null,
        extractor: this.extractor,
        chars: 0,
        truncated: false,
        empty: true,
      });
      this.ledger.markDone(assignment.wid);
    });
  }

  fail(assignment: ExtractAssignment, reason: string): void {
    this.ledger.markFailed(assignment.wid, reason);
  }

  /**
   * D6's choice function, run per item: the first attachment — ascending `dateAdded`, key
   * tie-break — that appears in the full-text census carries the body text.
   *
   * It is re-derived rather than remembered, so the promise D6 makes about a later
   * extraction holds structurally: when an earlier attachment gains text, its row simply
   * sorts ahead and the output changes, with no invalidation to remember to run.
   */
  decide(lib: number, itemKey: string): AttachmentDecision[] {
    const candidates = this.ledger.attachmentsWithText(lib, itemKey);
    if (candidates.length === 0) return [];
    const [first, ...rest] = candidates;
    const chosenHash = this.ledger.extractState(lib, first!.attachmentKey)?.textHash ?? null;
    const decisions: AttachmentDecision[] = [
      { attachmentKey: first!.attachmentKey, chosen: true },
      ...rest.map((c) => ({
        attachmentKey: c.attachmentKey,
        chosen: false,
        reason: this.skipReason(lib, c.attachmentKey, chosenHash),
      })),
    ];
    this.ledger.putAttachmentChoice(lib, itemKey, decisions);
    return decisions;
  }

  /**
   * Which of §5.2.3's reasons is true of a suppressed attachment.
   *
   * Only a skipped attachment we have actually read can be compared, which is the case D6
   * names: it was chosen once, its text was stored, and a later extraction moved the choice
   * to an earlier sibling. Where we have never fetched it, `not-first-with-text` is the
   * whole of what is known — see `SkipReason`.
   */
  private skipReason(lib: number, attachmentKey: string, chosenHash: string | null): SkipReason {
    const own = this.ledger.extractState(lib, attachmentKey)?.textHash ?? null;
    if (own === null || chosenHash === null) return 'not-first-with-text';
    return own === chosenHash ? 'identical-text' : 'different-text';
  }

  private isChosen(lib: number, itemKey: string, attachmentKey: string): boolean {
    const known = this.ledger.attachmentChoice(lib, attachmentKey);
    if (known && known.itemKey === itemKey) return known.chosen;
    const decisions = this.decide(lib, itemKey);
    // No candidate at all means the census has since lost this attachment's text. Letting
    // it through costs one 404 and one honest `empty` row, where suppressing it would
    // silently drop a work order nothing else will re-derive until the text comes back.
    if (decisions.length === 0) return true;
    return decisions.some((d) => d.attachmentKey === attachmentKey && d.chosen);
  }

  private claim(order: WorkOrderRow): boolean {
    return this.ledger.claim(order.wid, this.holder, order.signal ?? '', this.claimTtlMs);
  }
}

/** Re-exported so a caller wiring the stage does not also have to reach into the stream. */
export { EXTRACTOR_ID };
