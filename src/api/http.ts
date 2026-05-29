import { Semaphore } from '../lib/semaphore.js';
import type { Logger } from '../lib/logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateLimitedFetcherOptions {
  maxConcurrency?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wraps fetch with the behavior every Zotero client must follow:
 *  - cap concurrent requests (default 4),
 *  - honor the `Backoff` header (applies to all subsequent requests),
 *  - retry on 429/503 honoring `Retry-After`, with exponential fallback.
 */
export class RateLimitedFetcher {
  private readonly sem: Semaphore;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: Logger;
  private backoffUntil = 0;

  constructor(opts: RateLimitedFetcherOptions = {}) {
    this.sem = new Semaphore(opts.maxConcurrency ?? 4);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.logger = opts.logger;
  }

  async fetch(url: string, init?: RequestInit, opts?: { maxRetries?: number }): Promise<Response> {
    const maxRetries = opts?.maxRetries ?? 4;
    return this.sem.run(async () => {
      let attempt = 0;
      for (;;) {
        await this.waitForBackoff();
        const res = await this.fetchImpl(url, init);
        this.observeBackoff(res);
        if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
          const wait = this.retryDelayMs(res, attempt);
          this.logger?.warn(
            `Zotero ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(wait);
          attempt++;
          continue;
        }
        return res;
      }
    });
  }

  private async waitForBackoff(): Promise<void> {
    const now = Date.now();
    if (this.backoffUntil > now) await sleep(this.backoffUntil - now);
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
