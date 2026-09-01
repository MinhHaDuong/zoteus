import type { Clock } from '../../src/features/search/conductor/clock.js';

/**
 * Fixture (c) of ticket 0551: the injected clock.
 *
 * Time only moves when a test moves it. That is what lets a suite assert the 60 s
 * reconcile cadence, a lease TTL and a claim expiry without any of them costing what
 * they measure, and it is why no test in this tranche calls `setTimeout` or sleeps:
 * a wait is `clock.advance(ms)`.
 *
 * `advance` refuses to go backwards. A monotonic clock is the assumption every expiry
 * comparison in the ledger and the tick is written against, so a test that hands one
 * backwards time is testing a machine that does not exist.
 */
export class ManualClock implements Clock {
  private t: number;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): number {
    if (ms < 0) throw new Error(`ManualClock cannot go backwards (advance ${ms})`);
    this.t += ms;
    return this.t;
  }

  set(ms: number): number {
    if (ms < this.t) throw new Error(`ManualClock cannot go backwards (set ${ms} < ${this.t})`);
    this.t = ms;
    return this.t;
  }
}
