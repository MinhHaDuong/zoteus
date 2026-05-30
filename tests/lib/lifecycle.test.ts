// tests/lib/lifecycle.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { gracefulShutdown, installShutdownHandlers } from '../../src/lib/lifecycle.js';

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

describe('installShutdownHandlers', () => {
  afterEach(() => {
    // Remove all SIGTERM/SIGINT listeners added during the test to keep process clean.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('registers SIGTERM and SIGINT handlers', () => {
    const server = fakeServer();
    installShutdownHandlers({ server: server as never, timeoutMs: 50 });
    expect(process.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount('SIGINT')).toBeGreaterThanOrEqual(1);
  });

  it('calls process.exit(0) after a successful graceful shutdown on SIGTERM', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    try {
      const server = fakeServer();
      installShutdownHandlers({ server: server as never, timeoutMs: 200 });
      process.emit('SIGTERM');
      // Allow microtasks/macrotasks to settle so the promise chain resolves.
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('calls process.exit(1) when gracefulShutdown rejects', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    try {
      // server.close that throws so gracefulShutdown rejects
      const badServer = {
        close: (_cb: (e?: Error) => void) => {
          throw new Error('close failed');
        },
      };
      installShutdownHandlers({ server: badServer as never, timeoutMs: 200 });
      process.emit('SIGTERM');
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('only triggers shutdown once even if both SIGTERM and SIGINT fire', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    try {
      const server = fakeServer();
      installShutdownHandlers({ server: server as never, timeoutMs: 200 });
      process.emit('SIGTERM');
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 100));
      // exit should have been called exactly once due to the once-guard
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
