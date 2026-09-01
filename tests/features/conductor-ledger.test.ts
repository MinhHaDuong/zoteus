import { describe, it, expect } from 'vitest';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import { ManualClock } from '../fixtures/clock.js';

/**
 * The ledger is the conductor's whole state: what Zotero last told us (the censuses and
 * the watermarks), what is therefore owed (the stage queue), who is doing it (the row
 * claims), and who is allowed to write at all (the lease). Tranche 1 builds the schema
 * and the reconcile tick that fills it; the worker that drains it is tranche 2's.
 *
 * These tests are about the *shape*: that the columns priority is ordered by exist and
 * order correctly, that the two traps SPEC.md §5.2.4 names are unrepresentable rather
 * than merely documented, and that the election statement §5.2.5 quotes is valid against
 * the lease table as built.
 */

const hasSqlite = nodeSqliteAvailable();
const describeSqlite = hasSqlite ? describe : describe.skip;

function openLedger(): { ledger: Ledger; clock: ManualClock } {
  const clock = new ManualClock(1_700_000_000_000);
  return { ledger: Ledger.open(':memory:', clock), clock };
}

describeSqlite('conductor ledger: identity', () => {
  it('scopes a library by its origin, so two servers holding users/0 stay apart', () => {
    const { ledger } = openLedger();
    const laptop = ledger.registerOrigin('server-aaa');
    const desktop = ledger.registerOrigin('server-bbb');
    expect(laptop).not.toBe(desktop);

    const a = ledger.registerLibrary({ oid: laptop, kind: 'user', remoteId: 0, scope: 'local' });
    const b = ledger.registerLibrary({ oid: desktop, kind: 'user', remoteId: 0, scope: 'local' });
    expect(a).not.toBe(b);

    ledger.setItemWatermark(a, 42);
    expect(ledger.itemWatermark(a)).toBe(42);
    // The whole point of the (oid, lib) scoping: the other server's users/0 is untouched.
    expect(ledger.itemWatermark(b)).toBe(0);

    ledger.close();
  });

  it('registers the same origin and library idempotently', () => {
    const { ledger } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    expect(ledger.registerOrigin('server-aaa')).toBe(oid);
    const lib = ledger.registerLibrary({ oid, kind: 'group', remoteId: 12345, scope: 'cloud' });
    expect(ledger.registerLibrary({ oid, kind: 'group', remoteId: 12345, scope: 'cloud' })).toBe(lib);
    ledger.close();
  });
});

describeSqlite('conductor ledger: the full-text cursor trap', () => {
  /**
   * SPEC.md §5.2.4(2): a local scope has no monotonic full-text sequence — one
   * attachment's version may be a web sync stamp, a local client version, or 0 for
   * locally extracted text — so a `?since=` cursor over it silently loses work. The
   * schema is supposed to make that unrepresentable, not document it.
   */
  it('refuses a full-text watermark on a local-scope library', () => {
    const { ledger } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const local = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    expect(() => ledger.setFulltextWatermark(local, 7)).toThrow();
    expect(ledger.fulltextWatermark(local)).toBeNull();
    ledger.close();
  });

  it('allows one on a cloud-scope library, where the sequence really is monotonic', () => {
    const { ledger } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const cloud = ledger.registerLibrary({ oid, kind: 'user', remoteId: 111, scope: 'cloud' });
    ledger.setFulltextWatermark(cloud, 7);
    expect(ledger.fulltextWatermark(cloud)).toBe(7);
    ledger.close();
  });

  it('closes the back door: no cursor row may be named fulltext', () => {
    const { ledger } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const local = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    // A generic cursor table would otherwise let a caller store exactly the cursor the
    // libraries CHECK just refused.
    expect(() => ledger.setCursor(local, 'fulltext', 7)).toThrow();
    ledger.setCursor(local, 'record-sweep', 7);
    expect(ledger.cursor(local, 'record-sweep')).toBe(7);
    ledger.close();
  });
});

