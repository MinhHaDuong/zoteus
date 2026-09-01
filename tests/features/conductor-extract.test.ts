import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { ActivityGate } from '../../src/features/search/conductor/activity.js';
import { Conductor } from '../../src/features/search/conductor/conductor.js';
import { EXTRACTOR_ID } from '../../src/features/search/conductor/document-stream.js';
import { ExtractStage } from '../../src/features/search/conductor/extract-stage.js';
import { ExtractWorker, ExtractWorkerControl } from '../../src/features/search/conductor/extract-worker.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import { CONDUCTOR_LEASE } from '../../src/features/search/conductor/lease.js';
import { leaseHolderReader, WorkerOrphanGuard } from '../../src/features/search/conductor/orphan.js';
import { lowerWorkerPriority, WORKER_NICE } from '../../src/features/search/conductor/priority.js';
import { ReconcileTick } from '../../src/features/search/conductor/reconcile-tick.js';
import { ManualClock } from '../fixtures/clock.js';
import { ReplayLocalApi } from '../fixtures/local-api-replay.js';
import { SyntheticLibrary } from '../fixtures/synthetic-library.js';

/**
 * Tranche 3's stage and worker: the class order in the dispatch query, D6's first-with-text
 * with its stored reasons, and the two ways a worker stands down (ticket 0553).
 *
 * The back-off has its own file; what is asserted here is everything the ticket's
 * Verification section names, each with the arm that could come out the other way.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const START = 1_700_000_000_000;

interface Harness {
  clock: ManualClock;
  ledger: Ledger;
  replay: ReplayLocalApi;
  stage: ExtractStage;
  lib: number;
}

function ledgerHarness(): Harness {
  const clock = new ManualClock(START);
  const ledger = Ledger.open(':memory:', clock);
  const oid = ledger.registerOrigin('synthetic-server');
  const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
  const replay = new ReplayLocalApi({ clock });
  return { clock, ledger, replay, stage: new ExtractStage({ ledger, clock }), lib };
}

function worker(h: Harness, opts: { guard?: WorkerOrphanGuard; activity?: ActivityGate } = {}): ExtractWorker {
  return new ExtractWorker({
    dispatcher: h.stage,
    source: h.replay.client(),
    clock: h.clock,
    sleep: async (ms: number) => {
      h.clock.advance(ms);
    },
    ...opts,
  });
}

/** An attachment with cached text, its item, and the body order the tick would have written. */
function stageAttachment(
  h: Harness,
  opts: { item: string; attachment: string; dateAdded: string; text: string; totalPages?: number },
): void {
  if (!h.ledger.itemDetail(h.lib, opts.item)) {
    h.ledger.putItemDetail(h.lib, opts.item, {
      dateAdded: opts.dateAdded,
      itemType: 'journalArticle',
      parentItem: null,
    });
  }
  h.ledger.putItemDetail(h.lib, opts.attachment, {
    dateAdded: opts.dateAdded,
    itemType: 'attachment',
    parentItem: opts.item,
  });
  h.ledger.putFulltextCensus(h.lib, [[opts.attachment, { ftVersion: 1, itemVersion: 1 }]]);
  h.ledger.enqueue({
    lib: h.lib,
    class: 'body',
    op: 'index',
    attachmentKey: opts.attachment,
    itemKey: opts.item,
    dateAdded: opts.dateAdded,
    signal: 'fulltext:1|item:1',
  });
  h.replay.put(`/users/0/items/${opts.attachment}/fulltext`, {
    body: { content: opts.text, indexedPages: 2, totalPages: opts.totalPages ?? 2 },
  });
}

// --------------------------------------------------------------- class order

