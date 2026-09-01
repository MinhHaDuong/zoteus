import type { LibraryRef, ListResult, VersionsResult } from '../../../api/web-client.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { Ledger, WorkClass } from './ledger.js';

/**
 * The reconcile tick: SPEC.md §5.2.4, and the discovery half of R35's one-minute promise.
 *
 * It asks Zotero what changed and writes work orders. **It extracts nothing and it
 * fetches no document.** The whole-document GET has no micro-batch boundary inside it, so
 * a tick that performed one would run for as long as the document takes and R35's minute
 * would go there; the tick dispatches, and the pipeline worker fetches (§5.2.5). Nothing
 * in this file reads `/items/<key>/fulltext` or `/items/<key>/file`, and a test asserts
 * that against the requests actually issued rather than against this paragraph.
 *
 * Three things per library, and they answer three different questions:
 *
 * 1. **What changed** — the item read from the watermark. A cursor is legitimate because
 *    library versions are monotonic per backend, and scoping by server id is what makes
 *    that true: the local/cloud label was verified insufficient.
 * 2. **What has text** — the full-text census. Local scopes read the whole census every
 *    tick, because their sequence is mixed (a web sync stamp, a local client version, or
 *    0 for locally extracted text) and a cursor over it loses work. Cloud scopes carry an
 *    ordinary `?since=`. The ledger schema, not this comment, is what enforces that.
 * 3. **What is gone** — the full version census, subtracted from the stored one. The
 *    local API has no `/deleted` endpoint (C2), so subtraction is the only route, and
 *    R35 gives a deletion the same minute it gives an addition.
 *
 * Reads 1 and 3 are separate calls, and the redundancy is deliberate rather than
 * overlooked: the full census could yield the delta by filtering on the watermark, but
 * the delta read is the one that carries `dateAdded` and `itemType` — the newest-first
 * sort key and the discovery class — which `format=versions` does not. Collapsing them
 * would buy one request and cost the ordering.
 *
 * **Nothing here sleeps.** Due-ness is arithmetic on the injected clock and the caller
 * drives the loop, which is what lets a suite assert the 60 s cadence at no cost and
 * assert it fired *on time* rather than merely that it fired.
 */

/** How many items one page of the delta read asks for. */
export const TICK_PAGE_SIZE = 100;

/** §5.2.4: every 60 s when idle. The cadence is what delivers R35's minute. */
export const DEFAULT_TICK_CADENCE_MS = 60_000;

/**
 * The back-off ceiling. Backing off is not an R35 violation — a Zotero that is not
 * answering has nothing to report, and the minute starts when it comes back — but the
 * ceiling is what bounds "when it comes back": at worst one interval passes before the
 * tick notices. Five minutes rather than the usual fifteen for that reason. Closing the
 * gap properly means a cheap liveness probe on its own cadence, which belongs to the
 * tranche that wires the conductor's loop, not here.
 */
export const DEFAULT_BACKOFF_CEILING_MS = 300_000;

/**
 * The reads the tick needs from Zotero. `LocalApiClient` satisfies it structurally, and
 * so does the Web API client; the tick is written against the three questions rather than
 * against a transport.
 */
export interface ZoteroSignals {
  listItems(query: { since?: number; limit?: number; start?: number }, lib?: LibraryRef): Promise<ListResult>;
  itemVersions(query: { since?: number }, lib?: LibraryRef): Promise<VersionsResult>;
  fullTextSince(since: number, lib?: LibraryRef): Promise<Record<string, number>>;
}

export interface ReconcileTickOptions {
  ledger: Ledger;
  signals: ZoteroSignals;
  clock?: Clock;
  cadenceMs?: number;
  backoffCeilingMs?: number;
}

export interface TickReport {
  lib: number;
  ranAt: number;
  ok: boolean;
  /** Why the tick found nothing, when `ok` is false. Zotero unreachable, in practice. */
  reason?: string;
  changedItems: number;
  changedFulltext: number;
  deletions: number;
  /** Work orders written. Zero on a tick that re-derived a queue already correct. */
  enqueued: number;
  /**
   * Census entries stamped full-text version 0, which no equality comparison can see a
   * re-extraction of (§5.2.4, resolution (ii)). Reported rather than fixed: the contract
   * says "version-0 text refreshes on file change or rebuild", and this is the number
   * that claim is measured against.
   */
  versionZeroResidue: number;
  nextDueAt: number;
}

