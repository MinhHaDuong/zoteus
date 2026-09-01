import { describe, it, expect } from 'vitest';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import {
  ELECTION_CADENCE_MS,
  HEARTBEAT_MS,
  Lease,
  LEASE_MIGRATION_BOUND_MS,
  LEASE_TTL_MS,
} from '../../src/features/search/conductor/lease.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * The lease statement and the CAS commit guard (SPEC.md §5.2.5).
 *
 * This file is about one UPDATE and its guard — the statement's own properties, tested at
 * the smallest scale that can show them. What several servers do with it over time is
 * `conductor-election.test.ts`.
 *
 * **Virtual time throughout.** A TTL is a claim about *when*, and a suite that waited 20 s
 * to watch one run out could only report that it eventually did — at 20 s per assertion.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

const START = 1_700_000_000_000;

describeSqlite('conductor lease: the statement §5.2.5 quotes', () => {
  it('is one statement for acquisition and for renewal', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    const b = new Lease({ ledger, clock, holder: 'uuid-b' });

    expect(a.take()).toBe(true);
    expect(a.expiresAt()).toBe(START + LEASE_TTL_MS);
    // The same call renews, and the rival's identical call is refused while it is live.
    clock.advance(HEARTBEAT_MS);
    expect(a.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(a.holderNow()).toBe('uuid-a');
    ledger.close();
  });

  it('refuses a rival until the TTL has run out, and not one millisecond later', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    const b = new Lease({ ledger, clock, holder: 'uuid-b' });
    expect(a.take()).toBe(true);

    clock.advance(LEASE_TTL_MS);
    // `expires_at < :now`: at the expiry instant itself the row is still the holder's.
    expect(b.take()).toBe(false);
    clock.advance(1);
    expect(b.take()).toBe(true);
    expect(b.holderNow()).toBe('uuid-b');
    ledger.close();
  });

  it('gives every process a fresh identity, so no row can name two of them', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const holders = new Set(Array.from({ length: 64 }, () => new Lease({ ledger, clock }).holder));
    expect(holders.size).toBe(64);
    // A UUID and not a pid: a pid is reissued, and a reissued identity is a lease a
    // stranger can renew. The regression this pins is textual because the alternative is
    // a value that looks fine right up until the operating system reuses it.
    for (const h of holders) expect(h).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    ledger.close();
  });

  it('releases conditionally, so a deposed process cannot blank its successor', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    const b = new Lease({ ledger, clock, holder: 'uuid-b' });
    expect(a.take()).toBe(true);
    clock.advance(LEASE_TTL_MS + 1);
    expect(b.take()).toBe(true);

    expect(a.release()).toBe(false);
    expect(b.holderNow()).toBe('uuid-b');
    expect(b.release()).toBe(true);
    expect(b.holderNow()).toBeNull();
    // Released to 0, not to `now`: the successor's `expires_at < :now` must be true on
    // any clock, including one skewed behind the releaser's.
    expect(b.expiresAt()).toBe(0);
    ledger.close();
  });

  it('satisfies R13’s migration gate by arithmetic: TTL = 2 × heartbeat, bound = TTL + cadence', () => {
    expect(LEASE_TTL_MS).toBe(2 * HEARTBEAT_MS);
    expect(LEASE_MIGRATION_BOUND_MS).toBe(LEASE_TTL_MS + ELECTION_CADENCE_MS);
    expect(LEASE_MIGRATION_BOUND_MS).toBe(30_000);
  });
});

describeSqlite('conductor lease: the CAS commit guard', () => {
  /**
   * §5.2.5: "every record commit carries the guard in the same transaction as the write".
   * The record tables are a later tranche's, so the guard is exercised against the row
   * that exists — which is not a weaker test of the guard itself, only a narrower one of
   * what it protects.
   */
  it('writes nothing once its holder has been deposed', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    const b = new Lease({ ledger, clock, holder: 'uuid-b' });
    expect(a.take()).toBe(true);

    // A goes away for longer than the TTL — a stop-the-world pause, not a death — and B
    // takes the row. A does not know yet, which is the whole case.
    clock.advance(LEASE_TTL_MS + 1);
    expect(b.take()).toBe(true);

    let written = 0;
    const result = a.commit(() => {
      written++;
      return 'record';
    });
    expect(result.committed).toBe(false);
    expect(result.value).toBeUndefined();
    expect(a.guard()).toBe(false);
    // Not "the write was rolled back": the write never ran. A guard that let the body
    // execute and undid it afterwards would still have sent whatever the body sent.
    expect(written).toBe(0);
    expect(b.holderNow()).toBe('uuid-b');
    ledger.close();
  });

  it('commits for the holder, and rolls the write back with the guard on failure', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    expect(a.take()).toBe(true);
    const oid = ledger.registerOrigin('server-aaa');
    const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });

    const ok = a.commit(() => ledger.enqueue({ lib, class: 'metadata', op: 'index', itemKey: 'AAAA1111' }));
    expect(ok.committed).toBe(true);
    expect(ledger.pending(lib)).toHaveLength(1);

    // The guard and the write share one transaction, so a failing write takes the guard's
    // own UPDATE down with it rather than leaving a half-applied commit.
    expect(() =>
      a.commit(() => {
        ledger.enqueue({ lib, class: 'metadata', op: 'index', itemKey: 'BBBB2222' });
        throw new Error('stage failed');
      }),
    ).toThrow('stage failed');
    expect(ledger.pending(lib)).toHaveLength(1);
    ledger.close();
  });

  it('lets an expired-but-unreplaced holder finish its work', () => {
    // Deliberate, and the reason is in `lease.ts`: SQLite serializes, so a holder nobody
    // has replaced is still the only writer. An expiry term in the guard would discard
    // completed work after a long pause and would buy no safety.
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    expect(a.take()).toBe(true);
    clock.advance(LEASE_TTL_MS * 10);
    expect(a.heldByMe()).toBe(false);
    expect(a.commit(() => 'still mine').committed).toBe(true);
    ledger.close();
  });
});