describeSqlite('extract dispatch: the class order is the query', () => {
  function tickHarness(): Harness & { tick: ReconcileTick; library: SyntheticLibrary } {
    const h = ledgerHarness();
    const library = new SyntheticLibrary();
    library.assertInvariants();
    library.install(h.replay);
    const tick = new ReconcileTick({ ledger: h.ledger, signals: h.replay.client(), clock: h.clock });
    return { ...h, tick, library };
  }

  it('offers no document while the item still owes its record', async () => {
    const h = tickHarness();
    await h.tick.runOnce(h.lib);

    // Every item's metadata order is pending, so nothing is extractable yet — which is
    // §5.2.3's promise stated as a query rather than as a convention the worker follows.
    expect(h.ledger.pending(h.lib).some((r) => r.class === 'body')).toBe(true);
    expect(h.ledger.nextExtractOrder({ lib: h.lib })).toBeUndefined();

    for (const row of h.ledger.pending(h.lib)) if (row.class !== 'body') h.ledger.markDone(row.wid);
    expect(h.ledger.nextExtractOrder({ lib: h.lib })?.class).toBe('body');
    h.ledger.close();
  });

  it('is per item, not a global order: one item finishing its record unblocks only that item', async () => {
    // This is the arm a global ORDER BY cannot pass. Under a global reading nothing is
    // extractable while ANY record is pending, so the assertion below would find undefined;
    // under a per-item reading exactly ITEM0001's attachment is offered. The two differ
    // here and nowhere else, which is why the previous test is not enough on its own.
    const h = tickHarness();
    await h.tick.runOnce(h.lib);

    const record = h.ledger.pending(h.lib).find((r) => r.class === 'metadata' && r.itemKey === 'ITEM0001');
    expect(record).toBeDefined();
    h.ledger.markDone(record!.wid);

    const next = h.ledger.nextExtractOrder({ lib: h.lib });
    expect(next?.attachmentKey).toBe('ATTA0001');
    expect(next?.itemKey).toBe('ITEM0001');
    h.ledger.close();
  });

  it('counts a claimed record as still owed', async () => {
    // In flight is not durable. A body fetch racing the record write of its own item would
    // satisfy the ordering only if the record commit wins, which is not a promise anyone
    // made.
    const h = tickHarness();
    await h.tick.runOnce(h.lib);
    const record = h.ledger.pending(h.lib).find((r) => r.class === 'metadata' && r.itemKey === 'ITEM0001');
    h.ledger.claim(record!.wid, 'someone', 'sig', 30_000);

    expect(h.ledger.nextExtractOrder({ lib: h.lib })).toBeUndefined();
    h.ledger.markDone(record!.wid);
    expect(h.ledger.nextExtractOrder({ lib: h.lib })?.attachmentKey).toBe('ATTA0001');
    h.ledger.close();
  });

  it('per item, no body text is extracted before that item has its record', async () => {
    // The ticket's own verification line, asserted over a whole interleaved run rather than
    // over one crafted moment: records are completed one at a time while the worker drains,
    // and every document it fetches must belong to an item already recorded.
    const h = tickHarness();
    await h.tick.runOnce(h.lib);
    const recorded = new Set<string>();
    const violations: string[] = [];
    let fetched = 0;

    for (;;) {
      const w = worker(h);
      w.onWindow = (): void => {};
      w.onDocument = (doc): void => {
        fetched++;
        const item = h.ledger.extractState(h.lib, doc.attachmentKey)?.itemKey ?? null;
        if (item && !recorded.has(item)) violations.push(`${doc.attachmentKey} before ${item}`);
      };
      const before = h.ledger.pending(h.lib).length;
      await w.drain();

      const record = h.ledger.pending(h.lib).find((r) => r.class !== 'body');
      if (!record) break;
      h.ledger.markDone(record.wid);
      if (record.itemKey) recorded.add(record.itemKey);
      if (h.ledger.pending(h.lib).length >= before) continue;
    }

    expect(violations).toEqual([]);
    // Without this the assertion above is satisfied by a run that fetched nothing, which is
    // also what a broken dispatch, an empty queue and a wrong library all produce.
    expect(fetched).toBeGreaterThan(10);
    expect(recorded.size).toBeGreaterThan(0);
    h.ledger.close();
  });
});

// ------------------------------------------------------------ first-with-text

