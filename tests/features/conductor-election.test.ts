import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Conductor } from '../../src/features/search/conductor/conductor.js';
import { ConductorElection } from '../../src/features/search/conductor/election.js';
import {
  CONDUCTOR_LEASE,
  ELECTION_CADENCE_MS,
  HEARTBEAT_MS,
  Lease,
  LEASE_MIGRATION_BOUND_MS,
  LEASE_TTL_MS,
} from '../../src/features/search/conductor/lease.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import type { WorkerControl } from '../../src/features/search/conductor/orphan.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * Tranche 2: N × P0 elect exactly one conductor through the lease row (SPEC.md §5.2.5).
 *
 * The statement itself, and its CAS guard, are `conductor-lease.test.ts`. This file is
 * what several servers do with it: who wins, who is deposed, and how long a handover
 * takes when the winner is killed.
 *
 * **Separate connections on one file, not one handle shared.** The deployment these tests
 * stand in for is several zoteus processes on one fixed data directory, and the property
 * under test is what SQLite does when two of them write the same row. A suite that gave
 * every candidate the same `Ledger` would be testing a program, not a protocol: it could
 * not distinguish the ratified statement from one that merely happens to work when there
 * is nothing to race. So each candidate opens its own connection to a real file on disk.
 *
 * **What "exactly one conductor" can honestly mean.** It is not a claim about beliefs.
 * §5.2.5 says the opposite in as many words — "during a handover two P0s can each believe
 * they are conductor" — which is why the CAS commit guard exists at all. A wedged holder
 * that has stopped renewing still thinks it is the conductor, and no protocol run inside
 * that process can tell it otherwise. Two things *are* true and both are asserted here:
 * at most one *running* P0 believes it, and the row admits exactly one writer whatever
 * anybody believes.
 *
 * **Virtual time throughout.** Nothing sleeps: a takeover bound of TTL + cadence is a
 * statement about *when*, and a suite that waited 30 s could only report that it happened
 * eventually — and would cost 30 s per assertion to say so.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const START = 1_700_000_000_000;
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A real directory on disk, so "two P0s on one data directory" is what it says. */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-conductor-'));
  dirs.push(dir);
  return dir;
}

class FakeWorker implements WorkerControl {
  readonly kills: string[] = [];
  private running = true;

  kill(reason: string): void {
    // Idempotent by the interface's contract: deposition and shutdown both reach it.
    if (!this.running) return;
    this.running = false;
    this.kills.push(reason);
  }

  alive(): boolean {
    return this.running;
  }
}

interface Member {
  name: string;
  ledger: Ledger;
  conductor: Conductor;
  worker: FakeWorker;
  alive: boolean;
  /** When this member last renewed successfully, for the migration-bound arithmetic. */
  lastRenewAt: number;
}

class Cluster {
  readonly clock = new ManualClock(START);
  readonly path: string;
  readonly members: Member[] = [];
  /** One entry per polled instant: the row's holder, and who believed they held it. */
  readonly timeline: Array<{ at: number; holder: string | null; believers: string[] }> = [];

  constructor(size: number) {
    this.path = join(dataDir(), 'ledger.sqlite');
    for (let i = 0; i < size; i++) {
      const ledger = Ledger.open(this.path, this.clock);
      const worker = new FakeWorker();
      this.members.push({
        name: `p${i}`,
        ledger,
        worker,
        conductor: new Conductor({ ledger, clock: this.clock, worker }),
        alive: true,
        lastRenewAt: START,
      });
    }
  }

  living(): Member[] {
    return this.members.filter((m) => m.alive);
  }

  byName(name: string): Member {
    const m = this.members.find((x) => x.name === name);
    if (!m) throw new Error(`no member ${name}`);
    return m;
  }

  /** Whoever the row names, read through a connection that is not deciding anything. */
  holder(): string | null {
    return this.members[0].ledger.lease(CONDUCTOR_LEASE)?.holder ?? null;
  }

  conductorNow(): Member | undefined {
    return this.living().find((m) => m.conductor.isConductor());
  }

  /**
   * Stagger the members' cadences, then let them settle.
   *
   * Without the stagger every P0 would check on the same virtual millisecond, which is
   * the one arrangement in which a broken election is hardest to catch: whoever the
   * array order puts first always wins, every time, and the row is never contended.
   */
  async stagger(spacingMs = 3_000): Promise<void> {
    for (const m of this.members) {
      await m.conductor.poll();
      this.clock.advance(spacingMs);
    }
  }

