import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withDeadline } from '../lib/lifecycle.js';
import type { Logger } from '../lib/logger.js';

/** Long enough to checkpoint a large WAL, short enough that no host waits on us to die. */
const FLUSH_DEADLINE_MS = 5_000;

/** Only what the shutdown watch needs, so a test can hand it something other than stdin. */
type EofSource = { once(event: string, listener: () => void): unknown };

export interface StdioOptions {
  logger?: Logger;
  /**
   * Persist whatever this session built (the search index). Best-effort and under a
   * deadline: shutdown never fails, it only takes less time than it wanted.
   */
  flush?: () => Promise<void>;
  /** Seams for tests; the defaults are the real stdin and a real exit. */
  stdin?: EofSource;
  exit?: (code: number) => void;
}

/**
 * Wire the end of a stdio session: say what ended it, checkpoint the index, exit.
 *
 * A stdio server dies with its input stream, and it used to do so with nothing to show
 * for it. `StdioServerTransport.start()` subscribes to `data` and `error` on stdin and to
 * nothing else (there is no `end` listener anywhere in it), so when the host closes stdin
 * the transport is never closed, `onclose` never fires, no `close()` runs, and the process
 * simply runs out of work and exits 0 having written no line and flushed no file. That is
 * the whole of what #18 looks like from the outside: the host logs `Server transport
 * closed unexpectedly, this is likely due to the process exiting early`, and there is no
 * reason anywhere, so an ordinary shutdown reads as a crash. Reproduced against the
 * shipped 1.7.1 bundle: EOF on stdin 303ms in, process gone 23ms later, stderr empty.
 *
 * Exiting is right, since a closed stdin can carry no further request and staying alive
 * would only leak a process. What changes is that the exit is announced and, before it,
 * the index is written. Only the HTTP path installed shutdown handlers, so a stdio session
 * left SQLite's write-ahead log for whichever process opened the file next; closing the
 * handle is what checkpoints it. That matters most on exactly the host this was reported
 * from, where a shared pool starts a second Zoteus beside the first.
 *
 * Installed after `connect`, because `Protocol.connect()` assigns `transport.onclose`
 * itself. The server's own `onclose` is the hook that survives it, and it covers the
 * other direction: a transport closed from inside the process rather than by the host.
 */
export function installStdioShutdown(server: McpServer, opts: StdioOptions = {}): void {
  const startedAt = Date.now();
  const stdin = opts.stdin ?? process.stdin;
  let ending = false;

  const finish = async (code: number): Promise<void> => {
    // A timer holds the loop open across the flush: with stdin already at EOF there is
    // nothing else left alive to keep the process running long enough to finish it.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await withDeadline(opts.flush?.() ?? Promise.resolve(), FLUSH_DEADLINE_MS);
    } catch (e) {
      opts.logger?.error(`Shutdown flush failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    clearInterval(keepAlive);
    (opts.exit ?? ((c: number) => process.exit(c)))(code);
  };

  const end = (reason: string, code = 0): void => {
    if (ending) return;
    ending = true;
    opts.logger?.info(`${reason} ${Date.now() - startedAt}ms after startup. Shutting down.`);
    void finish(code);
  };

  // `close` follows `end` on a pipe, and arrives alone if the far side is torn down rather
  // than closed, so whichever comes first is the one that runs and the guard drops the rest.
  stdin.once('end', () => end('The host closed the stdio connection (EOF on stdin)'));
  stdin.once('close', () => end('The host closed the stdio connection (stdin closed)'));
  server.server.onclose = () => end('The stdio transport closed');
  process.on('SIGTERM', () => end('Received SIGTERM'));
  process.on('SIGINT', () => end('Received SIGINT'));
}

export async function startStdio(server: McpServer, opts: StdioOptions = {}): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installStdioShutdown(server, opts);
}