describeSqlite('extract dispatch: D6, first-with-text', () => {
  it('chooses the oldest attachment with text and stores a reason for every other', async () => {
    const h = ledgerHarness();
    stageAttachment(h, {
      item: 'ITEM0001',
      attachment: 'ATTAOLD1',
      dateAdded: '2020-01-01T00:00:00Z',
      text: 'The older scan.',
    });
    stageAttachment(h, {
      item: 'ITEM0001',
      attachment: 'ATTANEW1',
      dateAdded: '2024-01-01T00:00:00Z',
      text: 'A different, newer copy.',
    });

    const report = await worker(h).drain();

    // One item, one document: the suppressed attachment is decided from the census and
    // never fetched, which is the whole economy of first-with-text.
    expect(report.documents).toBe(1);
    expect(h.replay.requests.filter((r) => r.key.includes('/fulltext'))).toHaveLength(1);
    expect(h.replay.requests[0]!.key).toContain('ATTAOLD1');

    const choices = h.ledger.attachmentChoices(h.lib, 'ITEM0001');
    expect(choices.find((c) => c.attachmentKey === 'ATTAOLD1')).toMatchObject({ chosen: true, reason: null });
    expect(choices.find((c) => c.attachmentKey === 'ATTANEW1')?.chosen).toBe(false);
    expect(choices.find((c) => c.attachmentKey === 'ATTANEW1')?.reason).toBe('not-first-with-text');

    // And both orders left the queue: a suppressed row that stayed pending would be
    // re-offered every tick forever.
    expect(h.ledger.pending(h.lib)).toEqual([]);
    h.ledger.close();
  });

  it('breaks a dateAdded tie on the attachment key', async () => {
    const h = ledgerHarness();
    const same = '2021-06-01T00:00:00Z';
    stageAttachment(h, { item: 'ITEM0002', attachment: 'ATTAZZZZ', dateAdded: same, text: 'zed' });
    stageAttachment(h, { item: 'ITEM0002', attachment: 'ATTAAAAA', dateAdded: same, text: 'aye' });

    await worker(h).drain();
    expect(h.ledger.attachmentChoice(h.lib, 'ATTAAAAA')?.chosen).toBe(true);
    expect(h.ledger.attachmentChoice(h.lib, 'ATTAZZZZ')?.chosen).toBe(false);
    h.ledger.close();
  });

  it('re-derives the choice when a later extraction gives an earlier attachment text', async () => {
    // D6's own clause. The newer attachment is the only one with text, so it is chosen and
    // read; then Zotero extracts the older one, the choice moves to it, and the sibling
    // that used to carry the body text acquires a reason — this time one of the two §5.2.3
    // names, because both hashes now exist.
    const h = ledgerHarness();
    const text = 'Identical bytes in both copies.';
    stageAttachment(h, {
      item: 'ITEM0003',
      attachment: 'ATTANEW3',
      dateAdded: '2024-01-01T00:00:00Z',
      text,
    });
    await worker(h).drain();
    expect(h.ledger.attachmentChoice(h.lib, 'ATTANEW3')?.chosen).toBe(true);

    stageAttachment(h, {
      item: 'ITEM0003',
      attachment: 'ATTAOLD3',
      dateAdded: '2020-01-01T00:00:00Z',
      text,
    });
    await worker(h).drain();

    expect(h.ledger.attachmentChoice(h.lib, 'ATTAOLD3')?.chosen).toBe(true);
    expect(h.ledger.attachmentChoice(h.lib, 'ATTANEW3')).toMatchObject({
      chosen: false,
      reason: 'identical-text',
    });
    h.ledger.close();
  });

  it('says different-text when it has read both and they differ', async () => {
    const h = ledgerHarness();
    stageAttachment(h, { item: 'ITEM0004', attachment: 'ATTANEW4', dateAdded: '2024-01-01T00:00:00Z', text: 'one' });
    await worker(h).drain();
    stageAttachment(h, { item: 'ITEM0004', attachment: 'ATTAOLD4', dateAdded: '2020-01-01T00:00:00Z', text: 'two' });
    await worker(h).drain();

    expect(h.ledger.attachmentChoice(h.lib, 'ATTANEW4')?.reason).toBe('different-text');
    h.ledger.close();
  });

  it('cannot store a skipped attachment without a reason, or a chosen one with one', () => {
    // The CHECK, not a convention. "Not indexed, no reason recorded" is the state D6 exists
    // to forbid, and a constraint is the only thing that forbids it for code not yet written.
    const h = ledgerHarness();
    h.ledger.putItemDetail(h.lib, 'ITEM0005', { dateAdded: null, itemType: 'book', parentItem: null });
    expect(() =>
      h.ledger.db
        .prepare(
          `INSERT INTO attachment_choice(lib, attachment_key, item_key, chosen, reason, decided_at)
             VALUES (?, 'ATTABAD1', 'ITEM0005', 0, NULL, 0)`,
        )
        .run(h.lib),
    ).toThrow();
    expect(() =>
      h.ledger.db
        .prepare(
          `INSERT INTO attachment_choice(lib, attachment_key, item_key, chosen, reason, decided_at)
             VALUES (?, 'ATTABAD2', 'ITEM0005', 1, 'different-text', 0)`,
        )
        .run(h.lib),
    ).toThrow();
    h.ledger.close();
  });
});