  /** Advance in steps, polling every living member, recording the row at each instant. */
  async run(durationMs: number, stepMs = 1_000): Promise<void> {
    for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
      this.clock.advance(stepMs);
      for (const m of this.living()) {
        const report = await m.conductor.poll();
        if (report.role === 'conductor') m.lastRenewAt = this.clock.now();
      }
      this.timeline.push({
        at: this.clock.now(),
        holder: this.holder(),
        believers: this.living()
          .filter((m) => m.conductor.isConductor())
          .map((m) => m.name),
      });
    }
  }

  /** `kill -9`: the process stops, and nothing runs on its way out. No release, no cleanup. */
  kill(name: string): Member {
    const m = this.byName(name);
    m.alive = false;
    return m;
  }

  close(): void {
    for (const m of this.members) m.ledger.close();
  }
}

describeSqlite('conductor election: standing, transitions and the tick', () => {
  it('checks on the cadence and not before', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const e = new ConductorElection({ ledger, clock });
    expect(e.isDue()).toBe(true);
    expect(e.check().acquired).toBe(true);
    expect(e.isDue()).toBe(false);

    clock.advance(ELECTION_CADENCE_MS - 1);
    expect(e.checkIfDue()).toBeUndefined();
    clock.advance(1);
    expect(e.checkIfDue()?.role).toBe('conductor');
    ledger.close();
  });

  it('renews before a long unit of work without rearming the cadence', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const e = new ConductorElection({ ledger, clock });
    e.check();
    const due = e.dueAt();

    clock.advance(4_000);
    expect(e.renewBeforeLongWork().role).toBe('conductor');
    expect(e.lease.expiresAt()).toBe(clock.now() + LEASE_TTL_MS);
    // Decoupled from stage progress: a conductor running long units back to back must not
    // push its own election check into the future by doing so.
    expect(e.dueAt()).toBe(due);
    ledger.close();
  });

  it('kills the worker on deposition, before the caller can do anything else', async () => {
    const clock = new ManualClock(START);
    const path = join(dataDir(), 'ledger.sqlite');
    const mine = Ledger.open(path, clock);
    const theirs = Ledger.open(path, clock);
    const worker = new FakeWorker();
    const c = new Conductor({ ledger: mine, clock, worker });
    expect((await c.poll()).role).toBe('conductor');
    expect(worker.alive()).toBe(true);

    // A rival takes the row while this one is not looking.
    clock.advance(LEASE_TTL_MS + 1);
    expect(new Lease({ ledger: theirs, clock, holder: 'uuid-rival' }).take()).toBe(true);

    const report = await c.poll();
    expect(report.election?.deposed).toBe(true);
    expect(report.role).toBe('follower');
    expect(report.workerKilled).toBe('lease lost');
    expect(worker.kills).toEqual(['lease lost']);
    // An orphaned worker pins the write-ahead log as a long-lived reader while the new
    // conductor spawns its own, so the kill happens before anything else this pass does —
    // and this pass does nothing else.
    expect(report.ticks).toEqual([]);
    mine.close();
    theirs.close();
  });

  it('runs the tick only for the winner, and a follower reaches no ledger statement', async () => {
    const clock = new ManualClock(START);
    const path = join(dataDir(), 'ledger.sqlite');
    const one = Ledger.open(path, clock);
    const two = Ledger.open(path, clock);
    const oid = one.registerOrigin('server-aaa');
    const lib = one.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });

    const ran: string[] = [];
    const tickFor = (name: string): any => ({
      isDue: () => true,
      runOnce: async (l: number) => {
        ran.push(`${name}:${l}`);
        return { lib: l } as any;
      },
    });
    const winner = new Conductor({ ledger: one, clock, tick: tickFor('one'), libraries: () => [lib] });
    const loser = new Conductor({ ledger: two, clock, tick: tickFor('two'), libraries: () => [lib] });

    await winner.poll();
    await loser.poll();
    expect(winner.isConductor()).toBe(true);
    expect(loser.isConductor()).toBe(false);
    expect(ran).toEqual([`one:${lib}`]);

    // And the loser keeps losing for as long as the winner is alive, however often it asks.
    for (let i = 0; i < 6; i++) {
      clock.advance(ELECTION_CADENCE_MS);
      await winner.poll();
      await loser.poll();
    }
    expect(ran.filter((r) => r.startsWith('two:'))).toEqual([]);
    one.close();
    two.close();
  });

  it('does not start a long unit of work it has just lost the right to do', async () => {
    const clock = new ManualClock(START);
    const path = join(dataDir(), 'ledger.sqlite');
    const mine = Ledger.open(path, clock);
    const theirs = Ledger.open(path, clock);
    const oid = mine.registerOrigin('server-aaa');
    const libs = [
      mine.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' }),
      mine.registerLibrary({ oid, kind: 'group', remoteId: 7, scope: 'cloud' }),
    ];
    const ran: number[] = [];
    const rival = new Lease({ ledger: theirs, clock, holder: 'uuid-rival' });
    const tick: any = {
      isDue: () => true,
      runOnce: async (l: number) => {
        ran.push(l);
        // Between the first library's tick and the second's, the row moves. The renewal
        // that §5.2.5 puts immediately before a long unit of work is what notices.
        clock.advance(LEASE_TTL_MS + 1);
        rival.take();
        return { lib: l } as any;
      },
    };
    const c = new Conductor({ ledger: mine, clock, tick, worker: new FakeWorker(), libraries: () => libs });

    const report = await c.poll();
    expect(ran).toEqual([libs[0]]);
    expect(report.role).toBe('follower');
    expect(report.workerKilled).toBe('lease lost');
    mine.close();
    theirs.close();
  });

  it('ends the pass on a deposition inside the tick loop: no sweep, no successor worker', async () => {
    /**
     * The rest of the pass, which is not the tick. `poll` re-checks its standing once,
     * before the ticks; a deposition noticed *inside* `runTicks` only breaks that loop, and
     * everything after it used to run anyway — the claim sweep, which is a ledger write, and
     * the spawn, which starts a fresh worker under a lease the successor already holds.
     *
     * Both are the single-writer guarantee of §5.2.5 breaking, and the second is worse than
     * the first: the deposition callback has just killed this P0's worker precisely so it
     * would stop pinning the write-ahead log, and the pass then starts another one.
     */
    const clock = new ManualClock(START);
    const path = join(dataDir(), 'ledger.sqlite');
    const mine = Ledger.open(path, clock);
    const theirs = Ledger.open(path, clock);
    const oid = mine.registerOrigin('server-aaa');
    const libs = [
      mine.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' }),
      mine.registerLibrary({ oid, kind: 'group', remoteId: 7, scope: 'cloud' }),
    ];

    // A row claimed by somebody else, on a TTL the tick's own clock jump will outrun. This
    // is what makes "the follower reached no ledger statement" observable rather than
    // asserted about an absence: with the sweep running, the row goes back to `pending`.
    const wid = mine.enqueue({
      lib: libs[0],
      class: 'metadata',
      op: 'index',
      itemKey: 'REC001',
      dateAdded: '2026-01-01T00:00:00Z',
    });
    expect(mine.claim(wid, 'uuid-a-worker', 'item:17', 1_000)).toBe(true);

    const rival = new Lease({ ledger: theirs, clock, holder: 'uuid-rival' });
    const tick: any = {
      isDue: () => true,
      runOnce: async (l: number) => {
        // The row moves between the first library and the second, exactly as above.
        clock.advance(LEASE_TTL_MS + 1);
        rival.take();
        return { lib: l } as any;
      },
    };
    const spawned: FakeWorker[] = [];
    const pipeline = {
      hasWork: () => true,
      spawn: (): WorkerControl => {
        const w = new FakeWorker();
        spawned.push(w);
        return w;
      },
    };
    const c = new Conductor({
      ledger: mine,
      clock,
      tick,
      worker: new FakeWorker(),
      pipeline,
      libraries: () => libs,
    });

    const report = await c.poll();

    // Asserted as one shape rather than one line at a time, because the two consequences
    // are independent: stopping at the first would say the sweep ran and leave the spawn —
    // the worse of the two — unreported until the next round.
    expect({
      role: report.role,
      workerKilled: report.workerKilled,
      // "A follower writes nothing at all." Not "nothing important": the sweep is a ledger
      // statement, and a deposed P0 running it decides the successor's queue for it.
      releasedClaims: report.releasedClaims,
      sweptRow: mine.row(wid)?.status,
      // And no worker under a lease this process no longer holds — the successor's to spawn.
      workersSpawned: spawned.length,
      workerSpawned: report.workerSpawned ?? false,
      workerAlive: report.workerAlive,
    }).toEqual({
      role: 'follower',
      workerKilled: 'lease lost',
      releasedClaims: 0,
      sweptRow: 'claimed',
      workersSpawned: 0,
      workerSpawned: false,
      workerAlive: false,
    });
    // The premise, so a run where nobody was deposed cannot satisfy the assertions above.
    expect(theirs.lease(CONDUCTOR_LEASE)?.holder).toBe('uuid-rival');
    mine.close();
    theirs.close();
  });
});