describeSqlite('conductor ledger: priority is an ORDER BY, not a scheduler', () => {
  function seeded() {
    const { ledger, clock } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    return { ledger, clock, lib };
  }

  it('orders metadata before own words before body, newest first inside each', () => {
    const { ledger, lib } = seeded();
    // Deliberately enqueued in the wrong order, and with the body rows the newest of all,
    // so a queue that merely returned insertion order or recency would fail here.
    ledger.enqueue({ lib, class: 'body', op: 'index', itemKey: 'BODYNEW', dateAdded: '2026-08-01T00:00:00Z' });
    ledger.enqueue({ lib, class: 'body', op: 'index', itemKey: 'BODYOLD', dateAdded: '2026-01-01T00:00:00Z' });
    ledger.enqueue({ lib, class: 'own_words', op: 'index', itemKey: 'NOTE01', dateAdded: '2026-02-01T00:00:00Z' });
    ledger.enqueue({ lib, class: 'metadata', op: 'index', itemKey: 'REC001', dateAdded: '2025-01-01T00:00:00Z' });

    const drained: string[] = [];
    for (;;) {
      const next = ledger.nextWorkOrder({ lib });
      if (!next) break;
      drained.push(next.itemKey!);
      ledger.markDone(next.wid);
    }
    expect(drained).toEqual(['REC001', 'NOTE01', 'BODYNEW', 'BODYOLD']);
    ledger.close();
  });

  it('puts band 0 ahead of band 1 for the same item', () => {
    const { ledger, lib } = seeded();
    ledger.enqueue({ lib, class: 'body', op: 'index', itemKey: 'MONSTER', band: 1, dateAdded: '2026-05-01T00:00:00Z' });
    ledger.enqueue({ lib, class: 'body', op: 'index', itemKey: 'MONSTER', band: 0, dateAdded: '2026-05-01T00:00:00Z' });
    expect(ledger.nextWorkOrder({ lib })?.band).toBe(0);
    ledger.close();
  });

  it('can be read one lane at a time, which is what the weighted interleave needs', () => {
    const { ledger, lib } = seeded();
    ledger.enqueue({ lib, class: 'body', op: 'index', itemKey: 'BACKFILL', lane: 'backfill', dateAdded: '2026-09-01T00:00:00Z' });
    ledger.enqueue({ lib, class: 'body', op: 'index', itemKey: 'FRESH', lane: 'fresh', dateAdded: '2026-01-01T00:00:00Z' });
    // Unfiltered, the older fresh row loses to the newer backfill row: the ledger states
    // an order, it does not arbitrate between lanes. That arbitration (r = 3) is the
    // conductor's, and this is the read it needs.
    expect(ledger.nextWorkOrder({ lib })?.itemKey).toBe('BACKFILL');
    expect(ledger.nextWorkOrder({ lib, lane: 'fresh' })?.itemKey).toBe('FRESH');
    ledger.close();
  });
});

describeSqlite('conductor ledger: row claims', () => {
  it('records the input a row was claimed against, and refuses a second holder', () => {
    const { ledger, clock } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    const wid = ledger.enqueue({ lib, class: 'metadata', op: 'index', itemKey: 'REC001', dateAdded: '2026-01-01T00:00:00Z' });

    expect(ledger.claim(wid, 'uuid-a', 'item:17', 30_000)).toBe(true);
    expect(ledger.claim(wid, 'uuid-b', 'item:17', 30_000)).toBe(false);
    expect(ledger.row(wid)?.claimedInput).toBe('item:17');
    // A claimed row is out of the queue while the claim holds.
    expect(ledger.nextWorkOrder({ lib })).toBeUndefined();

    clock.advance(30_001);
    expect(ledger.releaseExpiredClaims()).toBe(1);
    expect(ledger.nextWorkOrder({ lib })?.wid).toBe(wid);
    // Re-claimable by anyone, and the new claim records the input as it stands now: a
    // retry after an expiry must not inherit the dead holder's idea of the input.
    expect(ledger.claim(wid, 'uuid-b', 'item:18', 30_000)).toBe(true);
    expect(ledger.row(wid)?.claimedInput).toBe('item:18');
    ledger.close();
  });
});

describeSqlite('conductor ledger: the lease table', () => {
  /**
   * Tranche 1 builds the table, not the election. What it owes tranche 2 is that the
   * statement SPEC.md §5.2.5 quotes verbatim is valid against the table as built — an
   * election written against a table missing `expires_at` fails at run time, in the one
   * code path that has no test until a second server exists.
   */
  it('accepts the election statement §5.2.5 quotes', () => {
    const { ledger, clock } = openLedger();
    const now = clock.now();
    const take = (uuid: string) =>
      ledger.db
        .prepare(
          `UPDATE leases SET holder = :uuid, expires_at = :expires
             WHERE name = 'conductor' AND (holder = :uuid OR expires_at < :now)`,
        )
        .run({ uuid, expires: now + 20_000, now });

    expect(take('uuid-a').changes).toBe(1);
    expect(ledger.lease('conductor')?.holder).toBe('uuid-a');
    // A live lease is not stealable.
    expect(take('uuid-b').changes).toBe(0);
    ledger.close();
  });
});