// ------------------------------------------------------- the extract's own row

describeSqlite('extract bookkeeping: what the conductor writes', () => {
  it('stores the key, the tool identity and the truncation flag', async () => {
    const h = ledgerHarness();
    stageAttachment(h, {
      item: 'ITEM0006',
      attachment: 'ATTA0006',
      dateAdded: '2022-01-01T00:00:00Z',
      text: 'Twelve pages of forty.',
      totalPages: 40,
    });

    await worker(h).drain();
    const state = h.ledger.extractState(h.lib, 'ATTA0006');
    expect(state).toMatchObject({
      itemKey: 'ITEM0006',
      extractor: EXTRACTOR_ID,
      truncated: true,
      empty: false,
      indexedPages: 2,
      totalPages: 40,
    });
    expect(state!.textHash).toMatch(/^[0-9a-f]{64}$/);
    h.ledger.close();
  });

  it('records a 404 as empty rather than as failed, and stops re-offering it', async () => {
    const h = ledgerHarness();
    stageAttachment(h, { item: 'ITEM0007', attachment: 'ATTA0007', dateAdded: '2022-01-01T00:00:00Z', text: 'x' });
    h.replay.clear();
    h.replay.strict = false;

    const report = await worker(h).drain();
    expect(report.emptyDocuments).toBe(1);
    expect(report.failures).toBe(0);
    expect(h.ledger.extractState(h.lib, 'ATTA0007')).toMatchObject({ empty: true, textHash: null });
    expect(h.ledger.pending(h.lib)).toEqual([]);
    h.ledger.close();
  });

  it('marks the order failed when Zotero is unreachable, and leaves no extract row', async () => {
    // The opposite bookkeeping to the 404 above, from the same call site. Collapsing the two
    // would mark a library metadata-only the next time the desktop app was closed mid-build.
    const h = ledgerHarness();
    stageAttachment(h, { item: 'ITEM0008', attachment: 'ATTA0008', dateAdded: '2022-01-01T00:00:00Z', text: 'x' });
    h.replay.silent = true;

    const report = await worker(h).drain();
    expect(report.failures).toBe(1);
    expect(report.emptyDocuments).toBe(0);
    expect(h.ledger.extractState(h.lib, 'ATTA0008')).toBeUndefined();
    expect(h.ledger.row(1)?.status).toBe('failed');
    h.ledger.close();
  });

  it('finds the rows a shim replacement made stale, and only those', () => {
    const h = ledgerHarness();
    h.ledger.putExtractState(h.lib, {
      attachmentKey: 'ATTAOLDX',
      extractor: 'zotero-local-cache/0',
      chars: 10,
      truncated: false,
      empty: false,
    });
    h.ledger.putExtractState(h.lib, {
      attachmentKey: 'ATTANEWX',
      extractor: EXTRACTOR_ID,
      chars: 10,
      truncated: false,
      empty: false,
    });

    expect(h.ledger.staleExtracts(h.lib, EXTRACTOR_ID).map((r) => r.attachmentKey)).toEqual(['ATTAOLDX']);
    // The control: against its own identity nothing is stale, so a shim that changed
    // nothing observable and declined to bump costs no re-extraction.
    expect(h.ledger.staleExtracts(h.lib, 'zotero-local-cache/0').map((r) => r.attachmentKey)).toEqual(['ATTANEWX']);
    h.ledger.close();
  });
});