interface TickState {
  nextDueAt: number;
  failures: number;
}

export class ReconcileTick {
  private readonly ledger: Ledger;
  private readonly signals: ZoteroSignals;
  private readonly clock: Clock;
  private readonly cadenceMs: number;
  private readonly ceilingMs: number;
  /**
   * Per-library schedule, in memory. It is not in the ledger because it holds no fact
   * about the library — only about this conductor's own loop — and a restart that runs
   * one tick early costs a census read, while a restart that inherits a stale back-off
   * costs R35's promise.
   */
  private readonly state = new Map<number, TickState>();

  constructor(opts: ReconcileTickOptions) {
    this.ledger = opts.ledger;
    this.signals = opts.signals;
    this.clock = opts.clock ?? systemClock;
    this.cadenceMs = opts.cadenceMs ?? DEFAULT_TICK_CADENCE_MS;
    this.ceilingMs = opts.backoffCeilingMs ?? DEFAULT_BACKOFF_CEILING_MS;
  }

  /** When this library is next owed a tick. A library never ticked is owed one now. */
  dueAt(lib: number): number {
    return this.state.get(lib)?.nextDueAt ?? this.clock.now();
  }

  isDue(lib: number): boolean {
    return this.clock.now() >= this.dueAt(lib);
  }

  async runIfDue(lib: number): Promise<TickReport | undefined> {
    return this.isDue(lib) ? this.runOnce(lib) : undefined;
  }

  async runOnce(lib: number): Promise<TickReport> {
    const library = this.ledger.library(lib);
    if (!library) throw new Error(`reconcile tick: library ${lib} is not registered`);
    const ref: LibraryRef = { type: library.kind, id: library.remoteId };

    let changed: Array<Record<string, any>>;
    let head: number;
    let census: VersionsResult;
    let fulltext: Record<string, number>;
    const fulltextSince = library.scope === 'cloud' ? (library.fulltextWatermark ?? 0) : 0;
    try {
      const delta = await this.readChangedItems(ref, library.itemWatermark);
      changed = delta.items;
      head = delta.head;
      census = await this.signals.itemVersions({}, ref);
      fulltext = await this.signals.fullTextSince(fulltextSince, ref);
    } catch (e) {
      // A failed tick writes nothing at all. A half-applied sweep would leave the next
      // one deriving from a state Zotero never reported.
      return this.finish(lib, {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
        changedItems: 0,
        changedFulltext: 0,
        deletions: 0,
        enqueued: 0,
        versionZeroResidue: 0,
      });
    }

    let enqueued = 0;
    let changedItems = 0;
    let changedFulltext = 0;
    let deletions = 0;

    this.ledger.transaction(() => {
      // --- 3. Deletions, first: everything after this reads a census with them gone.
      const stored = this.ledger.itemCensus(lib);
      const gone: string[] = [];
      for (const key of stored.keys()) if (!(key in census.versions)) gone.push(key);
      for (const key of gone) {
        const detail = this.ledger.itemDetail(lib, key);
        this.ledger.enqueue({
          lib,
          class: 'metadata',
          op: 'delete',
          itemKey: key,
          dateAdded: detail?.dateAdded ?? undefined,
          signal: 'absent-from-census',
        });
        enqueued++;
        deletions++;
      }
      this.ledger.deleteItemCensus(lib, gone);
      this.ledger.deleteFulltextCensus(lib, gone);

      // --- 1. Items: what Zotero says changed since the watermark.
      for (const raw of changed) {
        const data = (raw.data ?? raw) as Record<string, any>;
        const key = String(data.key ?? raw.key ?? '');
        if (!key) continue;
        this.ledger.putItemDetail(lib, key, {
          dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : null,
          itemType: typeof data.itemType === 'string' ? data.itemType : null,
          parentItem: typeof data.parentItem === 'string' ? data.parentItem : null,
        });
        changedItems++;
        // An attachment's own record is not a searchable record; the work it implies is
        // its text, and that arrives through the census below — where the attachment's
        // item version is the other half of the signal (§5.2.4, resolution (i)).
        if (data.itemType === 'attachment') continue;
        this.ledger.enqueue({
          lib,
          class: discoveryClass(data.itemType),
          op: 'index',
          itemKey: key,
          dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : undefined,
          signal: `item:${data.version ?? raw.version ?? 0}`,
        });
        enqueued++;
      }
      this.ledger.putItemCensus(lib, Object.entries(census.versions));
      this.ledger.setItemWatermark(lib, head || library.itemWatermark);

      // --- 2. Full text: the census, diffed per attachment on BOTH halves of the signal.
      const storedText = this.ledger.fulltextCensus(lib);
      for (const [attachmentKey, ftVersion] of Object.entries(fulltext)) {
        const itemVersion = census.versions[attachmentKey] ?? 0;
        const previous = storedText.get(attachmentKey);
        if (previous && previous.ftVersion === ftVersion && previous.itemVersion === itemVersion) continue;
        const detail = this.ledger.itemDetail(lib, attachmentKey);
        this.ledger.enqueue({
          lib,
          class: 'body',
          op: 'index',
          attachmentKey,
          itemKey: detail?.parentItem ?? undefined,
          dateAdded: detail?.dateAdded ?? undefined,
          signal: `fulltext:${ftVersion}|item:${itemVersion}`,
        });
        this.ledger.putFulltextCensus(lib, [[attachmentKey, { ftVersion, itemVersion }]]);
        enqueued++;
        changedFulltext++;
      }

      if (library.scope === 'local') {
        // The local census is complete, so an attachment missing from it has lost its
        // text — Zotero cleared the cache, or the file went away. A cloud census is a
        // delta, where absence means nothing and this subtraction would delete the world.
        for (const attachmentKey of storedText.keys()) {
          if (attachmentKey in fulltext) continue;
          this.ledger.enqueue({
            lib,
            class: 'body',
            op: 'delete',
            attachmentKey,
            signal: 'absent-from-census',
          });
          this.ledger.deleteFulltextCensus(lib, [attachmentKey]);
          enqueued++;
          deletions++;
        }
      } else {
        const highest = Object.values(fulltext).reduce((a, b) => Math.max(a, b), fulltextSince);
        this.ledger.setFulltextWatermark(lib, highest);
      }
    });

    return this.finish(lib, {
      ok: true,
      changedItems,
      changedFulltext,
      deletions,
      enqueued,
      versionZeroResidue: Object.values(fulltext).filter((v) => v === 0).length,
    });
  }

