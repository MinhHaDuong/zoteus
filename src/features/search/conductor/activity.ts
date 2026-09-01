import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

/**
 * Foreground preemption, level 1 of §5.2.5's priority tree: a query in flight beats all
 * indexing.
 *
 * Each P0 touches `<dataDir>/activity` when a query arrives — a filesystem operation, so
 * the query path stays write-free even in the database sense — and the worker stats that
 * file between units of work, idling while it is fresh. Between *units*, never inside one:
 * that is what makes preemption effective rather than nominal, and for the extract stage
 * the unit is one document, because the whole-document GET has no boundary inside it
 * (§5.2.4).
 *
 * **The probe is injected, and that is not only for testing.** The freshness of a file is
 * wall-clock by construction, where every cadence in this tranche is arithmetic on an
 * injected clock; splitting the two lets a suite drive both on one timeline instead of
 * mixing a real mtime into a manual one, which would be a test measuring the filesystem.
 */

/** §5.2.5: the worker idles this long while the activity file is fresh. */
export const ACTIVITY_IDLE_MS = 2_000;

/** The file every P0 touches on query arrival, under the search data directory. */
export const ACTIVITY_FILE = 'activity';

export interface ActivityProbe {
  /** When the file was last touched, or null when it has never been. */
  lastTouchedAt(): number | null;
}

/**
 * The real probe. A missing file is "no query yet", not an error: the file appears the
 * first time somebody searches, and a worker that refused to run before then would refuse
 * to run on exactly the library that has never been queried.
 */
export function fileActivityProbe(dataDir: string, name: string = ACTIVITY_FILE): ActivityProbe {
  const path = join(dataDir, name);
  return {
    lastTouchedAt(): number | null {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}

export interface ActivityGateOptions {
  probe: ActivityProbe;
  clock?: Clock;
  idleMs?: number;
}

/**
 * How long the worker should stand aside before its next unit of work.
 *
 * It reports rather than sleeps, for the reason `clock.ts` gives: the caller's injected
 * `sleep` is what takes the wait, so a suite can assert that the yield happened and how
 * long it was without paying for it.
 */
export class ActivityGate {
  private readonly probe: ActivityProbe;
  private readonly clock: Clock;
  private readonly idleMs: number;

  /** Counted for the instrument panel: how often indexing stood aside for a query. */
  yields = 0;
  totalYieldMs = 0;

  constructor(opts: ActivityGateOptions) {
    this.probe = opts.probe;
    this.clock = opts.clock ?? systemClock;
    this.idleMs = opts.idleMs ?? ACTIVITY_IDLE_MS;
  }

  /** Milliseconds to idle, or 0 when nothing is in the foreground. */
  yieldMs(): number {
    const touched = this.probe.lastTouchedAt();
    if (touched === null) return 0;
    // The remainder of the idle window, not the whole window: a file touched 1,9 s ago
    // leaves 100 ms, and restarting the full wait on every check would turn a single query
    // into an indefinite pause under a slow trickle of them.
    const remaining = touched + this.idleMs - this.clock.now();
    if (remaining <= 0) return 0;
    this.yields++;
    this.totalYieldMs += remaining;
    return remaining;
  }
}