// ------------------------------------------------------------- standing down

describeSqlite('extract worker: the two ways it stands down', () => {
  function queued(h: Harness, n: number): void {
    for (let i = 1; i <= n; i++) {
      stageAttachment(h, {
        item: `ITEM${String(i).padStart(4, '0')}`,
        attachment: `ATTA${String(i).padStart(4, '0')}`,
        dateAdded: `2022-01-${String(i).padStart(2, '0')}T00:00:00Z`,
        text: `Text ${i}`,
      });
    }
  }

  function guardFor(h: Harness, parent: string, stdin: EventEmitter): WorkerOrphanGuard {
    const guard = new WorkerOrphanGuard({
      parent,
      readHolder: leaseHolderReader(h.ledger),
      clock: h.clock,
      onOrphaned: () => {},
    });
    guard.watchPipe(stdin as unknown as { once(event: string, listener: () => void): unknown });
    return guard;
  }

  function elect(h: Harness, holder: string): void {
    h.ledger.db
      .prepare('UPDATE leases SET holder = ?, expires_at = ? WHERE name = ?')
      .run(holder, h.clock.now() + 20_000, CONDUCTOR_LEASE);
  }

  it('control: parented and with a live lease, it drains the whole queue', async () => {
    const h = ledgerHarness();
    queued(h, 5);
    elect(h, 'parent-uuid');
    const report = await worker(h, { guard: guardFor(h, 'parent-uuid', new EventEmitter()) }).drain();

    expect(report.stopped).toBe('drained');
    expect(report.documents).toBe(5);
    h.ledger.close();
  });

  it('stops on stdin EOF, leaving the rest of the queue for the successor', async () => {
    const h = ledgerHarness();
    queued(h, 5);
    elect(h, 'parent-uuid');
    const stdin = new EventEmitter();
    const guard = guardFor(h, 'parent-uuid', stdin);

    const w = worker(h, { guard });
    w.onDocument = (_doc, seen): void => {
      if (seen === 2) stdin.emit('end');
    };
    const report = await w.drain();

    expect(report.stopped).toBe('orphaned');
    expect(report.orphanReason).toBe('pipe-closed');
    expect(report.documents).toBe(2);
    // Nothing is lost: the unread rows are still pending for whoever the new conductor
    // spawns, which is what makes killing a worker cheap.
    expect(h.ledger.pending(h.lib).length).toBe(3);
    h.ledger.close();
  });

  it('stops when the lease moves to another P0, even with the pipe wide open', async () => {
    // The repair the pipe cannot make. A conductor that is SIGSTOP'd or thrashing closes no
    // pipe and runs no cleanup, so only a check scheduled in this process fires.
    const h = ledgerHarness();
    queued(h, 5);
    elect(h, 'parent-uuid');
    const guard = guardFor(h, 'parent-uuid', new EventEmitter());

    const w = worker(h, { guard });
    w.onDocument = (_doc, seen): void => {
      if (seen === 2) elect(h, 'successor-uuid');
      // The poll is due-driven, so time has to pass for it to be asked at all.
      h.clock.advance(guard.cadenceMs);
    };
    const report = await w.drain();

    expect(report.stopped).toBe('orphaned');
    expect(report.orphanReason).toBe('lease-lost');
    expect(report.documents).toBe(2);
    h.ledger.close();
  });
});

// -------------------------------------------------------------- foreground

