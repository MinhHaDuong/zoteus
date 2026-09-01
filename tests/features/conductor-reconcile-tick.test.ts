import { describe, it, expect } from 'vitest';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import { ReconcileTick } from '../../src/features/search/conductor/reconcile-tick.js';
import { ReplayLocalApi } from '../fixtures/local-api-replay.js';
import { SyntheticLibrary } from '../fixtures/synthetic-library.js';
import { ManualClock } from '../fixtures/clock.js';
import { completeByHand } from '../fixtures/claims.js';

/**
 * The reconcile tick: SPEC.md §5.2.4, and the discovery half of R35's one-minute promise.
 *
 * It asks Zotero what changed and writes work orders. It extracts nothing, and it fetches
 * no document — the whole-document GET has no micro-batch boundary inside it, so a tick
 * that performed one would run for as long as the document takes and R35's minute would
 * go there. That prohibition is asserted here directly, off the requests the replay fake
 * recorded, rather than trusted.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const START = 1_700_000_000_000;

interface Harness {
  clock: ManualClock;
  ledger: Ledger;
  replay: ReplayLocalApi;
  library: SyntheticLibrary;
  tick: ReconcileTick;
  lib: number;
  /** Re-can the wire after a mutation, then run one tick. */
  reconcile(): Promise<ReturnType<ReconcileTick['runOnce']>>;
}

function harness(scope: 'local' | 'cloud' = 'local'): Harness {
  const clock = new ManualClock(START);
  const ledger = Ledger.open(':memory:', clock);
  const oid = ledger.registerOrigin('synthetic-server');
  const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope });
  const library = new SyntheticLibrary();
  library.assertInvariants();
  const replay = new ReplayLocalApi({ clock });
  library.install(replay);
  const tick = new ReconcileTick({ ledger, signals: replay.client(), clock });
  return {
    clock,
    ledger,
    replay,
    library,
    tick,
    lib,
    reconcile: () => {
      library.install(replay);
      return tick.runOnce(lib);
    },
  };
}

/** Everything the pipeline would have done, without a pipeline. */
function drain(ledger: Ledger, lib: number): number {
  let n = 0;
  for (;;) {
    const next = ledger.nextWorkOrder({ lib });
    if (!next) return n;
    completeByHand(ledger, next.wid);
    n++;
  }
}