  /**
   * The delta read, paged. `?since=` on `/items` rather than on `?format=versions`,
   * because the class and the sort key live in the item data and nowhere else.
   */
  private async readChangedItems(
    ref: LibraryRef,
    since: number,
  ): Promise<{ items: Array<Record<string, any>>; head: number }> {
    const items: Array<Record<string, any>> = [];
    let head = since;
    for (let start = 0; ; start += TICK_PAGE_SIZE) {
      const page = await this.signals.listItems({ since, limit: TICK_PAGE_SIZE, start }, ref);
      head = Math.max(head, page.lastModifiedVersion);
      items.push(...(page.data as Array<Record<string, any>>));
      // The length guard, not the total, is what terminates: a wrong or missing
      // `Total-Results` must cost one extra request, never an unbounded loop.
      if (page.data.length === 0 || items.length >= page.totalResults) return { items, head };
    }
  }

  private finish(lib: number, report: Omit<TickReport, 'lib' | 'ranAt' | 'nextDueAt'>): TickReport {
    const now = this.clock.now();
    const state = this.state.get(lib) ?? { nextDueAt: now, failures: 0 };
    if (report.ok) {
      state.failures = 0;
      state.nextDueAt = now + this.cadenceMs;
    } else {
      state.failures++;
      state.nextDueAt = now + Math.min(this.cadenceMs * 2 ** (state.failures - 1), this.ceilingMs);
    }
    this.state.set(lib, state);
    return { ...report, lib, ranAt: now, nextDueAt: state.nextDueAt };
  }
}

/** §5.2.3: a record, its own words, or its body text. Attachments never reach here. */
function discoveryClass(itemType: unknown): WorkClass {
  return itemType === 'note' || itemType === 'annotation' ? 'own_words' : 'metadata';
}
