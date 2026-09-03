/**
 * Turning raw events into the small table that outlives them.
 *
 * Raw events are pruned (30 days by default); the daily rollup is kept forever, because
 * it is about a kilobyte a day and it is what answers "were we growing in March". Both
 * halves of that arrangement depend on the aggregation being a pure function of the rows
 * it is handed, so it lives here with no database in sight and the store calls it.
 */

/** One aggregated line: a day, what happened, and to whom. */
export interface DailyRow {
  /** UTC `YYYY-MM-DD`. */
  day: string;
  kind: string;
  name: string;
  /** Zotero user id, or null for calls made without a per-user identity. */
  userId: number | null;
  calls: number;
  errors: number;
  msSum: number;
  msP50: number;
  msP95: number;
  msMax: number;
}

/** The fields aggregation needs; a subset of a stored event row. */
export interface AggregableEvent {
  ts: number;
  kind: string;
  name: string;
  userId: number | null;
  ok: boolean;
  ms: number;
}

/**
 * UTC day of an epoch-millisecond timestamp.
 *
 * UTC and not the host's zone: the VM's clock, a laptop reading the file, and a rollup
 * recomputed after a timezone change must all agree on which day a call belongs to, and
 * only UTC gives that for free.
 */
export function dayOf(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Nearest-rank percentile over an ascending array. `p` is a fraction (0.95).
 *
 * Nearest-rank rather than interpolated because these are latencies of real calls: p95
 * should be a duration that actually happened, which is what makes it quotable in an
 * issue.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const rank = Math.ceil(p * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))]!;
}

const keyOf = (e: AggregableEvent): string =>
  JSON.stringify([dayOf(e.ts), e.kind, e.name, e.userId]);

/**
 * Group events by (day, kind, name, user) and summarise each group.
 *
 * Granular on purpose — per user AND per tool, rather than a pre-summed daily total. The
 * questions worth asking later ("who stopped calling", "is semantic search the slow one
 * for everybody or for one library") are answerable from this grain and unanswerable from
 * anything coarser, and at four subscribers the row count is not a consideration.
 */
export function aggregate(events: AggregableEvent[]): DailyRow[] {
  const groups = new Map<string, { row: Omit<DailyRow, 'msP50' | 'msP95'>; durations: number[] }>();
  for (const e of events) {
    const key = keyOf(e);
    let g = groups.get(key);
    if (!g) {
      g = {
        row: {
          day: dayOf(e.ts),
          kind: e.kind,
          name: e.name,
          userId: e.userId,
          calls: 0,
          errors: 0,
          msSum: 0,
          msMax: 0,
        },
        durations: [],
      };
      groups.set(key, g);
    }
    g.row.calls += 1;
    if (!e.ok) g.row.errors += 1;
    g.row.msSum += e.ms;
    g.row.msMax = Math.max(g.row.msMax, e.ms);
    g.durations.push(e.ms);
  }
  return [...groups.values()].map(({ row, durations }) => {
    durations.sort((a, b) => a - b);
    return { ...row, msP50: percentile(durations, 0.5), msP95: percentile(durations, 0.95) };
  });
}

/**
 * Run `task` every `intervalMs`, starting one interval from now, without holding the
 * process open.
 *
 * `unref` is the whole reason this is a function rather than a `setInterval` at the call
 * site: a maintenance timer that kept Node alive would turn a clean stdio shutdown into a
 * hang, and the timer has nothing to do that a restart would not redo.
 */
export function scheduleMaintenance(task: () => void, intervalMs: number): () => void {
  const timer = setInterval(task, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
