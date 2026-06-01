import { describe, it, expect, vi } from 'vitest';
import { RateLimitedFetcher } from '../../src/api/http.js';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('RateLimitedFetcher', () => {
  it('retries on 429 honoring Retry-After, then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) return jsonResponse(429, 'slow down', { 'retry-after': '0' });
      return jsonResponse(200, { ok: true });
    });
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
    const res = await f.fetch('https://example.test/x');
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return jsonResponse(200, {});
    });
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => f.fetch('https://example.test/x')));
    expect(maxActive).toBe(2);
  });

  it('gives up after maxRetries and returns the last response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, 'down', { 'retry-after': '0' }));
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
    const res = await f.fetch('https://example.test/x', undefined, { maxRetries: 2 });
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails fast with an actionable error instead of sleeping past the deadline', async () => {
    // 429 with no Retry-After -> 500ms exponential backoff, which exceeds the 100ms budget.
    const fetchImpl = vi.fn(async () => jsonResponse(429, 'slow', {}));
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
    await expect(
      f.fetch('https://example.test/x', undefined, { deadlineMs: 100, maxRetries: 1 }),
    ).rejects.toThrow(/budget|sequential/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // gave up before the first retry sleep
  });

  it('passes an abort signal so a single request can be bounded', async () => {
    let sawSignal = false;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sawSignal = Boolean(init && init.signal);
      return jsonResponse(200, { ok: true });
    });
    const f = new RateLimitedFetcher({ fetchImpl });
    await f.fetch('https://example.test/x');
    expect(sawSignal).toBe(true);
  });

  it('aborts a hung request at the deadline and reports it as a timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(jsonResponse(200, {})), 1000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const f = new RateLimitedFetcher({ fetchImpl });
    await expect(
      f.fetch('https://example.test/x', undefined, { deadlineMs: 60 }),
    ).rejects.toThrow(/budget|timeout|sequential/i);
  }, 2000);

  // A single slow upstream response (no 429/Backoff ever seen) must NOT be blamed on
  // rate-limiting — that misattribution misled a caller into "retry sequentially / avoid
  // parallel batches", which is meaningless for one expensive request (e.g. full-text
  // qmode=everything). The message should point at the expensive query instead.
  it('blames a slow single response on the query, not rate-limiting', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => resolve(jsonResponse(200, {})), 1000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    );
    const f = new RateLimitedFetcher({ fetchImpl });
    const err = await f
      .fetch('https://example.test/x', undefined, { deadlineMs: 60 })
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/full-text|expensive|narrow|single request/i);
    expect(err!.message).not.toMatch(/rate-limit|parallel batches/i);
  }, 2000);

  // When Zotero actually rate-limits (429/503/Backoff) and back-off would exceed the
  // budget, the error SHOULD say so and give the sequential-retry guidance.
  it('attributes a 429-driven budget overrun to rate-limiting', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(429, 'slow', {}));
    const f = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
    const err = await f
      .fetch('https://example.test/x', undefined, { deadlineMs: 100, maxRetries: 1 })
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeTruthy();
    expect(err!.message).toMatch(/rate-limit/i);
    expect(err!.message).toMatch(/parallel batches|sequential/i);
  });
});