describeSqlite('extract worker: foreground preemption', () => {
  it('idles between documents while a query is fresh, and not otherwise', async () => {
    const h = ledgerHarness();
    for (let i = 1; i <= 3; i++) {
      stageAttachment(h, {
        item: `ITEM${String(i).padStart(4, '0')}`,
        attachment: `ATTA${String(i).padStart(4, '0')}`,
        dateAdded: `2022-01-0${i}T00:00:00Z`,
        text: `Text ${i}`,
      });
    }

    let touchedAt: number | null = null;
    const gate = new ActivityGate({ probe: { lastTouchedAt: () => touchedAt }, clock: h.clock, idleMs: 2_000 });
    const w = worker(h, { activity: gate });
    w.onDocument = (_doc, seen): void => {
      if (seen === 1) touchedAt = h.clock.now();
    };

    const quiet = await worker(h, { activity: gate }).drain();
    expect(quiet.activityYields).toBe(0);

    // Re-queue and run again, this time with a query landing after the first document.
    for (let i = 1; i <= 3; i++) {
      h.ledger.enqueue({
        lib: h.lib,
        class: 'body',
        op: 'index',
        attachmentKey: `ATTA${String(i).padStart(4, '0')}`,
        itemKey: `ITEM${String(i).padStart(4, '0')}`,
        signal: 'fulltext:2|item:2',
      });
    }
    const report = await w.drain();

    expect(report.activityYields).toBeGreaterThan(0);
    // It stands aside for the remainder of the window, never for the whole window again:
    // a slow trickle of queries would otherwise pause indexing indefinitely.
    expect(report.totalYieldMs).toBeLessThanOrEqual(2_000);
    expect(report.documents).toBe(3);
    h.ledger.close();
  });
});

// ------------------------------------------------------------ run to drain

describeSqlite('extract worker: spawned on queue work, drains, gone', () => {
  function queue(h: Harness, i: number): void {
    stageAttachment(h, {
      item: `ITEM${String(i).padStart(4, '0')}`,
      attachment: `ATTA${String(i).padStart(4, '0')}`,
      dateAdded: `2022-01-${String(i).padStart(2, '0')}T00:00:00Z`,
      text: `Text ${i}`,
    });
  }

  function conductorWith(h: Harness): { conductor: Conductor; spawns: ExtractWorkerControl[] } {
    const spawns: ExtractWorkerControl[] = [];
    const conductor = new Conductor({
      ledger: h.ledger,
      clock: h.clock,
      holder: 'p0-one',
      pipeline: {
        hasWork: () => h.ledger.nextExtractOrder({ lib: h.lib }) !== undefined,
        spawn: () => {
          const control = new ExtractWorkerControl(worker(h));
          spawns.push(control);
          return control;
        },
      },
    });
    return { conductor, spawns };
  }

  it('starts one on an idle pass with work, and none on an idle pass without', async () => {
    const h = ledgerHarness();
    const { conductor, spawns } = conductorWith(h);

    const empty = await conductor.poll();
    expect(empty.role).toBe('conductor');
    // Steady state contains no pipeline worker at all: with nothing queued, none is started.
    expect(empty.workerSpawned).toBeUndefined();
    expect(spawns).toHaveLength(0);

    queue(h, 1);
    queue(h, 2);
    const busy = await conductor.poll();
    expect(busy.workerSpawned).toBe(true);
    expect(spawns).toHaveLength(1);

    // It drains and is gone; the next pass over an empty queue starts nothing.
    const report = await spawns[0]!.finished;
    expect(report.stopped).toBe('drained');
    expect(report.documents).toBe(2);
    expect(spawns[0]!.alive()).toBe(false);

    const after = await conductor.poll();
    expect(after.workerSpawned).toBeUndefined();
    expect(after.workerAlive).toBe(false);
    expect(spawns).toHaveLength(1);
    h.ledger.close();
  });

  it('never runs two: a second pass with work still queued does not start another', async () => {
    // The bound §5.2.5 states is one worker per P0, and the queue is refilled under a live
    // one here precisely so the "there is work" branch is taken while a worker exists — the
    // arm that separates "one at a time" from "one per pass with work".
    //
    // A stub rather than a real drain, because liveness is the whole subject: a real one
    // finishes on whichever microtask it happens to finish on, so the test would be asking
    // the conductor a question whose answer the scheduler had already changed.
    const h = ledgerHarness();
    const spawns: Array<{ alive: boolean; killed?: string }> = [];
    const conductor = new Conductor({
      ledger: h.ledger,
      clock: h.clock,
      holder: 'p0-one',
      pipeline: {
        hasWork: () => h.ledger.nextExtractOrder({ lib: h.lib }) !== undefined,
        spawn: () => {
          const state = { alive: true } as { alive: boolean; killed?: string };
          spawns.push(state);
          return {
            kill: (reason: string): void => {
              state.killed = reason;
              state.alive = false;
            },
            alive: () => state.alive,
          };
        },
      },
    });

    queue(h, 1);
    expect((await conductor.poll()).workerSpawned).toBe(true);
    queue(h, 2);
    expect((await conductor.poll()).workerSpawned).toBeUndefined();
    expect(spawns).toHaveLength(1);

    // And the deposition ordering tranche 2 built the call site for now has something
    // behind it: standing down kills the live worker rather than leaving it to expire.
    conductor.standDown();
    expect(spawns[0]!.killed).toBe('standing down');
    // And a P0 that has stood down is a follower: it starts nothing, however much work is
    // queued, because the successor's worker is the one that should be draining it.
    expect((await conductor.poll()).role).toBe('follower');
    expect(spawns).toHaveLength(1);
    h.ledger.close();
  });

  it('a killed worker stops at the next document, leaving the rest queued', async () => {
    // What `ExtractWorkerControl.kill` does to a running drain, driven from inside the run
    // so it lands at a known point rather than at whichever one the scheduler picks.
    const h = ledgerHarness();
    for (let i = 1; i <= 5; i++) queue(h, i);
    const w = worker(h);
    const control = new ExtractWorkerControl(w);
    w.onDocument = (_doc, seen): void => {
      if (seen === 2) control.kill('deposed');
    };

    const report = await control.finished;
    expect(report.stopped).toBe('killed');
    expect(report.orphanReason).toBe('deposed');
    expect(report.documents).toBe(2);
    expect(control.alive()).toBe(false);
    // Nothing is lost, exactly as on an orphaning: the rest are still owed.
    expect(h.ledger.pending(h.lib).length).toBe(3);
    h.ledger.close();
  });
});

