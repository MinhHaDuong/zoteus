import { Semaphore } from '../lib/semaphore.js';
import { ZoteroApiError } from './errors.js';
import type { Logger } from '../lib/logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateLimitedFetcherOptions {
  maxConcurrency?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
  defaultDeadlineMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-request time budget (covers the whole retry/backoff loop). Bounded so a stuck or
 * rate-limited request fails fast with actionable guidance instead of hanging until the
 * MCP connector's own per-call timeout fires (which surfaces to the model as an opaque
 * error). A single request rarely needs this long; the budget mainly caps retry/backoff
 * accumulation, so it leaves healthy batch requests (each fast) untouched. */
const DEFAULT_DEADLINE_MS = 25_000;

/**
 * Wraps fetch with the behavior every Zotero client must follow:
 *  - cap concurrent requests (default 4),
 *  - honor the `Backoff` header (applies to all subsequent requests),
 *  - retry on 429/503 honoring `Retry-After`, with exponential fallback,
 *  - bound total time per request so it fails fast (not hang) past `deadlineMs`.
 */
export class RateLimitedFetcher {
  private readonly sem: Semaphore;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: Logger;
  private readonly defaultDeadlineMs: number;
  private backoffUntil = 0;

  constructor(opts: RateLimitedFetcherOptions = {}) {
    this.sem = new Semaphore(opts.maxConcurrency ?? 4);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.logger = opts.logger;
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  async fetch(
    url: string,
    init?: RequestInit,
    opts?: { maxRetries?: number; deadlineMs?: number },
  ): Promise<Response> {
    const maxRetries = opts?.maxRetries ?? 4;
    const deadlineMs = opts?.deadlineMs ?? this.defaultDeadlineMs;
    const start = Date.now();
    const remaining = () => deadlineMs - (Date.now() - start);
    return this.sem.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, remaining()));
      (timer as { unref?: () => void }).unref?.();
      // Did Zotero actually signal rate-limiting (429/503 or a Backoff header) during THIS
      // request? Used to attribute a budget overrun correctly: a slow single response with no
      // such signal is an expensive query, not throttling — and they want opposite remedies.
      let sawRateLimit = false;
      try {
        let attempt = 0;
        for (;;) {
          // Honor any global backoff, but never sleep past our deadline.
          const backoffWait = this.backoffUntil - Date.now();
          if (backoffWait > 0) {
            sawRateLimit = true;
            if (backoffWait >= remaining()) throw this.timeoutError(deadlineMs, sawRateLimit);
            await sleep(backoffWait);
          }
          if (remaining() <= 0) throw this.timeoutError(deadlineMs, sawRateLimit);

          let res: Response;
          try {
            res = await this.fetchImpl(url, { ...init, signal: controller.signal });
          } catch (e) {
            if (controller.signal.aborted) throw this.timeoutError(deadlineMs, sawRateLimit);
            throw e;
          }
          this.observeBackoff(res);
          if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
            sawRateLimit = true;
            const wait = this.retryDelayMs(res, attempt);
            // Fail fast rather than sleep past the budget into a connector timeout.
            if (wait >= remaining()) throw this.timeoutError(deadlineMs, sawRateLimit);
            this.logger?.warn(
              `Zotero ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            await sleep(wait);
            attempt++;
            continue;
          }
          return res;
        }
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Build the budget-exceeded error. Two distinct causes need opposite remedies, so the
   * message must not conflate them:
   *  - `rateLimited` (saw a 429/503/Backoff): Zotero throttled us; back off and serialize.
   *  - otherwise: a single upstream response was simply slow (e.g. a full-text
   *    qmode=everything scan on a large library); narrowing the query is the fix, and
   *    "avoid parallel batches" would be misleading for one request.
   */
  private timeoutError(deadlineMs: number, rateLimited: boolean): ZoteroApiError {
    const secs = Math.max(1, Math.round(deadlineMs / 1000));
    const message = rateLimited
      ? `Zotero rate-limited this request and the required back-off exceeded the ${secs}s budget. ` +
        'Retry sequentially — avoid parallel batches — and keep responses concise.'
      : `Zotero took longer than the ${secs}s budget to answer a single request, with no throttling/back-off signal. ` +
        'This is usually an expensive query — e.g. a full-text search (qmode=everything) over a large library. ' +
        'Narrow the query, lower the limit, or retry.';
    return new ZoteroApiError({ status: 408, message });
  }

  private observeBackoff(res: Response): void {
    const backoff = res.headers.get('backoff');
    if (backoff) {
      const secs = Number(backoff);
      if (Number.isFinite(secs) && secs > 0) {
        this.backoffUntil = Math.max(this.backoffUntil, Date.now() + secs * 1000);
      }
    }
  }

  private retryDelayMs(res: Response, attempt: number): number {
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return secs * 1000;
    }
    return Math.min(2 ** attempt * 500, 30_000);
  }
}
