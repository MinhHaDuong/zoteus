export interface Metrics {
  inc(name: string, by?: number, labels?: Record<string, string>): void;
  /**
   * Record one measurement (a duration in milliseconds) into a Prometheus histogram.
   *
   * Histogram rather than an average, because the average latency of a library tool is
   * uninformative: the interesting question is how often a call is slow, and a mean over a
   * bimodal population (cache hit vs. Zotero round trip) answers neither half.
   */
  observe(name: string, value: number, labels?: Record<string, string>): void;
  snapshot(): Record<string, number>;
  render(): string;
}

/**
 * Bucket ceilings in milliseconds, cumulative in the Prometheus sense.
 *
 * Chosen for the shape of this server's work rather than from a default list: under 25 ms
 * is a local answer, a few hundred is one Zotero API round trip, seconds are embedding and
 * index work, and past ten seconds a host has usually given up on the call anyway.
 */
const BUCKETS_MS = [5, 25, 100, 500, 2000, 10_000];

const keyOf = (name: string, labels?: Record<string, string>): string => {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `${name}{${parts.join(',')}}`;
};

/** Prometheus label values escape backslash, double quote and newline; nothing else. */
const escapeLabel = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** The series name without its labels, and without a histogram's suffix. */
const baseOf = (key: string): string => {
  const name = key.includes('{') ? key.slice(0, key.indexOf('{')) : key;
  return name.replace(/_(bucket|sum|count)$/, '');
};

/** Minimal in-process counter registry; values are plain integers, never secrets. */
export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const types = new Map<string, 'counter' | 'histogram'>();
  const bump = (key: string, by: number): void => {
    counters.set(key, (counters.get(key) ?? 0) + by);
  };
  return {
    inc(name, by = 1, labels) {
      types.set(baseOf(name), types.get(baseOf(name)) ?? 'counter');
      bump(keyOf(name, labels), by);
    },
    observe(name, value, labels) {
      types.set(name, 'histogram');
      // Cumulative buckets: a 30 ms call counts in le="100" and every bucket above it, which
      // is what makes a rate() over two buckets a proportion rather than a subtraction.
      for (const le of BUCKETS_MS) {
        if (value <= le) bump(keyOf(`${name}_bucket`, { ...labels, le: String(le) }), 1);
      }
      bump(keyOf(`${name}_bucket`, { ...labels, le: '+Inf' }), 1);
      bump(keyOf(`${name}_sum`, labels), Math.max(0, value));
      bump(keyOf(`${name}_count`, labels), 1);
    },
    snapshot() {
      return Object.fromEntries(counters);
    },
    render() {
      // Grouped by series so each `# TYPE` line precedes the samples it describes, which is
      // what a scraper requires; within a group insertion order is kept, so a histogram's
      // buckets stay in the order they were first touched.
      const groups = new Map<string, string[]>();
      for (const [k, v] of counters) {
        const base = baseOf(k);
        const lines = groups.get(base) ?? [];
        lines.push(`zoteus_${k} ${v}`);
        groups.set(base, lines);
      }
      const out: string[] = [];
      for (const [base, lines] of groups) {
        out.push(`# TYPE zoteus_${base} ${types.get(base) ?? 'counter'}`);
        out.push(...lines);
      }
      return `${out.join('\n')}\n`;
    },
  };
}
