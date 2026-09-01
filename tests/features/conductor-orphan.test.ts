import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Conductor } from '../../src/features/search/conductor/conductor.js';
import { ELECTION_CADENCE_MS, HEARTBEAT_MS, Lease, LEASE_TTL_MS } from '../../src/features/search/conductor/lease.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import {
  leaseHolderReader,
  watchParentEof,
  WorkerOrphanGuard,
  type OrphanReason,
  type WorkerControl,
} from '../../src/features/search/conductor/orphan.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * Orphan repair: the two worker-side checks and the conductor-side kill (SPEC.md §5.2.5).
 *
 * The spec's claim is specific and is what these tests are for: "Both together enforce
 * the one-worker bound; either alone has a hole." A suite that only showed each repair
 * working would leave that claim unexamined, and the composition looking like belt and
 * braces rather than like two covers over two different failures. So each repair is run
 * *alone* against the failure the other one covers, and each is shown to miss it.
 *
 * The pipeline worker itself is a later tranche's. What is built here is the machinery it
 * calls — a pipe watch, a holder poll on the injected clock, and the handle a deposed P0
 * kills — which is why the worker below is a fake with a kill counter rather than a
 * process. That bound is stated in the ticket rather than papered over.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const START = 1_700_000_000_000;

class FakeWorker implements WorkerControl {
  readonly kills: string[] = [];
  private running = true;

  kill(reason: string): void {
    if (!this.running) return;
    this.running = false;
    this.kills.push(reason);
  }

  alive(): boolean {
    return this.running;
  }
}

/** Stands in for `process.stdin`: `once` is the whole of what the watch subscribes to. */
class FakePipe extends EventEmitter {
  /** The far side closed politely: `end` then `close`. */
  closePolitely(): void {
    this.emit('end');
    this.emit('close');
  }

  /** The far side was torn down: `close` alone, with no `end` before it. */
  tearDown(): void {
    this.emit('close');
  }
}

describe('orphan repair (a): the pipe', () => {
  it('stands the worker down on a polite close and on a teardown alike', () => {
    for (const how of ['polite', 'teardown'] as const) {
      const pipe = new FakePipe();
      const reasons: OrphanReason[] = [];
      watchParentEof({ stdin: pipe, onParentGone: (r) => reasons.push(r) });
      if (how === 'polite') pipe.closePolitely();
      else pipe.tearDown();
      expect(reasons).toEqual(['pipe-closed']);
    }
  });

  it('fires once, however many events the pipe emits', () => {
    const pipe = new FakePipe();
    const reasons: OrphanReason[] = [];
    watchParentEof({ stdin: pipe, onParentGone: (r) => reasons.push(r) });
    pipe.closePolitely();
    pipe.closePolitely();
    expect(reasons).toHaveLength(1);
  });
});

describeSqlite('orphan repair (b): the holder poll', () => {
  function fixture(): { clock: ManualClock; ledger: Ledger; parent: Lease; guard: WorkerOrphanGuard; seen: OrphanReason[] } {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const parent = new Lease({ ledger, clock, holder: 'uuid-parent' });
    parent.take();
    const seen: OrphanReason[] = [];
    const guard = new WorkerOrphanGuard({
      parent: parent.holder,
      readHolder: leaseHolderReader(ledger),
      clock,
      onOrphaned: (r) => seen.push(r),
    });
    return { clock, ledger, parent, guard, seen };
  }

  it('keeps working while the row still names its parent', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) {
      f.clock.advance(HEARTBEAT_MS);
      f.parent.take();
      expect(f.guard.checkParent()).toBe(true);
    }
    expect(f.seen).toEqual([]);
    f.ledger.close();
  });

  it('stands down when the row names somebody else', () => {
    const f = fixture();
    f.clock.advance(LEASE_TTL_MS + 1);
    new Lease({ ledger: f.ledger, clock: f.clock, holder: 'uuid-successor' }).take();

    expect(f.guard.checkParent()).toBe(false);
    expect(f.seen).toEqual(['lease-lost']);
    // Once, not once per micro-batch: a worker that has stood down keeps answering false
    // without firing again.
    expect(f.guard.checkParent()).toBe(false);
    expect(f.seen).toHaveLength(1);
    expect(f.guard.orphanedAlready).toBe(true);
    f.ledger.close();
  });

  it('polls on its own cadence, between micro-batches and not inside one', () => {
    const f = fixture();
    expect(f.guard.checkParentIfDue()).toBe(true);
    f.clock.advance(HEARTBEAT_MS - 1);
    // A worker asking more often than the cadence gets nothing back and pays nothing.
    expect(f.guard.checkParentIfDue()).toBeUndefined();
    f.clock.advance(1);
    expect(f.guard.checkParentIfDue()).toBe(true);
    f.ledger.close();
  });

  it('fires once when both repairs notice the same departure', () => {
    const f = fixture();
    const pipe = new FakePipe();
    f.guard.watchPipe(pipe);
    f.clock.advance(LEASE_TTL_MS + 1);
    new Lease({ ledger: f.ledger, clock: f.clock, holder: 'uuid-successor' }).take();

    expect(f.guard.checkParent()).toBe(false);
    pipe.closePolitely();
    expect(f.seen).toEqual(['lease-lost']);
    f.ledger.close();
  });
});

