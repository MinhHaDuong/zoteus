import { describe, it, expect } from 'vitest';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { Ledger } from '../../src/features/search/conductor/ledger.js';
import type { AttachmentDecision } from '../../src/features/search/conductor/ledger.js';
import { ManualClock } from '../fixtures/clock.js';
import { completeByHand } from '../fixtures/claims.js';

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
      completeByHand(ledger, next.wid);
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

describeSqlite('conductor ledger: completion is owned', () => {
  /**
   * The other half of `claim`'s compare-and-swap, added by ticket 0553's round-2 review and
   * ticket 0567.
   *
   * `releaseExpiredClaims` is the recovery §5.2.5 chose, and it cannot tell a dead worker
   * from a slow one: the row of a worker that is merely late comes back to the queue, a
   * second worker takes it and finishes, and the first one's own completion then arrives
   * against a row it no longer owns. Unguarded, that write lands over the fresher result
   * with no error anywhere — which is not §5.2.5's accepted duplicate (redone and
   * discarded) but silent unbounded staleness.
   */
  function oneOrder(): { ledger: Ledger; clock: ManualClock; wid: number } {
    const { ledger, clock } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    const wid = ledger.enqueue({ lib, class: 'metadata', op: 'index', itemKey: 'REC001', dateAdded: '2026-01-01T00:00:00Z' });
    return { ledger, clock, wid };
  }

  it('refuses a completion from a holder whose claim was swept and re-taken', () => {
    const { ledger, clock, wid } = oneOrder();
    const slow = ledger.claimTicket(wid, 'worker-a', 'item:17', 20_000)!;
    expect(slow).not.toBeNull();

    clock.advance(20_001);
    expect(ledger.releaseExpiredClaims()).toBe(1);
    const fresh = ledger.claimTicket(wid, 'worker-b', 'item:17', 20_000)!;
    expect(ledger.markDone(fresh)).toBe(true);

    // Worker A was never dead, only late. Its completion arrives now.
    expect(ledger.markDone(slow)).toBe(false);
    expect(ledger.markFailed(slow, 'a says it failed')).toBe(false);
    expect(ledger.row(wid)?.status).toBe('done');
    expect(ledger.row(wid)?.note).toBeNull();
    ledger.close();
  });

  it('refuses it even when the same holder took the row again', () => {
    // The arm a `claimed_by` check alone cannot pass. One conductor spawns one worker at a
    // time under one holder string, so the re-claim after an expiry usually carries the
    // *same* name and the same input; what separates the two claims is the expiry each was
    // granted, which is why the ticket is the triple rather than the holder.
    const { ledger, clock, wid } = oneOrder();
    const first = ledger.claimTicket(wid, 'extract', 'item:17', 20_000)!;
    clock.advance(20_001);
    expect(ledger.releaseExpiredClaims()).toBe(1);
    const second = ledger.claimTicket(wid, 'extract', 'item:17', 20_000)!;

    expect(second.holder).toBe(first.holder);
    expect(second.claimedInput).toBe(first.claimedInput);
    expect(ledger.markDone(first)).toBe(false);
    expect(ledger.row(wid)?.status).toBe('claimed');
    // Control: the claim that actually holds the row completes it.
    expect(ledger.markDone(second)).toBe(true);
    expect(ledger.row(wid)?.status).toBe('done');
    ledger.close();
  });

  it('refuses a completion for work the row has since been re-derived from', () => {
    // The half a holder check cannot see. `enqueue` deduplicates against pending AND
    // claimed rows and coalesces the newer order into the one it finds, so `signal` moves
    // under a live claim while the worker is still fetching the version it was handed.
    // The tick stamps the full-text census in the same breath, so a completion that retired
    // that row would lose version 2 for good — nothing re-derives an order the census
    // already accounts for.
    const { ledger, clock, wid } = oneOrder();
    const order = (signal: string): number =>
      ledger.enqueue({
        lib: ledger.libraries()[0]!.lib,
        class: 'metadata',
        op: 'index',
        itemKey: 'REC001',
        dateAdded: '2026-01-01T00:00:00Z',
        signal,
      });
    expect(order('fulltext:1|item:1')).toBe(wid);

    const claim = ledger.claimTicket(wid, 'worker-a', 'fulltext:1|item:1', 20_000)!;
    expect(claim.signal).toBe('fulltext:1|item:1');

    // The tick runs again while the fetch is in flight and finds the row still claimed.
    expect(order('fulltext:2|item:3')).toBe(wid);
    expect(ledger.row(wid)?.signal).toBe('fulltext:2|item:3');
    expect(ledger.row(wid)?.claimedInput).toBe('fulltext:1|item:1');

    expect(ledger.markDone(claim)).toBe(false);
    expect(ledger.row(wid)?.status).toBe('claimed');

    // The row is recovered the ordinary way, and the retry is against the newer signal.
    clock.advance(20_001);
    expect(ledger.releaseExpiredClaims()).toBe(1);
    const retry = ledger.claimTicket(wid, 'worker-a', 'fulltext:2|item:3', 20_000)!;
    expect(ledger.markDone(retry)).toBe(true);
    ledger.close();
  });

  it('accepts a live holder, including one whose claim has aged past its TTL unswept', () => {
    // Expiry is a timestamp, not an event: until the sweep runs, nobody else holds the row,
    // and rejecting the holder's own completion would throw away work for nothing. A guard
    // that rejects a legitimate completion is as wrong as one that rejects nothing.
    const { ledger, clock, wid } = oneOrder();
    const claim = ledger.claimTicket(wid, 'worker-a', 'item:17', 20_000)!;
    clock.advance(60_000);
    expect(ledger.markDone(claim)).toBe(true);
    expect(ledger.row(wid)?.status).toBe('done');

    // And the failing outcome carries its note through the same guard.
    const other = oneOrder();
    const failing = other.ledger.claimTicket(other.wid, 'worker-a', '', 20_000)!;
    expect(other.ledger.markFailed(failing, 'zotero refused')).toBe(true);
    expect(other.ledger.row(other.wid)?.status).toBe('failed');
    expect(other.ledger.row(other.wid)?.note).toBe('zotero refused');
    other.ledger.close();
    ledger.close();
  });

  it('leaves a completed row completed: a second completion is not a second write', () => {
    const { ledger, wid } = oneOrder();
    const claim = ledger.claimTicket(wid, 'worker-a', '', 20_000)!;
    expect(ledger.markDone(claim)).toBe(true);
    expect(ledger.markFailed(claim, 'and then it failed')).toBe(false);
    expect(ledger.row(wid)?.status).toBe('done');
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

describeSqlite("conductor ledger: D6's choice set is written whole or not at all", () => {
  /**
   * Ticket 0570. `ExtractStage.decide()` reads the candidate set and writes the whole
   * choice set for an item, and it is reached two ways: from `complete()`, inside the
   * stage's transaction, and from `next()` via `isChosen()`, in autocommit. In the second
   * one a crash between two siblings used to leave some rows carrying the new decision and
   * some the old — a set with two chosen attachments, which `isChosen` then reads as
   * settled because it short-circuits on whatever `attachmentChoice` returns.
   *
   * The atomicity therefore belongs to the primitive, not to one call site, and these two
   * tests are the two halves of that: the interruption, and the nesting the fix could
   * break — `BEGIN IMMEDIATE` inside an open transaction is an error on SQLite.
   */

  function libraryWithChoice(): { ledger: Ledger; lib: number } {
    const { ledger } = openLedger();
    const oid = ledger.registerOrigin('server-aaa');
    const lib = ledger.registerLibrary({ oid, kind: 'user', remoteId: 0, scope: 'local' });
    // The settled set: the oldest attachment carries the text, its siblings say why not.
    ledger.putAttachmentChoice(lib, 'ITEM0001', [
      { attachmentKey: 'ATTA0001', chosen: true },
      { attachmentKey: 'ATTA0002', chosen: false, reason: 'not-first-with-text' },
      { attachmentKey: 'ATTA0003', chosen: false, reason: 'not-first-with-text' },
    ]);
    return { ledger, lib };
  }

  /** The next extraction moved the choice from ATTA0001 to ATTA0002. */
  const relocated: AttachmentDecision[] = [
    { attachmentKey: 'ATTA0002', chosen: true },
    { attachmentKey: 'ATTA0001', chosen: false, reason: 'different-text' },
    { attachmentKey: 'ATTA0003', chosen: false, reason: 'not-first-with-text' },
  ];

  /**
   * Run `body` with the nth row-write of the choice set replaced by a throw.
   *
   * A power cut cannot be staged, so the injected failure stands in for one: it happens
   * between two `run`s of the same loop, which is exactly the window the ticket is about.
   * Only `run` is intercepted, and only on the statement that writes `attachment_choice`,
   * so the transaction's own `BEGIN`/`COMMIT`/`ROLLBACK` (`exec`, not `prepare`) and every
   * other statement are untouched.
   */
  function interruptAfter(ledger: Ledger, rows: number, body: () => void): void {
    const realPrepare = ledger.db.prepare.bind(ledger.db);
    let written = 0;
    (ledger.db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (!sql.includes('INSERT INTO attachment_choice')) return stmt;
      return {
        ...stmt,
        run: (...args: unknown[]) => {
          if (written++ === rows) throw new Error('injected crash mid-choice-set');
          return (stmt.run as (...a: unknown[]) => unknown)(...args);
        },
      };
    };
    try {
      body();
    } finally {
      (ledger.db as unknown as { prepare: unknown }).prepare = realPrepare;
    }
  }

  it('leaves the old choice set intact when the write is interrupted between two siblings', () => {
    const { ledger, lib } = libraryWithChoice();

    expect(() =>
      interruptAfter(ledger, 1, () => ledger.putAttachmentChoice(lib, 'ITEM0001', relocated)),
    ).toThrow(/injected crash/);

    // Whole or not at all: the set that is readable is the one that was there before, not
    // the first row of the new one grafted onto the last two of the old.
    const stored = ledger.attachmentChoices(lib, 'ITEM0001');
    expect(stored.map((r) => [r.attachmentKey, r.chosen, r.reason])).toEqual([
      ['ATTA0001', true, null],
      ['ATTA0002', false, 'not-first-with-text'],
      ['ATTA0003', false, 'not-first-with-text'],
    ]);
    // The half-written state named by name, because it is what `isChosen` cannot detect:
    // two attachments of one item both claiming the body text.
    expect(stored.filter((r) => r.chosen)).toHaveLength(1);

    // And the ledger is usable afterwards — a rollback that left the transaction open
    // would fail the next write instead, which is a different bug with the same test.
    ledger.putAttachmentChoice(lib, 'ITEM0001', relocated);
    expect(ledger.attachmentChoice(lib, 'ATTA0002')?.chosen).toBe(true);
    expect(ledger.attachmentChoice(lib, 'ATTA0001')?.reason).toBe('different-text');
    ledger.close();
  });

  it('writes the set from inside an open transaction, which is how `complete()` reaches it', () => {
    // The way the fix breaks. `complete()` already holds a transaction when `decide()` runs
    // under it, so a wrapper that always says `BEGIN IMMEDIATE` throws "cannot start a
    // transaction within a transaction" on the one path that was already correct.
    const { ledger, lib } = libraryWithChoice();

    expect(() =>
      ledger.transaction(() => {
        ledger.putAttachmentChoice(lib, 'ITEM0001', relocated);
      }),
    ).not.toThrow();

    expect(ledger.attachmentChoice(lib, 'ATTA0002')?.chosen).toBe(true);
    expect(ledger.attachmentChoice(lib, 'ATTA0001')?.chosen).toBe(false);
    ledger.close();
  });

  it('rolls the whole outer transaction back when the enclosing work fails', () => {
    // The other half of nesting: an inner savepoint that committed on its own would let a
    // choice set survive the failure of the completion it was part of, which is the
    // asymmetry this ticket exists to remove, pointing the other way.
    const { ledger, lib } = libraryWithChoice();

    expect(() =>
      ledger.transaction(() => {
        ledger.putAttachmentChoice(lib, 'ITEM0001', relocated);
        throw new Error('the completion this choice set belonged to lost its claim');
      }),
    ).toThrow(/lost its claim/);

    expect(ledger.attachmentChoice(lib, 'ATTA0001')?.chosen).toBe(true);
    expect(ledger.attachmentChoice(lib, 'ATTA0002')?.chosen).toBe(false);
    ledger.close();
  });

  it('still writes every row when nothing interrupts it', () => {
    // The control. An atomicity fix that quietly dropped rows would pass the test above.
    const { ledger, lib } = libraryWithChoice();
    ledger.putAttachmentChoice(lib, 'ITEM0001', relocated);
    const stored = ledger.attachmentChoices(lib, 'ITEM0001');
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => [r.attachmentKey, r.chosen])).toEqual([
      ['ATTA0001', false],
      ['ATTA0002', true],
      ['ATTA0003', false],
    ]);
    ledger.close();
  });
});
