import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiEmbeddingProvider,
  EMBED_RETRY_MAX_WAIT_MS,
  EMBED_RETRY_TOTAL_MS,
  embedBackoffMs,
  parseRetryAfter,
  retryableEmbedStatus,
} from '../../src/features/search/embeddings.js';

/**
 * A build of a 10k-item library died six times in a row on a single OpenAI 429, at 53k to
 * 84k vectors, because the embedding request path had no retry at all: one transient
 * rate-limit answer ended a job that had already run for half an hour and cost real money
 * (#48). These cover the policy that replaced it, and above all what it must NOT retry.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A response the provider path can read, with just the surface it touches. */
function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

/** One OpenAI embedding payload per input text, so the caller's shape checks pass. */
function embeddings(n: number): unknown {
  return { data: Array.from({ length: n }, () => ({ embedding: [1, 0, 0] })) };
}

/**
 * Run `fn` while draining every timer it schedules. Backoff waits are real setTimeouts, so
 * a test that merely awaited the promise would sit for the full 1+2+4 seconds; fake timers
 * plus a pump make the schedule assertable in milliseconds of wall clock.
 */
async function withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
  const result = fn();
  let settled = false;
  void result.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(60_000);
  return result;
}

describe('the backoff schedule', () => {
  it('doubles per attempt and never exceeds the per-wait cap', () => {
    // No jitter, so the schedule itself is what is being read.
    const flat = (attempt: number) => embedBackoffMs(attempt, undefined, () => 0);
    expect([1, 2, 3, 4, 5].map(flat)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(flat(20)).toBe(EMBED_RETRY_MAX_WAIT_MS);
  });

  it('adds jitter above the base wait, never below it', () => {
    // Below the base would make a "wait 1s" that waits 600ms, which is not a backoff.
    expect(embedBackoffMs(1, undefined, () => 1)).toBe(1_250);
    expect(embedBackoffMs(1, undefined, () => 0.5)).toBe(1_125);
  });

  it('takes the server at its word when it sends Retry-After, capped all the same', () => {
    expect(embedBackoffMs(1, 30_000, () => 0)).toBe(30_000);
    expect(embedBackoffMs(1, 600_000, () => 0)).toBe(EMBED_RETRY_MAX_WAIT_MS);
  });

  it('reads Retry-After in both forms the header is allowed to take', () => {
    const now = Date.parse('2026-09-03T10:00:00Z');
    expect(parseRetryAfter('20', now)).toBe(20_000);
    expect(parseRetryAfter('Thu, 03 Sep 2026 10:00:30 GMT', now)).toBe(30_000);
    // A date already in the past is a wait of zero, not a negative one.
    expect(parseRetryAfter('Thu, 03 Sep 2026 09:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('retries what can heal and nothing that cannot', () => {
    expect(retryableEmbedStatus(429)).toBe(true);
    expect(retryableEmbedStatus(500)).toBe(true);
    expect(retryableEmbedStatus(503)).toBe(true);
    expect(retryableEmbedStatus(408)).toBe(true);
    // The whole reason 400 is excluded: an oversized batch is oversized on every retry.
    expect(retryableEmbedStatus(400)).toBe(false);
    expect(retryableEmbedStatus(401)).toBe(false);
    expect(retryableEmbedStatus(403)).toBe(false);
  });
});

describe('an embedding request that is rate-limited', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits and succeeds instead of failing the build', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(429))
      .mockResolvedValueOnce(answer(429))
      .mockResolvedValueOnce(answer(200, embeddings(2)));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', { logger: silentLogger, random: () => 0 });

    const vecs = await withoutWaiting(() => provider.embed(['a', 'b']));

    expect(vecs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After rather than its own guess', async () => {
    const waits: number[] = [];
    const realTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      if (ms) waits.push(ms);
      return realTimeout(fn, ms);
    }) as typeof setTimeout);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(answer(429, {}, { 'retry-after': '45' }))
        .mockResolvedValueOnce(answer(200, embeddings(1))),
    );
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', { logger: silentLogger, random: () => 0 });

    await withoutWaiting(() => provider.embed(['a']));

    expect(waits).toContain(45_000);
  });

  it('says what it is waiting for, and names the dials on the first 429', async () => {
    const logger = { ...silentLogger, info: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(answer(429)).mockResolvedValueOnce(answer(200, embeddings(1))),
    );
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', { logger, random: () => 0 });

    await withoutWaiting(() => provider.embed(['a']));

    const line = logger.info.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toMatch(/OpenAI answered 429; waiting 1\.0s before retry 1 of 5/);
    // The reporter's own working numbers, because "lower the batch size" is what the docs
    // already said and what nobody could find.
    expect(line).toContain('ZOTEUS_EMBED_BATCH_DELAY_MS=8000');
    expect(line).toContain('ZOTEUS_EMBED_BATCH_SIZE=256');
  });

  it('gives up after the configured retries, throwing the error it always threw', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(429));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', {
      logger: silentLogger,
      maxRetries: 2,
      random: () => 0,
    });

    await expect(withoutWaiting(() => provider.embed(['a']))).rejects.toThrow(
      // The first sentence is unchanged, because it is what the one-line embedder label
      // ("openai requested; OpenAI embeddings failed (429)") is cut from.
      /^OpenAI embeddings failed \(429\)\. Gave up after 3 attempts/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops waiting once the total budget is spent, however long Retry-After asks for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(503, {}, { 'retry-after': '60' }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', {
      logger: silentLogger,
      maxRetries: 100,
      random: () => 0,
    });

    await expect(withoutWaiting(() => provider.embed(['a']))).rejects.toThrow(/embeddings failed \(503\)/);
    // Each wait is the capped 60s, so the budget allows exactly three of them.
    expect(fetchMock).toHaveBeenCalledTimes(EMBED_RETRY_TOTAL_MS / EMBED_RETRY_MAX_WAIT_MS + 1);
  });

  it('never retries the oversized-batch 400, which would be oversized again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(400, { error: { message: 'too many tokens' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', { logger: silentLogger, random: () => 0 });

    await expect(withoutWaiting(() => provider.embed(['a']))).rejects.toThrow('OpenAI embeddings failed (400).');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection too, and rethrows it unchanged when it does not heal', async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(answer(200, embeddings(1)));
    vi.stubGlobal('fetch', flaky);
    const provider = new ApiEmbeddingProvider('openai', 'sk-test', { logger: silentLogger, random: () => 0 });
    expect(await withoutWaiting(() => provider.embed(['a']))).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    const doomed = new ApiEmbeddingProvider('openai', 'sk-test', {
      logger: silentLogger,
      maxRetries: 1,
      random: () => 0,
    });
    await expect(withoutWaiting(() => doomed.embed(['a']))).rejects.toThrow('ECONNRESET');
  });

  it('covers the Gemini path by the same policy', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(429))
      .mockResolvedValueOnce(answer(200, { embeddings: [{ values: [1, 0] }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ApiEmbeddingProvider('gemini', 'key', { logger: silentLogger, random: () => 0 });

    expect(await withoutWaiting(() => provider.embed(['a']))).toEqual([[1, 0]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
