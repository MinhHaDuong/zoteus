export interface Metrics {
  inc(name: string, by?: number, labels?: Record<string, string>): void;
  snapshot(): Record<string, number>;
  render(): string;
}

const keyOf = (name: string, labels?: Record<string, string>): string => {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`);
  return `${name}{${parts.join(',')}}`;
};

/** Minimal in-process counter registry; values are plain integers, never secrets. */
export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  return {
    inc(name, by = 1, labels) {
      const k = keyOf(name, labels);
      counters.set(k, (counters.get(k) ?? 0) + by);
    },
    snapshot() {
      return Object.fromEntries(counters);
    },
    render() {
      return [...counters.entries()].map(([k, v]) => `zoteus_${k} ${v}`).join('\n') + '\n';
    },
  };
}