describeSqlite('reconcile tick: the first sweep', () => {
  it('enqueues every item and every extracted attachment, once', async () => {
    const h = harness();
    const report = await h.reconcile();

    expect(report.ok).toBe(true);
    expect(report.changedItems).toBeGreaterThan(50);
    expect(report.changedFulltext).toBe(Object.keys(h.library.fulltextCensusMap()).length);
    expect(report.deletions).toBe(0);

    // A second tick over an unchanged library adds nothing: the queue is re-derived every
    // 60 s, so a tick that appended would grow the backlog by its own size every minute.
    const before = h.ledger.pending(h.lib).length;
    h.clock.advance(60_000);
    const second = await h.reconcile();
    expect(second.enqueued).toBe(0);
    expect(h.ledger.pending(h.lib).length).toBe(before);
    h.ledger.close();
  });

  it('never fetches a document', async () => {
    const h = harness();
    await h.reconcile();
    const routes = h.replay.requests.map((r) => r.key);
    expect(routes.length).toBeGreaterThan(0);
    // The two shapes that read a document: one attachment's full text, and its bytes.
    expect(routes.filter((r) => /\/items\/[A-Z0-9]+\/fulltext/.test(r))).toEqual([]);
    expect(routes.filter((r) => /\/items\/[A-Z0-9]+\/file/.test(r))).toEqual([]);
    h.ledger.close();
  });

  it('orders what it queued: records before own words before body, newest first', async () => {
    const h = harness();
    await h.reconcile();
    const first = h.ledger.nextWorkOrder({ lib: h.lib });
    expect(first?.class).toBe('metadata');

    const classes = h.ledger.pending(h.lib).map((r) => r.class);
    const rank = { metadata: 0, own_words: 1, body: 2 } as const;
    const ranks = classes.map((c) => rank[c]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    // Inside the record class, Zotero's own dateAdded decides, newest first.
    const records = h.ledger.pending(h.lib).filter((r) => r.class === 'metadata' && r.dateAdded);
    const dates = records.map((r) => r.dateAdded!);
    expect(dates).toEqual([...dates].sort().reverse());
    h.ledger.close();
  });

  it('files a child note as own words, not as a record', async () => {
    const h = harness();
    await h.reconcile();
    const note = h.ledger.pending(h.lib).find((r) => r.itemKey === 'NOTE0001');
    expect(note?.class).toBe('own_words');
    const annotation = h.ledger.pending(h.lib).find((r) => r.itemKey === 'ANNO0001');
    expect(annotation?.class).toBe('own_words');
    h.ledger.close();
  });
});

describeSqlite('reconcile tick: one virtual tick per change', () => {
  it('discovers a new item within one tick', async () => {
    const h = harness();
    await h.reconcile();
    drain(h.ledger, h.lib);

    const key = h.library.addItem('A paper added while the index was running');
    h.clock.advance(60_000);
    const report = await h.reconcile();

    expect(report.changedItems).toBe(1);
    const queued = h.ledger.pending(h.lib);
    expect(queued.map((r) => r.itemKey)).toContain(key);
    expect(queued.find((r) => r.itemKey === key)?.class).toBe('metadata');
    h.ledger.close();
  });

  it('discovers an edited full-text version within one tick, on the sequence items never move', async () => {
    const h = harness();
    await h.reconcile();
    drain(h.ledger, h.lib);

    // ATTA0025 was never opened, so it has no extracted text and no item-version change
    // will ever announce it. Zotero extracting it moves only the full-text sequence.
    const itemsBefore = h.library.itemVersion;
    h.library.extract('ATTA0025', 'Newly extracted body text for the twenty-fifth attachment.');
    expect(h.library.itemVersion).toBe(itemsBefore);

    h.clock.advance(60_000);
    const report = await h.reconcile();

    expect(report.changedItems).toBe(0);
    expect(report.changedFulltext).toBe(1);
    const queued = h.ledger.pending(h.lib);
    expect(queued.map((r) => r.attachmentKey)).toContain('ATTA0025');
    expect(queued.find((r) => r.attachmentKey === 'ATTA0025')?.class).toBe('body');
    h.ledger.close();
  });

  it('discovers a deletion within one tick, by subtracting the census', async () => {
    const h = harness();
    await h.reconcile();
    drain(h.ledger, h.lib);

    h.library.remove('ITEM0010');
    h.clock.advance(60_000);
    const report = await h.reconcile();

    // The item and the child note that hung under it.
    expect(report.deletions).toBeGreaterThanOrEqual(2);
    const deletes = h.ledger.pending(h.lib).filter((r) => r.op === 'delete');
    expect(deletes.map((r) => r.itemKey)).toContain('ITEM0010');
    expect(deletes.map((r) => r.itemKey)).toContain('NOTE0010');
    // A deletion order is metadata class: it must beat every queued body range.
    expect(deletes.every((r) => r.class === 'metadata')).toBe(true);
    h.ledger.close();
  });
});

describeSqlite('reconcile tick: the version-0 residue', () => {
  /**
   * SPEC.md §5.2.4. 584 of 8 037 measured full-text entries sit at version 0, and a local
   * re-extraction stamps 0 again — invisible to an equality comparison. The resolution is
   * four-part; parts (i) and (ii) are what this tranche implements, and this test asserts
   * both, including the half that is a disclosed limitation rather than a fix.
   */
  it('(ii) does not see a re-extraction that re-stamps 0, and says how many it cannot see', async () => {
    const h = harness();
    const first = await h.reconcile();
    drain(h.ledger, h.lib);

    // ATTA0001 sits at version 0. Zotero re-extracts it locally: different text, same
    // stamp, no file change, so nothing in either sequence moves.
    expect(first.versionZeroResidue).toBeGreaterThan(0);
    h.library.extractLocally('ATTA0001', 'Entirely different text after a local re-extraction.');

    h.clock.advance(60_000);
    const report = await h.reconcile();

    // Honest behaviour, not a bug: the tick reports no change AND reports the residue it
    // is blind to, which is what the contract's "version-0 text refreshes on file change
    // or rebuild" is measured against.
    expect(report.changedFulltext).toBe(0);
    expect(report.enqueued).toBe(0);
    expect(report.versionZeroResidue).toBe(first.versionZeroResidue);
    h.ledger.close();
  });

  it('(i) sees it when the FILE changed, because that bumps the attachment item', async () => {
    const h = harness();
    await h.reconcile();
    drain(h.ledger, h.lib);

    // The half that is a fix: replacing the file bumps the attachment item in the very
    // sequence the tick already sweeps, so pairing the two signals catches it for free.
    h.library.replaceFile('ATTA0001', 'Text from a replaced PDF, still stamped version 0.');

    h.clock.advance(60_000);
    const report = await h.reconcile();

    expect(report.changedFulltext).toBe(1);
    expect(h.ledger.pending(h.lib).map((r) => r.attachmentKey)).toContain('ATTA0001');
    h.ledger.close();
  });
});

describeSqlite('reconcile tick: cadence and back-off', () => {
  it('is due every 60 s and not before', async () => {
    const h = harness();
    await h.reconcile();

    expect(h.tick.dueAt(h.lib)).toBe(START + 60_000);
    expect(h.tick.isDue(h.lib)).toBe(false);
    h.clock.advance(59_999);
    expect(h.tick.isDue(h.lib)).toBe(false);
    // Positive control on the clock: with time not advanced, nothing fires.
    expect(await h.tick.runIfDue(h.lib)).toBeUndefined();

    h.clock.advance(1);
    expect(h.tick.isDue(h.lib)).toBe(true);
    h.library.install(h.replay);
    expect(await h.tick.runIfDue(h.lib)).toBeDefined();
    h.ledger.close();
  });

  it('backs off when Zotero stops answering, and recovers on the first answer', async () => {
    const h = harness();
    await h.reconcile();
    h.replay.silent = true;

    h.clock.advance(60_000);
    const one = await h.tick.runOnce(h.lib);
    expect(one.ok).toBe(false);
    expect(one.reason).toMatch(/fetch failed/);
    expect(one.nextDueAt - h.clock.now()).toBe(60_000);

    h.clock.advance(60_000);
    const two = await h.tick.runOnce(h.lib);
    expect(two.nextDueAt - h.clock.now()).toBe(120_000);

    h.clock.advance(120_000);
    const three = await h.tick.runOnce(h.lib);
    expect(three.nextDueAt - h.clock.now()).toBe(240_000);

    // A failed tick writes nothing: an unreachable Zotero has nothing to report, and a
    // half-applied sweep would make the next one derive from a state that never existed.
    expect(h.ledger.pending(h.lib).length).toBeGreaterThan(0);
    const before = h.ledger.pending(h.lib).length;

    h.replay.silent = false;
    h.clock.advance(240_000);
    const back = await h.reconcile();
    expect(back.ok).toBe(true);
    expect(back.nextDueAt - h.clock.now()).toBe(60_000);
    expect(h.ledger.pending(h.lib).length).toBe(before);
    h.ledger.close();
  });

  it('caps the back-off, so R35 resumes within one interval of Zotero coming back', async () => {
    const h = harness();
    await h.reconcile();
    h.replay.silent = true;
    for (let i = 0; i < 12; i++) {
      h.clock.advance(600_000);
      const report = await h.tick.runOnce(h.lib);
      expect(report.nextDueAt - h.clock.now()).toBeLessThanOrEqual(300_000);
    }
    h.ledger.close();
  });
});

describeSqlite('reconcile tick: scope', () => {
  it('reads the whole census for a local scope, every tick', async () => {
    const h = harness('local');
    await h.reconcile();
    h.clock.advance(60_000);
    h.replay.requests.length = 0;
    await h.reconcile();
    // No cursor: the local full-text sequence is mixed, so `?since=0` every time.
    expect(h.replay.requests.map((r) => r.key)).toContain('GET /users/0/fulltext?since=0');
    expect(h.ledger.fulltextWatermark(h.lib)).toBeNull();
    h.ledger.close();
  });

  it('carries a cursor for a cloud scope, where the sequence really is monotonic', async () => {
    const h = harness('cloud');
    await h.reconcile();
    expect(h.ledger.fulltextWatermark(h.lib)).toBe(h.library.fulltextVersion);

    h.clock.advance(60_000);
    h.replay.requests.length = 0;
    await h.reconcile();
    expect(h.replay.requests.map((r) => r.key)).toContain(
      `GET /users/0/fulltext?since=${h.library.fulltextVersion}`,
    );
    h.ledger.close();
  });
});