describeSqlite('conductor election: the R13 soak, in virtual time', () => {
  /**
   * The ticket's own red-first line, and R13's soak clause: several P0s on one data
   * directory, exactly one conductor, `kill -9` it twice, another takes over within
   * TTL + cadence.
   */
  it('elects exactly one of three, and never two at the same instant', async () => {
    const cluster = new Cluster(3);
    await cluster.stagger();
    await cluster.run(5 * 60_000);

    for (const instant of cluster.timeline) {
      expect(instant.believers.length).toBeLessThanOrEqual(1);
      if (instant.believers.length === 1) expect(instant.holder).not.toBeNull();
    }
    // And the steady state is one, not zero: an election that never settles would satisfy
    // "at most one" perfectly.
    expect(cluster.timeline.every((i) => i.believers.length === 1)).toBe(true);
    expect(new Set(cluster.timeline.map((i) => i.holder)).size).toBe(1);
    cluster.close();
  });

  it('hands over within TTL + cadence when the conductor is killed, twice', async () => {
    const cluster = new Cluster(3);
    await cluster.stagger();
    await cluster.run(60_000);

    const handovers: Array<{ from: string; sinceRenewal: number; sinceDeath: number }> = [];
    for (let round = 0; round < 2; round++) {
      const victim = cluster.conductorNow();
      expect(victim).toBeDefined();
      const from = (victim as Member).name;
      const lastRenewAt = (victim as Member).lastRenewAt;
      // Killed a step after its last renewal, so the death instant is strictly later than
      // the renewal the row's expiry was computed from — which is what makes the bound
      // strict rather than met with equality.
      cluster.clock.advance(1_000);
      const deathAt = cluster.clock.now();
      cluster.kill(from);

      let takeoverAt: number | undefined;
      for (let step = 0; step < 120 && takeoverAt === undefined; step++) {
        cluster.clock.advance(500);
        for (const m of cluster.living()) await m.conductor.poll();
        const now = cluster.conductorNow();
        if (now) takeoverAt = cluster.clock.now();
        expect(cluster.living().filter((m) => m.conductor.isConductor()).length).toBeLessThanOrEqual(1);
      }
      expect(takeoverAt).toBeDefined();
      handovers.push({
        from,
        sinceRenewal: (takeoverAt as number) - lastRenewAt,
        sinceDeath: (takeoverAt as number) - deathAt,
      });
      // Let the survivor settle before the next kill, so round two is a real election and
      // not the tail of round one.
      await cluster.run(30_000);
    }

    expect(handovers).toHaveLength(2);
    expect(new Set(handovers.map((h) => h.from)).size).toBe(2);
    for (const h of handovers) {
      // The arithmetic bound: worst case is a check landing on the expiry instant itself.
      expect(h.sinceRenewal).toBeLessThanOrEqual(LEASE_MIGRATION_BOUND_MS);
      // R13 as written: `lease migration < 30 s`, measured from the death.
      expect(h.sinceDeath).toBeLessThan(LEASE_MIGRATION_BOUND_MS);
    }
    // One survivor, still writing, after two deaths.
    expect(cluster.living()).toHaveLength(1);
    expect(cluster.conductorNow()).toBeDefined();
    cluster.close();
  });

  it('positive control: with time stopped, no takeover happens at all', async () => {
    const cluster = new Cluster(3);
    await cluster.stagger();
    await cluster.run(30_000);
    const victim = cluster.conductorNow() as Member;
    cluster.kill(victim.name);

    // The bound above is a claim about *when*. Without this, a suite that polled a
    // thousand times would report the same success whether the takeover waited for the
    // TTL or ignored it entirely.
    for (let i = 0; i < 50; i++) for (const m of cluster.living()) await m.conductor.poll();
    expect(cluster.conductorNow()).toBeUndefined();
    expect(cluster.holder()).toBe(victim.conductor.holder);
    cluster.close();
  });

  it('survives a P0 joining the cluster mid-run without disturbing the incumbent', async () => {
    const cluster = new Cluster(2);
    await cluster.stagger();
    await cluster.run(60_000);
    const incumbent = cluster.conductorNow() as Member;

    const ledger = Ledger.open(cluster.path, cluster.clock);
    const worker = new FakeWorker();
    cluster.members.push({
      name: 'p-late',
      ledger,
      worker,
      conductor: new Conductor({ ledger, clock: cluster.clock, worker }),
      alive: true,
      lastRenewAt: cluster.clock.now(),
    });

    await cluster.run(60_000);
    expect(cluster.conductorNow()?.name).toBe(incumbent.name);
    expect(cluster.byName('p-late').conductor.isConductor()).toBe(false);
    cluster.close();
  });
});

