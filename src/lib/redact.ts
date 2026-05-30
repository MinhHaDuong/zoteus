// Mask secret-bearing object keys before anything reaches the logs.
const SECRET_KEY = /(pass(code|word)?|secret|token|api[-_]?key|authorization|bearer|cookie|credential|client[-_]?(key|secret)|zoterokey)/i;
const MASK = '[REDACTED]';

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? MASK : redact(v, seen);
  }
  return out;
}

/** Deep-redact secret-ish keys in each argument; primitives pass through unchanged. */
export function redactArgs(args: unknown[]): unknown[] {
  return args.map((a) => redact(a, new WeakSet()));
}