describeSqlite('orphan repair: either half alone leaves a hole', () => {
  /**
   * §5.2.5 names both cases. These are them, each run against the repair that cannot see
   * it — which is what turns "both together" from a design sentence into a tested claim.
   */
  it('the pipe alone misses a wedged parent: SIGSTOP closes nothing', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const parent = new Lease({ ledger, clock, holder: 'uuid-parent' });
    parent.take();
    const pipe = new FakePipe();

    // The parent is frozen through a migration. It closes no pipe and runs no cleanup, so
    // nothing at all is emitted; meanwhile its row runs out and a successor takes it.
    const pipeOnly: OrphanReason[] = [];
    watchParentEof({ stdin: pipe, onParentGone: (r) => pipeOnly.push(r) });
    clock.advance(LEASE_TTL_MS + 1);
    new Lease({ ledger, clock, holder: 'uuid-successor' }).take();

    expect(pipeOnly).toEqual([]); // the hole
    // The poll is what fires, and it is why the worker-side check was kept rather than
    // replaced by the pipe when the design collapsed three workers into one.
    const pollSeen: OrphanReason[] = [];
    const guard = new WorkerOrphanGuard({
      parent: parent.holder,
      readHolder: leaseHolderReader(ledger),
      clock,
      onOrphaned: (r) => pollSeen.push(r),
    });
    expect(guard.checkParent()).toBe(false);
    expect(pollSeen).toEqual(['lease-lost']);
    ledger.close();
  });

  it('the poll alone misses a dead parent whose row has not run out yet', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const parent = new Lease({ ledger, clock, holder: 'uuid-parent' });
    parent.take();

    const pollSeen: OrphanReason[] = [];
    const guard = new WorkerOrphanGuard({
      parent: parent.holder,
      readHolder: leaseHolderReader(ledger),
      clock,
      onOrphaned: (r) => pollSeen.push(r),
    });

    // `kill -9` the parent. Its row stays valid for the rest of the TTL, so the poll —
    // which asks who holds the row, not whether the parent breathes — keeps answering
    // "still parented" for up to 20 s while the process it is parented to is gone.
    clock.advance(HEARTBEAT_MS);
    expect(guard.checkParent()).toBe(true);
    expect(pollSeen).toEqual([]); // the hole

    // The pipe closed the instant the process died, which is what retires the orphan now
    // instead of at the end of the TTL.
    const pipe = new FakePipe();
    guard.watchPipe(pipe);
    pipe.closePolitely();
    expect(guard.orphanedAlready).toBe(true);
    ledger.close();
  });
});

describeSqlite('orphan repair: the conductor side', () => {
  it('kills the worker on a deliberate stand-down as well as on a deposition', async () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const worker = new FakeWorker();
    const c = new Conductor({ ledger, clock, worker });
    await c.poll();
    expect(c.isConductor()).toBe(true);

    c.standDown();
    expect(c.isConductor()).toBe(false);
    expect(worker.kills).toEqual(['standing down']);
    // The row is free immediately rather than at the end of the TTL, which is the whole
    // benefit of standing down: the successor waits one cadence, not one TTL plus one.
    expect(ledger.lease('conductor')?.holder).toBeNull();
    ledger.close();
  });

  it('never leaves two workers behind when the handle is replaced', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const first = new FakeWorker();
    const second = new FakeWorker();
    const c = new Conductor({ ledger, clock, worker: first });

    c.attachWorker(second);
    expect(first.alive()).toBe(false);
    expect(first.kills).toEqual(['replaced']);
    expect(second.alive()).toBe(true);
    // The one-worker bound is per conductor, and this is the only place the handle moves.
    ledger.close();
  });

  it('positive control: a cadence above the TTL leaves the orphan running', async () => {
    /**
     * The conductor-side kill is driven by the election check, so the cadence is not only
     * a latency knob — it is how long an orphan survives its parent's deposition. This
     * runs the same scenario twice, once at §5.2.5's constants and once at a cadence
     * mis-set above the TTL, and the second one leaves the worker alive.
     *
     * It is what makes the deposition assertions above sharp. Every one of them polls
     * after advancing past the cadence, so all of them would pass unchanged against a
     * server that checked once an hour — and against that server the bound the repairs
     * exist to enforce is an hour.
     */
    const scenario = async (cadenceMs: number): Promise<{ aliveAfter: boolean; killedAt?: number }> => {
      const clock = new ManualClock(START);
      const ledger = Ledger.open(':memory:', clock);
      const worker = new FakeWorker();
      const c = new Conductor({ ledger, clock, worker, cadenceMs });
      await c.poll();

      // The parent is wedged for longer than the TTL and a rival takes the row. Nothing
      // has closed a pipe: this P0 is running, and only its own check can notice.
      clock.advance(LEASE_TTL_MS + 1);
      new Lease({ ledger, clock, holder: 'uuid-rival' }).take();

      let killedAt: number | undefined;
      for (let step = 0; step < 40 && killedAt === undefined; step++) {
        if ((await c.poll()).workerKilled) killedAt = clock.now();
        clock.advance(1_000);
      }
      const aliveAfter = worker.alive();
      ledger.close();
      return { aliveAfter, killedAt };
    };

    const ratified = await scenario(ELECTION_CADENCE_MS);
    expect(ratified.aliveAfter).toBe(false);
    // The row moved at TTL + 1 ms; the check that notices is at most one cadence later.
    expect((ratified.killedAt as number) - (START + LEASE_TTL_MS + 1)).toBeLessThanOrEqual(ELECTION_CADENCE_MS);

    const mistuned = await scenario(60 * 60_000);
    expect(mistuned.aliveAfter).toBe(true);
    expect(mistuned.killedAt).toBeUndefined();
  });
});
