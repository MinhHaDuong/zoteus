import type { LibraryRef } from '../../../api/web-client.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import { EXTRACTOR_ID } from './document-stream.js';
import type { StreamedDocument } from './document-stream.js';
import type { AttachmentDecision, ClaimTicket, Ledger, SkipReason, WorkOrderRow } from './ledger.js';

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

/**
 * The micro-batch quantum, ratified at about 1 s (SPEC.md §5.2.5, DECISIONS.md 2026-09-01).
 *
 * Its per-device size derivation is tranche 4's, and so is its home; what tranche 3 needs is
 * the number the claim TTL is defined against, and defining it here beats writing 30 000 and
 * a comment.
 */
const MICRO_BATCH_QUANTUM_MS = 1_000;

/**
 * How long a claimed row stays claimed: 30 × the quantum (§5.2.5, ratified 2026-09-01).
 *
 * Above the worst honest stall a working machine produces and below the reconcile tick, at
 * the cost of at most one duplicated micro-batch. It is *not* the conductor's election lease
 * (`LEASE_TTL_MS`, 20 s): this stage defaulted to that constant through round 1, which put
 * the shipped claim a third below the ratified figure and left the pacer ceiling's own
 * derivation reasoning about the wrong margin. Two mechanisms, two numbers.
 */
export const CLAIM_TTL_MS = 30 * MICRO_BATCH_QUANTUM_MS;

/** How many outstanding claims one stage remembers. See `claimOrder`. */
const MAX_HELD_CLAIMS = 1_024;

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
  /**
   * Results refused because the row's claim had moved on, so the worker's drain report can
   * carry the number rather than leaving it somewhere nothing reads. Optional because it is
   * a fact about a dispatcher that owns claims, and the interface is what crosses the pipe.
   */
  readonly staleCompletions?: number;
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

  /**
   * Results discarded because the row's claim had moved on. Counted, never silent.
   *
   * §5.2.5 accepts one duplicated micro-batch as the price of recovering a stuck worker by
   * claim expiry. This is that duplicate arriving: the work was done twice and the second
   * copy is dropped. A number that climbs on a healthy machine means the claim TTL is below
   * the honest stall it was supposed to sit above, which is a thing the panel should show
   * rather than a thing to infer from missing text.
   */
  staleCompletions = 0;

  /**
   * The ticket for every row handed out and not yet completed.
   *
   * Conductor-side, so the worker still holds nothing about writes: what crosses the shim is
   * an assignment and a result (§5.2.4), and the claim that authorises the write stays on
   * this side of the line. A result whose wid is not in here is a completion for a row this
   * stage no longer owns, which is the same rejection the ledger's guard makes and is worth
   * catching before the write is attempted.
   */
  private readonly held = new Map<number, ClaimTicket>();

  constructor(opts: ExtractStageOptions) {
    this.ledger = opts.ledger;
    this.clock = opts.clock ?? systemClock;
    this.holder = opts.holder ?? 'extract';
    this.claimTtlMs = opts.claimTtlMs ?? CLAIM_TTL_MS;
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

      // The claim comes first, before any decision that could complete the row. Every write
      // below is a completion, and a completion is now owned: it names the claim it was
      // authorised by, so there has to be one. Losing the race here costs a loop, which is
      // what a row another P0 took should cost.
      const claim = this.claimOrder(order);
      if (!claim) continue;

      const attachmentKey = order.attachmentKey;
      if (!attachmentKey) {
        // `nextExtractOrder` filters these out; reaching here would mean the query and this
        // reader disagree, which is worth failing loudly rather than skipping quietly.
        this.finish(claim, (c) => this.ledger.markFailed(c, 'body order without an attachment key'));
        continue;
      }

      const itemKey = order.itemKey ?? this.ledger.itemDetail(order.lib, attachmentKey)?.parentItem ?? null;
      if (itemKey && !this.isChosen(order.lib, itemKey, attachmentKey)) {
        if (this.finish(claim, (c) => this.ledger.markDone(c))) this.skipped++;
        continue;
      }

      const library = this.ledger.library(order.lib);
      if (!library) {
        this.finish(claim, (c) => this.ledger.markFailed(c, `library ${order.lib} is not registered`));
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
    this.record(assignment, () => {
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
    this.record(assignment, () => {
      this.ledger.putExtractState(assignment.lib, {
        attachmentKey: assignment.attachmentKey,
        itemKey: assignment.itemKey,
        textHash: null,
        extractor: this.extractor,
        chars: 0,
        truncated: false,
        empty: true,
      });
    });
  }

  fail(assignment: ExtractAssignment, reason: string): void {
    const claim = this.held.get(assignment.wid);
    if (!claim) {
      this.staleCompletions++;
      return;
    }
    if (!this.finish(claim, (c) => this.ledger.markFailed(c, reason))) this.staleCompletions++;
  }

  /**
   * A result, written only if this stage still owns the row it answers.
   *
   * The ownership check runs first and inside the transaction, so a rejected completion
   * writes nothing at all — not the extract row, not D6's choice, not the work order. That
   * is the whole difference between §5.2.5's accepted duplicate (redone, discarded) and the
   * failure round 2 reproduced: worker A slow, its claim swept and re-taken by B, B finishes,
   * and A's late `putExtractState` overwrites B's row under B's own completed work order.
   * The `text_hash` left behind then belongs to neither worker's view of the document.
   */
  private record(assignment: ExtractAssignment, writes: () => void): void {
    const claim = this.held.get(assignment.wid);
    if (!claim) {
      this.staleCompletions++;
      return;
    }
    const applied = this.finish(claim, (c) => {
      if (!this.ledger.markDone(c)) return false;
      writes();
      return true;
    });
    if (!applied) this.staleCompletions++;
  }

  /**
   * Run one completion against a held claim and drop the claim either way.
   *
   * Either way, because a rejected completion means the row has moved on — another holder,
   * or newer work coalesced into it — and keeping the ticket would only let a second attempt
   * fail again. The write and the release are one transaction, so a completion that loses
   * the race leaves no trace.
   *
   * The rejection is not counted here: `next`'s own three completions run against a claim
   * taken microseconds earlier and read no document at all, so counting them would put
   * dispatch bookkeeping into the number `staleCompletions` exists to report — documents
   * fetched and then thrown away. The two callers that answer a *read* count it themselves.
   */
  private finish(claim: ClaimTicket, write: (claim: ClaimTicket) => boolean): boolean {
    this.held.delete(claim.wid);
    return this.ledger.transaction(() => write(claim));
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

  private claimOrder(order: WorkOrderRow): ClaimTicket | null {
    const claim = this.ledger.claimTicket(order.wid, this.holder, order.signal ?? '', this.claimTtlMs);
    if (!claim) return null;
    this.held.set(order.wid, claim);
    // A ticket leaves this map when its row is answered, so the only ones that survive are
    // rows whose worker died between the claim and the answer. One sequential worker cannot
    // have two documents in flight, so anything beyond a handful is residue; the oldest goes
    // first, and a completion for a row abandoned this long ago is stale by any reading.
    while (this.held.size > MAX_HELD_CLAIMS) {
      const oldest = this.held.keys().next();
      if (oldest.done) break;
      this.held.delete(oldest.value);
    }
    return claim;
  }
}

/** Re-exported so a caller wiring the stage does not also have to reach into the stream. */
export { EXTRACTOR_ID };
