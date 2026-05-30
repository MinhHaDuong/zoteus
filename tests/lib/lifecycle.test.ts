// tests/lib/lifecycle.test.ts
import { describe, it, expect, vi } from 'vitest';
import { gracefulShutdown } from '../../src/lib/lifecycle.js';

function fakeServer(closeDelayMs = 0): { close: (cb: (e?: Error) => void) => void } {
  return { close: (cb) => setTimeout(() => cb(), closeDelayMs) };
}

describe('gracefulShutdown', () => {
  it('drains, flushes, then closes — in that order — and resolves', async () => {
    const order: string[] = [];
    const drainSessions = vi.fn(async () => {
      order.push('drain');
    });
    const flush = vi.fn(async () => {
      order.push('flush');
    });
    const server = { close: (cb: () => void) => (order.push('close'), cb()) };
    await gracefulShutdown({ server: server as never, drainSessions, flush, timeoutMs: 1000 });
    expect(order).toEqual(['drain', 'flush', 'close']);
  });

  it('still resolves if a step hangs past the deadline', async () => {
    const drainSessions = () => new Promise<void>(() => {}); // never resolves
    const flush = vi.fn(async () => {});
    await expect(
      gracefulShutdown({ server: fakeServer() as never, drainSessions, flush, timeoutMs: 50 }),
    ).resolves.toBeUndefined();
  });
});
