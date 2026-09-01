import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

/**
 * The extract worker's latency-observed back-off (SPEC.md §5.2.4; DECISIONS.md,
 * 2026-09-01).
 *
 * On a rising local-API latency median the worker inserts a delay between document
 * fetches, decaying on recovery, reported on the instrument panel. The point is to react
 * to degradation *before* an error, because the process serving these requests is Zotero's
 * own: its sync engine and its PDF indexer can saturate it without any help from us, and a
 * sequential fetcher holding a steady rate through that still competes with the user's own
 * interface. Upstream's #39 reached the same conclusion from the other side, having watched
 * concurrency stop Zotero answering on its port; what this repo does not adopt from it is
 * the fall back to the Web API, which sends library reads to a cloud service by a path the
 * user did not choose for that build (ticket 0505).
 *
 * **Median, not mean.** One 3-second document on an otherwise quiet library is not
 * degradation, and a mean lets it look like one for the whole window.
 *
 * **The baseline only ever falls.** Degradation is measured against the quietest median
 * this worker has seen, so a machine that is *persistently* slow keeps paying the delay
 * rather than normalising to its own bad state — which is the intent: if the local API is
 * permanently struggling, permanently giving it room is the correct politeness. A baseline
 * that drifted upward under sustained load would switch the back-off off exactly while it
 * was needed.
 *
 * **And the absolute floor is what keeps that honest.** Against a baseline of 2 ms, a
 * ratio test alone reads 6 ms as a tripling and backs off; on a fast library every ordinary
 * scheduling jitter would then look like Zotero in trouble. A local HTTP round trip that
 * hands over a whole document is tens of milliseconds, so below the floor there is nothing
 * to protect Zotero from. The suite's third arm — a ramp that is large in ratio and trivial
 * in milliseconds — is red without the floor and is what pins it.
 *
 * Constants: an arbitration, not a measurement. The author ruled the shape and declined a
 * measurement on the ground that it would have spoken for one machine where the back-off
 * protects every installation, so no ratified number exists to read from SPEC.md. The one
 * derived rather than chosen is the ceiling: a pacing delay is taken before the next row is
 * claimed, but even so it must stay well under the row-claim TTL of 30 × the ~1 s
 * micro-batch quantum (§5.2.5), or the worker's own politeness would expire the claim and
 * have the row re-dispatched — duplicating the very fetch it was slowing down.
 *
 * **Nothing here sleeps.** The pacer reports a delay; the worker's injected `sleep` is what
 * takes it, exactly as every other cadence in this tranche is arithmetic on the clock.
 */

/** How many recent fetches the median is taken over. */
export const PACE_WINDOW = 8;

/** Below this many samples there is no verdict: a median of two is not a median. */
export const PACE_MIN_SAMPLES = 4;

/** A doubling of the quietest median seen. Smaller ratios are noise on a desktop machine. */
export const PACE_DEGRADED_RATIO = 2;

/** Under this, nothing is degraded in any way that matters. See the floor note above. */
export const PACE_DEGRADED_FLOOR_MS = 50;

/** The first delay, and the granularity below which the decay lands on zero. */
export const PACE_STEP_MS = 250;

/** Derived from the row-claim TTL (~30 s), not chosen. See the constants note above. */
export const PACE_CEILING_MS = 8_000;

export interface FetchPacerOptions {
  clock?: Clock;
  windowSize?: number;
  minSamples?: number;
  ratio?: number;
  floorMs?: number;
  stepMs?: number;
  ceilingMs?: number;
}

/** What the instrument panel shows, mirroring upstream's `localApiDegradedAt`. */
export interface PacerReport {
  samples: number;
  medianMs: number | null;
  baselineMs: number | null;
  degraded: boolean;
  /** When the current degraded episode began, or null while the API is behaving. */
  degradedAt: number | null;
  delayMs: number;
  /** How many fetches have been delayed, and by how much in total, since startup. */
  delayedFetches: number;
  totalDelayMs: number;
}

export class FetchPacer {
  private readonly clock: Clock;
  private readonly windowSize: number;
  private readonly minSamples: number;
  private readonly ratio: number;
  private readonly floorMs: number;
  private readonly stepMs: number;
  private readonly ceilingMs: number;

  private readonly recent: number[] = [];
  private samples = 0;
  private baseline: number | null = null;
  private current: number | null = null;
  private delay = 0;
  private degradedAt: number | null = null;
  private delayedFetches = 0;
  private totalDelayMs = 0;

  constructor(opts: FetchPacerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.windowSize = opts.windowSize ?? PACE_WINDOW;
    this.minSamples = opts.minSamples ?? PACE_MIN_SAMPLES;
    this.ratio = opts.ratio ?? PACE_DEGRADED_RATIO;
    this.floorMs = opts.floorMs ?? PACE_DEGRADED_FLOOR_MS;
    this.stepMs = opts.stepMs ?? PACE_STEP_MS;
    this.ceilingMs = opts.ceilingMs ?? PACE_CEILING_MS;
  }

  /** What the worker should wait before the next document fetch. 0 while the API behaves. */
  get delayMs(): number {
    return this.delay;
  }

  /** Record one fetch's observed latency and re-decide the delay. */
  observe(latencyMs: number): void {
    this.recent.push(Math.max(0, latencyMs));
    if (this.recent.length > this.windowSize) this.recent.shift();
    this.samples++;

    if (this.samples < this.minSamples) return;
    const median = medianOf(this.recent);
    this.current = median;
    // Only downward, and only from a window that has something to say. This is what makes
    // the reference the quietest state observed rather than a moving average of the load.
    if (this.baseline === null || median < this.baseline) this.baseline = median;

    if (this.isDegraded(median)) {
      this.degradedAt ??= this.clock.now();
      this.delay = Math.min(this.ceilingMs, this.delay === 0 ? this.stepMs : this.delay * 2);
      return;
    }
    this.degradedAt = null;
    // Halving rather than dropping to zero: recovery is observed over a window, so the
    // first quiet document after a storm is weak evidence that the storm is over.
    this.delay = this.delay <= this.stepMs ? 0 : Math.floor(this.delay / 2);
  }

  /** Called by the worker when it has actually taken a delay, for the panel's counters. */
  recordDelay(ms: number): void {
    if (ms <= 0) return;
    this.delayedFetches++;
    this.totalDelayMs += ms;
  }

  report(): PacerReport {
    return {
      samples: this.samples,
      medianMs: this.current,
      baselineMs: this.baseline,
      degraded: this.current !== null && this.isDegraded(this.current),
      degradedAt: this.degradedAt,
      delayMs: this.delay,
      delayedFetches: this.delayedFetches,
      totalDelayMs: this.totalDelayMs,
    };
  }

  private isDegraded(median: number): boolean {
    if (this.baseline === null) return false;
    return median >= this.floorMs && median >= this.baseline * this.ratio;
  }
}

/** The upper median on an even window, so a two-sample window reports the slower of them. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
