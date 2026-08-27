import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDeferredServer } from '../../src/server.js';
import { installStdioShutdown } from '../../src/transports/stdio.js';
import type { Logger } from '../../src/lib/logger.js';

const config = { local: 'off', libraryType: 'user', readOnly: false } as any;

function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.join(' '));
  return { lines, logger: { debug: push, info: push, warn: push, error: push } };
}

/** A connected server with the shutdown hook installed, and the two ways to end it. */
async function session(opts: { flush?: () => Promise<void> } = {}) {
  const { logger, lines } = recorder();
  const exit = vi.fn();
  const stdin = new EventEmitter();
  const { server } = createDeferredServer(config, () => new Promise(() => {}));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  // Installed after connect, because Protocol.connect() assigns transport.onclose itself.
  installStdioShutdown(server, { logger, exit, stdin, ...opts });
  return { client, stdin, exit, lines, settled: () => vi.waitFor(() => expect(exit).toHaveBeenCalled()) };
}

/**
 * The host ending a stdio session used to be indistinguishable from a crash. The SDK's
 * StdioServerTransport listens for `data` and `error` on stdin and nothing else, so EOF
 * closed no transport, fired no `onclose`, and the process ran out of work and exited 0
 * having written nothing. That is what #18 keeps arriving as: the host's "process exiting
 * early" with no reason in it anywhere.
 */
describe('stdio shutdown', () => {
  it('names the end of the session on stderr instead of exiting silently', async () => {
    const { stdin, exit, lines, settled } = await session();
    stdin.emit('end');
    await settled();

    expect(lines.join('\n')).toMatch(/host closed the stdio connection \(EOF on stdin\) \d+ms after startup/i);
    expect(exit).toHaveBeenCalledWith(0);
  });

  /** A transport closed from inside the process ends the session the same way. */
  it('shuts down when the transport closes rather than stdin', async () => {
    const { client, exit, lines, settled } = await session();
    await client.close();
    await settled();

    expect(lines.join('\n')).toMatch(/stdio transport closed \d+ms after startup/i);
    expect(exit).toHaveBeenCalledWith(0);
  });

  /**
   * Only the HTTP path installed shutdown handlers, so a stdio session left SQLite's
   * write-ahead log for whichever process opened the file next, on the very host that
   * starts a second Zoteus beside the first.
   */
  it('flushes the search index before it goes', async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => void order.push('flush'));
    const { stdin, exit, settled } = await session({ flush });
    stdin.emit('end');
    await settled();

    expect(flush).toHaveBeenCalledOnce();
    expect(order).toEqual(['flush']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  /** Shutdown never fails: a flush that throws is reported, and the process still ends. */
  it('exits even when the flush refuses', async () => {
    const flush = vi.fn(async () => {
      throw new Error('the search index cannot be read');
    });
    const { stdin, exit, lines, settled } = await session({ flush });
    stdin.emit('end');
    await settled();

    expect(lines.join('\n')).toContain('the search index cannot be read');
    expect(exit).toHaveBeenCalledWith(0);
  });

  /** One shutdown per process: `close` follows `end` on a pipe, and must not double-flush. */
  it('runs the shutdown once', async () => {
    const flush = vi.fn(async () => {});
    const { stdin, exit, settled } = await session({ flush });
    stdin.emit('end');
    await settled();
    stdin.emit('close');
    process.emit('SIGTERM');

    expect(flush).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
