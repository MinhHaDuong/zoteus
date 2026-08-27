import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDeferredServer } from '../../src/server.js';
import { installStdioShutdown, ownsSignals } from '../../src/transports/stdio.js';
import type { Logger } from '../../src/lib/logger.js';

const config = { local: 'off', libraryType: 'user', readOnly: false } as any;

function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (...a: unknown[]) => void lines.push(a.join(' '));
  return { lines, logger: { debug: push, info: push, warn: push, error: push } };
}

/**
 * A connected server with the shutdown hook installed, and the three ways to end it.
 *
 * `ownsProcess` is always explicit here: the signal case installs real handlers on the
 * test process, so leaving it to the heuristic would make every later case depend on
 * whether an earlier one had run.
 */
async function session(opts: { flush?: () => Promise<void>; ownsProcess?: boolean } = {}) {
  const { logger, lines } = recorder();
  const exit = vi.fn();
  const stdin = new EventEmitter();
  const { server } = createDeferredServer(config, () => new Promise(() => {}));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const closed = vi.spyOn(server, 'close');
  // Installed after connect, because Protocol.connect() assigns transport.onclose itself.
  installStdioShutdown(server, { logger, exit, stdin, ownsProcess: false, ...opts });
  return {
    client,
    stdin,
    exit,
    lines,
    // Every ending runs the flush and then releases the transport, so the close is the
    // one observable common to all of them.
    settled: () => vi.waitFor(() => expect(closed).toHaveBeenCalled()),
  };
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
    const { stdin, lines, settled } = await session();
    stdin.emit('end');
    await settled();

    expect(lines.join('\n')).toMatch(/host closed the stdio connection \(EOF on stdin\) \d+ms after startup/i);
  });

  /**
   * The process is not necessarily ours to end. #18's host reports "Using built-in
   * Node.js for MCP server" and a probe that "requires the SDK's base
   * StdioClientTransport", neither of which is obviously a plain subprocess, and exiting
   * somebody else's process is a worse bug than the one being fixed. Releasing the
   * transport lets a process we do own drain and exit 0 by itself.
   *
   * This case is the guard on that: it fails if the unconditional exit comes back.
   */
  it('does not exit the process when the host closes stdin', async () => {
    const { stdin, exit, settled } = await session();
    stdin.emit('end');
    await settled();

    expect(exit).not.toHaveBeenCalled();
  });

  /** A transport closed from inside the process ends the session the same way. */
  it('stands down without exiting when the transport closes rather than stdin', async () => {
    const { client, exit, lines, settled } = await session();
    await client.close();
    await settled();

    expect(lines.join('\n')).toMatch(/stdio transport closed \d+ms after startup/i);
    expect(exit).not.toHaveBeenCalled();
  });

  /**
   * Signals are the one ending that must exit: installing the handler is what removed
   * node's default termination, so stopping there would hang until something killed us.
   */
  it('exits on SIGTERM, because the handler replaced the default termination', async () => {
    const { exit, lines, settled } = await session({ ownsProcess: true });
    process.emit('SIGTERM');
    await settled();

    expect(lines.join('\n')).toMatch(/Received SIGTERM \d+ms after startup/i);
    expect(exit).toHaveBeenCalledWith(0);
  });

  /** No handler installed means node's default termination is left in place. */
  it('leaves the signals alone when the process is not ours', async () => {
    const before = process.listenerCount('SIGTERM');
    await session({ ownsProcess: false });

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('reads a signal handler already in place as somebody else owning the process', () => {
    const other = (): void => {};
    process.on('SIGTERM', other);
    try {
      expect(ownsSignals()).toBe(false);
    } finally {
      process.off('SIGTERM', other);
    }
  });

  /**
   * Only the HTTP path installed shutdown handlers, so a stdio session left SQLite's
   * write-ahead log for whichever process opened the file next, on the very host that
   * starts a second Zoteus beside the first.
   */
  it('flushes the search index before it goes', async () => {
    const flush = vi.fn(async () => {});
    const { stdin, settled } = await session({ flush });
    stdin.emit('end');
    await settled();

    expect(flush).toHaveBeenCalledOnce();
  });

  /** Shutdown never fails: a flush that throws is reported, and the session still ends. */
  it('stands down even when the flush refuses', async () => {
    const flush = vi.fn(async () => {
      throw new Error('the search index cannot be read');
    });
    const { stdin, lines, settled } = await session({ flush });
    stdin.emit('end');
    await settled();

    expect(lines.join('\n')).toContain('the search index cannot be read');
  });

  /** One shutdown per session: `close` follows `end` on a pipe, and must not double-flush. */
  it('runs the shutdown once', async () => {
    const flush = vi.fn(async () => {});
    const { stdin, settled } = await session({ flush });
    stdin.emit('end');
    await settled();
    stdin.emit('close');

    expect(flush).toHaveBeenCalledOnce();
  });
});