// ---------------------------------------------------------------- priority

describe('extract worker: the OS floor', () => {
  it('asks for minimum CPU priority and for an idle I/O class on Linux', () => {
    const calls: Array<[string, string[]]> = [];
    let niced: number | undefined;
    const report = lowerWorkerPriority({
      platform: 'linux',
      pid: 4242,
      setPriority: (_pid, value) => {
        niced = value;
      },
      run: (cmd, args) => {
        calls.push([cmd, args]);
        return { status: 0 };
      },
    });

    expect(niced).toBe(WORKER_NICE);
    expect(report.cpu.applied).toBe(true);
    expect(calls).toEqual([['ionice', ['-c', '3', '-p', '4242']]]);
    expect(report.io.applied).toBe(true);
  });

  it('reports the I/O class as unavailable off Linux rather than claiming it', () => {
    // "Best effort elsewhere" is the ruling's wording, and an outcome that says which
    // platform declined is what keeps the panel's I/O claim honest on a Mac.
    const report = lowerWorkerPriority({ platform: 'darwin', setPriority: () => {}, run: () => ({ status: 0 }) });
    expect(report.cpu.applied).toBe(true);
    expect(report.io.applied).toBe(false);
    expect(report.io.detail).toContain('darwin');
  });

  it('survives a container that forbids renicing', () => {
    // The strong guarantee is the CPU one, and it is still only a scheduling hint: a worker
    // that refused to start over it would trade the whole pipeline for politeness.
    const report = lowerWorkerPriority({
      platform: 'linux',
      setPriority: () => {
        throw new Error('EPERM');
      },
      run: () => ({ status: 1 }),
    });
    expect(report.cpu.applied).toBe(false);
    expect(report.cpu.detail).toContain('EPERM');
    expect(report.io.applied).toBe(false);
  });
});
