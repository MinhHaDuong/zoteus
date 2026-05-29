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
});
