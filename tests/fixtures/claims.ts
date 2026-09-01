import type { Ledger } from '../../src/features/search/conductor/ledger.js';

/**
 * Complete a work order from the test's own hand, the way a stage would.
 *
 * Completion is owned since ticket 0553's round-2 fix: `markDone`/`markFailed` take the
 * ticket `claim` granted and refuse a write from anyone else, so there is no longer a way
 * to finish a row without first holding it. A test that only wants a row out of the queue —
 * "the record for this item is written" — takes the claim and gives it back, which is one
 * line and exercises the guard on the ordinary path at the same time.
 */
export function completeByHand(ledger: Ledger, wid: number, holder = 'by-hand'): boolean {
  const claim = ledger.claimTicket(wid, holder, '', 60_000);
  if (!claim) return false;
  return ledger.markDone(claim);
}
