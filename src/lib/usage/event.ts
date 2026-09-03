/**
 * What a usage event is, and what it is deliberately not.
 *
 * The whole point of this module is that an event carries enough to answer "which tools
 * does this subscriber use, how often, how fast, how often do they fail" and nothing that
 * could reconstruct what the user was looking for. So: tool names, outcomes, durations and
 * a numeric Zotero user id are recorded; search strings, item titles, note text and every
 * other ARGUMENT VALUE are not, and `describeShape` below is the only thing that ever
 * looks at arguments at all.
 *
 * Field names matter here beyond taste. `redactArgs` (src/lib/redact.ts) masks by key
 * name, so anything called `token`, `licenseKey` or `zoteroKey` is replaced before it can
 * be logged. Every name in `UsageEvent` is chosen to sit outside that regex, because a
 * masked field would be recorded as the literal string `[REDACTED]` rather than dropped.
 */

/** One recorded thing that happened: a tool call, an HTTP request, or an auth step. */
export interface UsageEvent {
  /** Epoch milliseconds. */
  ts: number;
  kind: 'tool' | 'http' | 'auth';
  /** Tool name, normalised route, or auth step. Never free text. */
  name: string;
  /** Zotero user id of the caller; absent for the operator context, stdio and anonymous. */
  userId?: number;
  /** OAuth client registration id (which MCP host is calling), not a secret. */
  clientId?: string;
  sessionId?: string;
  ok: boolean;
  /** Classified cause, never a message: messages quote library content. */
  errorKind?: string;
  ms: number;
  /** HTTP status, for `kind: 'http'`. */
  status?: number;
  /** Response size in bytes, where the transport knows it. */
  bytes?: number;
  /** Argument SHAPE only, from `describeShape`. */
  shape?: string;
}

/**
 * Where events go. The null implementation is the default everywhere, so instrumentation
 * added at a call site costs a function call and nothing else until an operator opts in.
 */
export interface UsageRecorder {
  record(ev: UsageEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const NULL_RECORDER: UsageRecorder = {
  record() {},
  flush: async () => {},
  close: async () => {},
};

/** Values a shape description may contain, so the rule below is checkable by reading it. */
const MAX_SHAPE_KEYS = 24;

/**
 * A description of an argument object that contains no argument value.
 *
 * `{"q":"string(31)","limit":"number","fulltext":true}` — key names, types, string and
 * array LENGTHS, and booleans. Booleans are the one value kept: `fulltext:true` is a
 * product question worth answering and cannot carry content. Strings never are, with no
 * exception for the ones that look enum-shaped (`action`, `sort`), because one exception
 * is how a `q` eventually gets recorded.
 */
export function describeShape(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_SHAPE_KEYS) break;
    if (v === undefined || v === null) continue;
    out[k] =
      typeof v === 'boolean'
        ? v
        : typeof v === 'string'
          ? `string(${v.length})`
          : typeof v === 'number'
            ? 'number'
            : Array.isArray(v)
              ? `array(${v.length})`
              : typeof v === 'object'
                ? `object(${Object.keys(v as object).length})`
                : typeof v;
  }
  const keys = Object.keys(out);
  if (!keys.length) return undefined;
  return JSON.stringify(out);
}

/**
 * A stable, low-cardinality name for why a call failed.
 *
 * Duck-typed rather than instanceof-ed so this module stays free of the Zotero client and
 * the search index: importing either from here would pull half the server into the logger's
 * dependency graph. `ZoteroApiError` carries a numeric `status`, which is the distinction
 * that matters most in practice (a 403 is a key problem, a 429 is our own rate limiting).
 */
export function classifyError(err: unknown): string {
  const e = (err ?? {}) as { name?: string; status?: number; code?: string };
  if (typeof e.status === 'number') return `zotero_${Math.floor(e.status / 100)}xx`;
  if (e.name === 'ZodError') return 'validation';
  if (typeof e.code === 'string' && e.code.startsWith('ERR_SQLITE')) return 'sqlite';
  if (typeof e.code === 'string' && /ABORT|TIMEOUT|ETIMEDOUT/i.test(e.code)) return 'timeout';
  if (typeof e.code === 'string') return e.code.toLowerCase();
  return e.name && e.name !== 'Error' ? e.name : 'error';
}
