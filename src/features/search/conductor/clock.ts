/**
 * The one source of time the conductor reads.
 *
 * Every "each N seconds" in the design — the 60 s reconcile cadence, the unreachable
 * back-off, the lease TTL, the row-claim expiry — is a comparison against this, never
 * against `Date.now()` and never a `setTimeout`. Two reasons, and the second is the one
 * that shaped the interface.
 *
 * A test that has to wait for a cadence is a test that costs the cadence. A suite with
 * one 60 s tick in it cannot be run in a loop, so it is run rarely, so it stops being a
 * gate. Injecting the clock turns a minute into an assignment.
 *
 * And a real timer makes the *schedule* untestable rather than merely slow: whether the
 * tick fires at the right moment is exactly the property under test, and a suite that
 * sleeps for a while and then asserts "something happened" cannot distinguish firing on
 * time from firing at all. So the tick decides due-ness by arithmetic on this clock and
 * the caller drives it; nothing in the conductor sleeps.
 */
export interface Clock {
  /** Milliseconds since the epoch, on whatever timeline the caller installed. */
  now(): number;
}

/** The clock a running server uses. */
export const systemClock: Clock = { now: () => Date.now() }; // wall-clock: intentional
