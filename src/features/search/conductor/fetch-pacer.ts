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
 * **The baseline is a low quantile of a bounded recent past**, and both halves of that are
 * corrections to a first draft that used the all-time minimum.
 *
 * A minimum is not robust, by construction. One early burst of near-instant answers — a run
 * of attachments Zotero has no text for, a few tiny snapshots — pins it near zero, and a
 * perfectly healthy machine then reads as permanently degraded and paces at the ceiling for
 * the rest of the run, with no path back, because a minimum never rises. Review round 1
 * reproduced exactly that against a control. Bounding the horizon alone does not fix it: the
 * burst still governs until it ages out, which on a real backlog is most of a run. A
 * quantile is what actually fixes it, because a handful of unrepresentative samples cannot
 * move one.
 *
 * The quantile is low rather than central because what is wanted is the machine's *quiet*
 * state, not its typical one — a median-of-medians would call a machine undegraded whenever
 * half its recent history was already slow.
 *
 * One thing this does not promise, stated rather than argued away: sustained degradation
 * stops being degradation once it has lasted a whole horizon, and the worker returns to full
 * rate against a machine that is uniformly slow. The alternative buys permanence at the
 * price of a back-off no observation can ever switch off.
 *
 * **The absolute floor covers the other end.** Against a baseline of 2 ms, a ratio test
 * alone reads 6 ms as a tripling and backs off; on a fast library every ordinary scheduling
 * jitter would then look like Zotero in trouble. A local HTTP round trip is tens of
 * milliseconds, so below the floor there is nothing to protect Zotero from. The suite's
 * third arm — a ramp that is large in ratio and trivial in milliseconds — is red without the
 * floor and is what pins it.
 *
 * **What is measured is the time to the response, never the time to the last byte.** The
 * whole-read duration is dominated by document size (`document-stream.ts`), so a median over
 * it measures the corpus rather than the server.
 *
 * Constants: an arbitration, not a measurement. The author ruled the shape and declined a
 * measurement on the ground that it would have spoken for one machine where the back-off
 * protects every installation, so no ratified number exists to read from SPEC.md. The one
 * derived rather than chosen is the ceiling, and it is derived against the TTL the code
 * actually uses. §5.2.5 pins the row-claim TTL at 30 × the ~1 s micro-batch quantum, but
 * `ExtractStage` claims at `LEASE_TTL_MS` — 20 s, the constant the lease machinery already
 * carries — so the margin a ceiling of 8 s leaves is 12 s, not 22 s. That is still the right
 * side of the line and the number is stated rather than inferred from the spec's 30, because
 * a pacing delay long enough to outlive the claim would have the row re-dispatched and
 * duplicate the very fetch it was slowing down.
 *
 * **Nothing here sleeps.** The pacer reports a delay; the worker's injected `sleep` is what
 * takes it, exactly as every other cadence in this tranche is arithmetic on the clock.
 */

/** How many recent fetches the median is taken over. */
export const PACE_WINDOW = 8;

/**
 * How far back the baseline looks.
 *
 * Long enough that a normal working stretch defines what quiet means, short enough that one
 * unrepresentative episode ages out rather than governing forever. Eight times the detection
 * window, so recovery is always observable well inside it.
 */
export const PACE_BASELINE_WINDOW = 64;

/**
 * Where in that history "quiet" is read off. A quarter of the way up: below typical, so a
 * genuine rise above it is a rise; far enough from the floor that a short burst of
 * unrepresentatively fast answers cannot drag it down.
 */
export const PACE_BASELINE_QUANTILE = 0.25;

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
  baselineWindow?: number;
  baselineQuantile?: number;
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
  private readonly baselineWindow: number;
  private readonly baselineQuantile: number;
  private readonly minSamples: number;
  private readonly ratio: number;
  private readonly floorMs: number;
  private readonly stepMs: number;
  private readonly ceilingMs: number;

  private readonly recent: number[] = [];
  private readonly medians: number[] = [];
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
    this.baselineWindow = opts.baselineWindow ?? PACE_BASELINE_WINDOW;
    this.baselineQuantile = opts.baselineQuantile ?? PACE_BASELINE_QUANTILE;
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
    // Recomputed rather than ratcheted, which is the whole difference from the all-time
    // minimum: an episode that no longer describes this machine stops describing it, and the
    // back-off it caused can end.
    this.medians.push(median);
    if (this.medians.length > this.baselineWindow) this.medians.shift();
    this.baseline = quantileOf(this.medians, this.baselineQuantile);

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

  /**
   * Degraded means both: absolutely slow enough to matter, and a real rise above quiet.
   *
   * The baseline is read no quieter than the floor, and that clamp is what closes the last
   * hole review round 1 found. Against a baseline near zero the ratio test is vacuous —
   * every latency exceeds twice nothing — so the floor alone decides, and a 60 ms machine
   * that had one instant moment reads as degraded on a comparison that carried no
   * information. The clamp follows from what the floor already asserts: below it nothing is
   * degradation, so a baseline below it says nothing about degradation either, and the
   * quietest state worth comparing against is the floor itself.
   */
  private isDegraded(median: number): boolean {
    if (this.baseline === null) return false;
    const quiet = Math.max(this.baseline, this.floorMs);
    return median >= this.floorMs && median >= quiet * this.ratio;
  }
}

/** The upper median on an even window, so a two-sample window reports the slower of them. */
function medianOf(values: number[]): number {
  return quantileOf(values, 0.5);
}

/** Nearest-rank, which needs no interpolation and cannot invent a latency nobody observed. */
function quantileOf(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}
