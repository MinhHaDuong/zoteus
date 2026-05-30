// tests/integration/graceful-shutdown.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import { gracefulShutdown } from '../../src/lib/lifecycle.js';
import { startHttp } from '../../src/transports/http.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Create a minimal HTTP server bound to a random loopback port. */
async function startServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer((_req, res) => {
      res.writeHead(200).end('ok');
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('gracefulShutdown — real http.Server integration', () => {
  it('closes a live http.Server and resolves', async () => {
    const server = await startServer();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    // Verify server is listening before shutdown.
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);

    await gracefulShutdown({ server, timeoutMs: 5_000 });

    // After shutdown the server must no longer accept connections.
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('runs drainSessions callback before closing the server', async () => {
    const server = await startServer();
    const order: string[] = [];
    const drainSessions = async () => {
      order.push('drain');
    };

    await gracefulShutdown({ server, drainSessions, timeoutMs: 5_000 });

    expect(order).toEqual(['drain']);
    // Server should be closed — new connections must fail.
    const addr = server.address();
    expect(addr).toBeNull();
  });

  it('resolves within timeout even when drainSessions hangs', async () => {
    const server = await startServer();
    const drainSessions = () => new Promise<void>(() => {}); // never resolves

    const start = Date.now();
    await gracefulShutdown({ server, drainSessions, timeoutMs: 100 });
    const elapsed = Date.now() - start;

    // Should have resolved at most a little after the 100 ms deadline.
    expect(elapsed).toBeLessThan(500);
  });
});

let wiredServer: Server | undefined;
afterEach(() => {
  wiredServer?.close();
  wiredServer = undefined;
});

describe('graceful shutdown wiring', () => {
  it('exposes a drain handle and flushes on shutdown', async () => {
    let handle: { drainSessions: (ms: number) => Promise<void>; activeSessions: () => number } | undefined;
    wiredServer = await startHttp(
      () => new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } }),
      { port: 0, host: '127.0.0.1', registerLifecycle: (h) => (handle = h) },
    );
    expect(handle).toBeDefined();
    expect(handle!.activeSessions()).toBe(0);

    const addr = wiredServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const flush = vi.fn(async () => {});
    await gracefulShutdown({
      server: wiredServer,
      drainSessions: handle!.drainSessions,
      flush,
      timeoutMs: 2000,
    });
    expect(flush).toHaveBeenCalledOnce();
    // server is closed: a new connection is refused
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toBeTruthy();
    wiredServer = undefined; // already closed
  }, 20_000);
});