/**
 * Positive controls, at the statement's own scale.
 *
 * Every assertion above is of the form "nothing bad happened", which is exactly the shape
 * whose all-clear is indistinguishable from its could-not-look. So each mutant below is
 * the smallest edit that removes one load-bearing term from the ratified statement, and
 * each is shown to break the property the corresponding test asserts.
 *
 * The mutants live in the test rather than in the source because a mutant in the source
 * is a defect somebody eventually ships. What is under examination is the assertion.
 */
describeSqlite('conductor lease: positive controls on the statement', () => {
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

  /** Mutant: the self disjunct dropped. A live holder cannot renew its own row. */
  const cannotRenew =
    (ledger: Ledger, ttl = LEASE_TTL_MS): Take =>
    (uuid, now) =>
      Number(
        ledger.db
          .prepare(
            `UPDATE leases SET holder = :uuid, expires_at = :expires
               WHERE name = 'conductor' AND expires_at < :now`,
          )
          .run({ uuid, expires: now + ttl, now }).changes,
      ) === 1;

  it('a holder that cannot renew itself loses the row on every cadence', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const take = cannotRenew(ledger);
    expect(take('uuid-a', clock.now())).toBe(true);
    clock.advance(HEARTBEAT_MS);
    // The ratified statement renews here. This one does not, so the row runs out under a
    // holder that is alive and heartbeating — a cluster that hands the conductorship
    // around every TTL and never drains anything.
    expect(take('uuid-a', clock.now())).toBe(false);
    clock.advance(LEASE_TTL_MS);
    expect(take('uuid-b', clock.now())).toBe(true);
    ledger.close();
  });

  it('the deposed-conductor assertion goes red on a commit guard without the holder term', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    const b = new Lease({ ledger, clock, holder: 'uuid-b' });
    a.take();
    clock.advance(LEASE_TTL_MS + 1);
    b.take();

    // The guard as shipped refuses.
    expect(a.guard()).toBe(false);
    // The same statement with `holder = :uuid` removed — the one term the CAS idiom is —
    // accepts, and the deposed conductor's record commit lands on top of its successor's.
    const unguarded = Number(
      ledger.db.prepare(`UPDATE leases SET holder = :uuid WHERE name = 'conductor'`).run({ uuid: 'uuid-a' }).changes,
    );
    expect(unguarded).toBe(1);
    ledger.close();
  });

  it('a pid-shaped holder lets a recycled identity renew a live lease', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const take = ratified(ledger);
    // §5.2.5 says a UUID "and not a recyclable pid". This is what recycling costs: the
    // second process is a stranger, and the row cannot tell.
    expect(take('pid-4711', clock.now())).toBe(true);
    clock.advance(HEARTBEAT_MS);
    expect(take('pid-4711', clock.now())).toBe(true);
    // Two live UUIDs never collide; two live pids can, and the UUID assertion above is
    // what stands between the design and this.
    const uuids = new Set([new Lease({ ledger, clock }).holder, new Lease({ ledger, clock }).holder]);
    expect(uuids.size).toBe(2);
    ledger.close();
  });

  it('a release without the holder term blanks the successor’s row', () => {
    const clock = new ManualClock(START);
    const ledger = Ledger.open(':memory:', clock);
    const a = new Lease({ ledger, clock, holder: 'uuid-a' });
    const b = new Lease({ ledger, clock, holder: 'uuid-b' });
    a.take();
    clock.advance(LEASE_TTL_MS + 1);
    b.take();

    expect(a.release()).toBe(false);
    expect(b.holderNow()).toBe('uuid-b');
    // The unconditional form, which is what a shutdown path written without the race in
    // mind looks like: the departing process hands the cluster a free-for-all.
    ledger.db.prepare(`UPDATE leases SET holder = NULL, expires_at = 0 WHERE name = 'conductor'`).run();
    expect(b.holderNow()).toBeNull();
    ledger.close();
  });
});