/**
 * Positive controls: the soak's own invariant, run against elections that are wrong on
 * purpose. (The statement-scale mutants sit beside the statement, in
 * `conductor-lease.test.ts`.)
 *
 * Every assertion above is of the form "nothing bad happened", which is exactly the shape
 * whose all-clear is indistinguishable from its could-not-look. A green soak proves the
 * election sound only if a broken election would have turned it red, so each mutant below
 * removes one term from the ratified statement and is asserted to break the property the
 * soak asserts.
 *
 * The mutants live in the test rather than in the source because a mutant in the source
 * is a defect somebody eventually ships. What is under examination is the assertion.
 */
describeSqlite('conductor election: positive controls on the soak invariant', () => {
  type Take = (uuid: string, now: number) => boolean;

  /** The ratified statement, as `lease.ts` runs it. */
  const ratified =
    (ledger: Ledger, ttl = LEASE_TTL_MS): Take =>
    (uuid, now) =>
      Number(
        ledger.db
          .prepare(
            `UPDATE leases SET holder = :uuid, expires_at = :expires
               WHERE name = 'conductor' AND (holder = :uuid OR expires_at < :now)`,
          )
          .run({ uuid, expires: now + ttl, now }).changes,
      ) === 1;

  /** Mutant A: the expiry disjunct dropped. Anybody may take the row at any time. */
  const alwaysSteals =
    (ledger: Ledger, ttl = LEASE_TTL_MS): Take =>
    (uuid, now) =>
      Number(
        ledger.db
          .prepare(`UPDATE leases SET holder = :uuid, expires_at = :expires WHERE name = 'conductor'`)
          .run({ uuid, expires: now + ttl }).changes,
      ) === 1;

  /**
   * Mutant B: the expiry compared against the deadline this call would *write* rather
   * than the one already stored — `expires_at < :now + ttl`. It is the natural slip in
   * this statement, since both values are in scope on the same line.
   */
  const stealsEarly =
    (ledger: Ledger, ttl = LEASE_TTL_MS, earlyMs = LEASE_TTL_MS): Take =>
    (uuid, now) =>
      Number(
        ledger.db
          .prepare(
            `UPDATE leases SET holder = :uuid, expires_at = :expires
               WHERE name = 'conductor' AND (holder = :uuid OR expires_at < :now + :early)`,
          )
          .run({ uuid, expires: now + ttl, now, early: earlyMs }).changes,
      ) === 1;

  /**
   * The soak's own invariant, extracted so it can be run over a broken election.
   *
   * Same shape as `Cluster.run`: staggered cadences, every candidate polled at every
   * step, the believers counted at each instant. Returns the largest number of candidates
   * that believed they were the conductor at one simulated instant.
   */
  function maxSimultaneousConductors(make: (ledger: Ledger) => Take, size = 3): number {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const take = make(ledger);
    const members = Array.from({ length: size }, (_, i) => ({
      uuid: `uuid-${i}`,
      role: 'follower' as 'conductor' | 'follower',
      nextCheckAt: 0,
    }));
    const poll = (m: (typeof members)[number]): void => {
      if (clock.now() < m.nextCheckAt) return;
      m.role = take(m.uuid, clock.now()) ? 'conductor' : 'follower';
      m.nextCheckAt = clock.now() + ELECTION_CADENCE_MS;
    };
    let worst = 0;
    for (const m of members) {
      poll(m);
      clock.advance(3_000);
    }
    for (let elapsed = 0; elapsed < 120_000; elapsed += 1_000) {
      clock.advance(1_000);
      for (const m of members) poll(m);
      worst = Math.max(worst, members.filter((m) => m.role === 'conductor').length);
    }
    ledger.close();
    return worst;
  }

  it('the exactly-one assertion goes red on an election that steals from a live holder', () => {
    expect(maxSimultaneousConductors(ratified)).toBe(1);
    expect(maxSimultaneousConductors(alwaysSteals)).toBeGreaterThan(1);
  });

  it('the exactly-one assertion goes red on an election that fires before the TTL is up', () => {
    expect(maxSimultaneousConductors(stealsEarly)).toBeGreaterThan(1);
    // How early it has to be, measured rather than assumed: a window under TTL − cadence
    // is invisible here, because the holder's own renewal has already pushed the row
    // further into the future than the window reaches. That margin is what TTL = 2 ×
    // heartbeat buys, and it is also a warning about this control — a mutant that does
    // not bite is not evidence that the assertion is sharp.
    expect(maxSimultaneousConductors((l) => stealsEarly(l, LEASE_TTL_MS, HEARTBEAT_MS))).toBe(1);
  });

});
