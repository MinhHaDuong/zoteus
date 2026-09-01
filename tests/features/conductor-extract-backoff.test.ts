import { describe, it, expect } from 'vitest';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import { ExtractStage } from '../../src/features/search/conductor/extract-stage.js';
import { ExtractWorker } from '../../src/features/search/conductor/extract-worker.js';
import {
  FetchPacer,
  PACE_CEILING_MS,
  PACE_STEP_MS,
} from '../../src/features/search/conductor/fetch-pacer.js';
import { ReplayLocalApi } from '../fixtures/local-api-replay.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * Ticket 0553's own test, and the one the ruling of 2026-09-01 is measured by: on a rising
 * local-API latency median the worker inserts a delay between document fetches, decaying
 * on recovery.
 *
 * The arm that makes it a test rather than a demonstration is the second one. A back-off
 * that fires on a flat latency profile would satisfy "the delay appeared" exactly as well
 * as one that reads the ramp, so the flat run is asserted to produce *no* delay at all —
 * the control that can come out the other way.
 *
 * Latency is charged to the injected clock by the replay fake rather than waited out
 * (`local-api-replay.ts`), which is what lets a ramp of four hundred milliseconds across
 * thirty documents cost nothing. Nothing here sleeps.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const START = 1_700_000_000_000;
const QUIET_MS = 20;
const SLOW_MS = 400;

interface Harness {
  clock: ManualClock;
  ledger: Ledger;
  replay: ReplayLocalApi;
  stage: ExtractStage;
  lib: number;
  keys: string[];
  /** Every sleep the worker asked for, in order. Zero-length ones are never requested. */
  delays: number[];
  worker(pacer?: FetchPacer): ExtractWorker;
}

/**
 * `count` attachments, each under its own item, each with extracted text and a queued body
 * order. Built directly rather than through `SyntheticLibrary` because what this file
 * needs is a long *sequence* of documents — the median is over a window, so a handful
 * cannot exercise it — and nothing else about a real library's shape.
 */
function harness(count: number): Harness {
  const clock = new ManualClock(START);
  const ledger = Ledger.open(':memory:', clock);
  const oid = ledger.registerOrigin('synthetic-server');
  const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
  const replay = new ReplayLocalApi({ clock });

  const keys: string[] = [];
  for (let i = 1; i <= count; i++) {
    const attachment = `ATTA${String(i).padStart(4, '0')}`;
    const item = `ITEM${String(i).padStart(4, '0')}`;
    keys.push(attachment);
    ledger.putItemDetail(lib, item, {
      dateAdded: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      itemType: 'journalArticle',
      parentItem: null,
    });
    ledger.putItemDetail(lib, attachment, {
      dateAdded: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T01:00:00Z`,
      itemType: 'attachment',
      parentItem: item,
    });
    ledger.putFulltextCensus(lib, [[attachment, { ftVersion: i, itemVersion: i }]]);
    ledger.enqueue({
      lib,
      class: 'body',
      op: 'index',
      attachmentKey: attachment,
      itemKey: item,
      signal: `fulltext:${i}|item:${i}`,
    });
    replay.put(`/users/0/items/${attachment}/fulltext`, {
      body: { content: `Text of ${attachment}.`, indexedPages: 2, totalPages: 2 },
    });
  }

  const stage = new ExtractStage({ ledger, clock });
  const delays: number[] = [];
  return {
    clock,
    ledger,
    replay,
    stage,
    lib,
    keys,
    delays,
    worker: (pacer?: FetchPacer) =>
      new ExtractWorker({
        dispatcher: stage,
        source: replay.client(),
        clock,
        pacer,
        sleep: async (ms: number) => {
          delays.push(ms);
          clock.advance(ms);
        },
      }),
  };
}

describeSqlite('extract worker: the latency-observed back-off', () => {
  it('inserts a growing delay while the local API degrades, and decays it on recovery', async () => {
    const h = harness(34);
    const pacer = new FetchPacer({ clock: h.clock });
    const worker = h.worker(pacer);

    // A ramp, not a step: the fake's latency is re-read on every call, so raising it
    // partway through the drain is what a Zotero starting to index its own PDFs does.
    h.replay.latencyMs = QUIET_MS;
    let degradedAfter = -1;
    let recoveredAfter = -1;
    worker.onDocument = (_doc, n): void => {
      if (n === 10) h.replay.latencyMs = SLOW_MS;
      if (n === 22) h.replay.latencyMs = QUIET_MS;
      if (degradedAfter < 0 && pacer.delayMs > 0) degradedAfter = n;
      if (degradedAfter > 0 && recoveredAfter < 0 && n > degradedAfter && pacer.delayMs === 0) {
        recoveredAfter = n;
      }
    };

    const report = await worker.drain();
    expect(report.stopped).toBe('drained');
    expect(report.documents).toBe(34);

    // It fired, and only after the ramp started.
    expect(h.delays.length).toBeGreaterThan(0);
    expect(degradedAfter).toBeGreaterThan(10);

    // It grew: the first delay is the step, and the run reaches the ceiling.
    expect(h.delays[0]).toBe(PACE_STEP_MS);
    expect(Math.max(...h.delays)).toBe(PACE_CEILING_MS);

    // And it decayed back to nothing once the latency came down, rather than staying on.
    expect(recoveredAfter).toBeGreaterThan(22);
    expect(pacer.delayMs).toBe(0);
    expect(pacer.report().degradedAt).toBeNull();

    h.ledger.close();
  });

  it('control: the same drain at a flat latency inserts no delay at all', async () => {
    const h = harness(34);
    const pacer = new FetchPacer({ clock: h.clock });
    h.replay.latencyMs = QUIET_MS;

    const report = await h.worker(pacer).drain();
    expect(report.documents).toBe(34);
    expect(h.delays).toEqual([]);
    expect(report.totalDelayMs).toBe(0);
    expect(pacer.report().degraded).toBe(false);

    h.ledger.close();
  });

  it('control: a ramp that is large in ratio and trivial in milliseconds is not degradation', async () => {
    // 2 ms to 6 ms is a tripling, and it is nothing: on a fast library ordinary scheduling
    // jitter looks exactly like this. The absolute floor is the only thing standing between
    // that and a permanent back-off, so this arm is red without it — which is what makes it
    // a control rather than a second copy of the flat run above.
    const h = harness(34);
    const pacer = new FetchPacer({ clock: h.clock });
    h.replay.latencyMs = 2;
    const worker = h.worker(pacer);
    worker.onDocument = (_doc, seen): void => {
      if (seen === 10) h.replay.latencyMs = 6;
    };

    await worker.drain();
    expect(h.delays).toEqual([]);
    expect(pacer.report().degraded).toBe(false);

    h.ledger.close();
  });
});
