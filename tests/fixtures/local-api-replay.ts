import type { FetchLike } from '../../src/api/http.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { LocalApiClient } from '../../src/api/local-client.js';
import type { ManualClock } from './clock.js';

/**
 * Fixture (a) of ticket 0551: a record/replay fake of the Zotero desktop local API.
 *
 * It fakes the *wire*, not the client. Requests go through the real `LocalApiClient` and
 * the real `RateLimitedFetcher`; only `fetchImpl` is ours. That boundary is the whole
 * value of the fixture: a fake at the client level would answer with objects the client
 * was never asked to parse, so every trap the parsing carries — a missing `Total-Results`
 * header falling back rather than reading as 0, `format=versions` answering an object
 * where `/items` answers an array, a 404 meaning "no full text" rather than "app down" —
 * would be faked away along with the transport.
 *
 * **Replay.** `put()` registers one canned response against one method-path-query key.
 * Queries are normalised by sorting the parameters, so a route survives a caller
 * reordering them. An unregistered route throws by default (`strict`), because a fake
 * that answers 404 to a request nobody meant to make turns a typo in a test into a
 * plausible negative result.
 *
 * **Record.** `recorder()` wraps a real fetch, passes every call through and captures
 * what came back into the same table `put()` fills. `cassette()` serialises it and
 * `load()` reads it back, so the canned set in a test can be replaced by one captured
 * from a real profile without any test changing.
 *
 * **Silence and latency**, the two conditions the tick has to survive and no canned
 * response can express. `silent` makes every call fail the way a desktop app that is not
 * running fails — Node's own `TypeError: fetch failed` — so the back-off path is
 * exercised by the error the real thing raises. `latencyMs` is *charged to the injected
 * clock* rather than waited out: the tranche-3 back-off reads the latency it observed,
 * and observing it must not cost it. Nothing here sleeps.
 */

export interface CannedResponse {
  status?: number;
  body?: unknown;
  /** A raw body, for the endpoints that do not answer JSON — `/items/<key>/file`. */
  text?: string;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  key: string;
  /** What the clock read when the request was issued, plus whatever latency was charged. */
  at: number;
}

export type Cassette = Record<string, CannedResponse>;

export class ReplayLocalApi {
  private readonly routes = new Map<string, CannedResponse>();
  private readonly clock: ManualClock | undefined;
  private readonly base: string;

  readonly requests: RecordedRequest[] = [];

  /** Every call fails as an unreachable desktop app does. */
  silent = false;

  /** Charged to the injected clock on each call, and reported back in `requests`. */
  latencyMs = 0;

  /** An unregistered route throws. Turn off only to test a caller's 404 handling. */
  strict = true;

  constructor(opts: { clock?: ManualClock; port?: number } = {}) {
    this.clock = opts.clock;
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
  }

  /** Register (or overwrite) one canned response. `route` is a path with optional query. */
  put(route: string, response: CannedResponse): this {
    this.routes.set(normalise('GET', route), response);
    return this;
  }

  /** Drop every registered route. Used when a fixture re-installs after a mutation. */
  clear(): this {
    this.routes.clear();
    return this;
  }

  has(route: string): boolean {
    return this.routes.has(normalise('GET', route));
  }

  cassette(): Cassette {
    return Object.fromEntries(this.routes);
  }

  load(cassette: Cassette): this {
    for (const [key, response] of Object.entries(cassette)) this.routes.set(key, response);
    return this;
  }

  /** The `fetchImpl` a `RateLimitedFetcher` takes. */
  readonly fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.startsWith(this.base) ? url.slice(this.base.length) : url;
    const key = normalise(method, path);
    const at = this.clock?.advance(this.latencyMs) ?? Date.now();
    this.requests.push({ method, url, key, at });

    if (this.silent) {
      // Node's own shape for a refused or dropped connection. The tick's back-off is
      // written against what the runtime actually raises, not against a sentinel of ours.
      throw new TypeError('fetch failed');
    }

    const canned = this.routes.get(key);
    if (!canned) {
      if (this.strict) {
        throw new Error(
          `ReplayLocalApi: no canned response for ${key}. Registered: ${[...this.routes.keys()].join(', ') || '(none)'}`,
        );
      }
      return jsonResponse(404, { error: 'not found' });
    }
    if (canned.text !== undefined) {
      return new Response(canned.text, {
        status: canned.status ?? 200,
        headers: { 'content-type': 'application/octet-stream', ...(canned.headers ?? {}) },
      });
    }
    return jsonResponse(canned.status ?? 200, canned.body, canned.headers);
  };

  /** A real `LocalApiClient` wired to this fake. */
  client(): LocalApiClient {
    const fetcher = new RateLimitedFetcher({ fetchImpl: this.fetchImpl });
    return new LocalApiClient({ fetcher, probeFetcher: fetcher });
  }

  /**
   * Record mode: pass every call through to `real` and capture the answer. Run once
   * against a live Zotero to produce a cassette; every replay after that is offline.
   */
  recorder(real: FetchLike): FetchLike {
    return async (url, init) => {
      const res = await real(url, init);
      const path = url.startsWith(this.base) ? url.slice(this.base.length) : url;
      const clone = res.clone();
      let body: unknown;
      try {
        body = await clone.json();
      } catch {
        body = undefined;
      }
      this.put(path, {
        status: res.status,
        body,
        headers: {
          'total-results': res.headers.get('total-results') ?? '',
          'last-modified-version': res.headers.get('last-modified-version') ?? '',
          'zotero-server-id': res.headers.get('zotero-server-id') ?? '',
        },
      });
      return res;
    };
  }
}

/**
 * `GET /users/0/items?format=versions&since=3` and `…?since=3&format=versions` are the
 * same request; a route table keyed on the raw string says they are not. Sorting the
 * parameters is what lets a cassette recorded through one caller replay through another.
 */
function normalise(method: string, route: string): string {
  const [path, query = ''] = route.split('?', 2) as [string, string?];
  const params = [...new URLSearchParams(query).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = params.map(([k, v]) => `${k}=${v}`).join('&');
  return `${method} ${path}${sorted ? `?${sorted}` : ''}`;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const clean: Record<string, string> = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(headers)) if (v !== '') clean[k] = v;
  return new Response(status === 204 ? null : JSON.stringify(body ?? null), { status, headers: clean });
}
