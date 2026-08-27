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
  /**
   * Whether this process is ours to end. Defaults to the heuristic in `ownsSignals`;
   * pass it explicitly in tests, where the signal handlers of other cases are already
   * installed and the heuristic would read them as somebody else's.
   */
  ownsProcess?: boolean;
  /** Seams for tests; the defaults are the real stdin and a real exit. */
  stdin?: EofSource;
  exit?: (code: number) => void;
}

/**
 * Whether the signals belong to us.
 *
 * A handler on SIGTERM suppresses node's default termination, so installing one commits
 * us to ending the process ourselves. That is correct in a process we own and wrong in a
 * process we are a guest in, and the listener count separates the two: a server spawned
 * as its own subprocess has nobody else watching, while a host that runs us inside itself
 * is nearly certain to be handling its own shutdown already. The remaining case, a host
 * that embeds us and handles no signals, comes out the same either way, since the default
 * behaviour we would be replacing is termination too.
 */
export function ownsSignals(): boolean {
  return process.listenerCount('SIGTERM') === 0 && process.listenerCount('SIGINT') === 0;
}

/**
 * Wire the end of a stdio session: say what ended it, checkpoint the index, stand down.
 *
 * A stdio server dies with its input stream, and it used to do so with nothing to show
 * for it. `StdioServerTransport.start()` subscribes to `data` and `error` on stdin and to
 * nothing else (there is no `end` listener anywhere in it), so when the host closes stdin
 * the transport is never closed, `onclose` never fires, no `close()` runs, and the process
 * simply runs out of work and exits 0 having written no line and flushed no file. That is
 * what #18 keeps arriving as: the host logs `Server transport closed unexpectedly, this is
 * likely due to the process exiting early`, and there is no reason anywhere, so an
 * ordinary shutdown reads as a crash.
 *
 * Standing down is right. The stdio binding says a server SHOULD exit promptly once its
 * standard input is closed, calls that the primary graceful-shutdown signal and the only
 * portable one, and has the client escalate to SIGTERM and then SIGKILL when it does not.
 * What changes here is that the exit is announced and, before it, the index is written:
 * only the HTTP path installed shutdown handlers, so a stdio session left SQLite's
 * write-ahead log for whichever process opened the file next.
 *
 * **How each ending ends, and why they differ.** 1.7.2 finished all three with
 * `process.exit(0)`, which assumes the process is ours. On the evidence of #18 that is not
 * safe to assume: the host reports `Using built-in Node.js for MCP server` and that its
 * probe `requires the SDK's base StdioClientTransport`, both of which read like a runner
 * that may not be a plain subprocess. Exiting somebody else's process is a worse bug than
 * the one being fixed, so only the path that cannot end any other way still does it.
 *
 * - **stdin EOF, and a transport closed from inside the process.** No exit call. The flush
 *   finishes, `server.close()` releases the transport (which pauses stdin, the last ref'd
 *   handle), the loop drains and node exits 0 on its own. If some other work is still
 *   holding the loop, the host's own escalation is the backstop the binding prescribes.
 * - **SIGTERM and SIGINT.** These do exit, because installing the handler is what removed
 *   the default termination: stopping there would hang the process until it was killed.
 *   Guarded by `ownsSignals` so a host that already handles its own keeps them.
 *
 * Watching stdin needs no such guard. Once nothing exits, the worst an unrelated EOF can
 * do is checkpoint an index that was already consistent and write one line saying so.
 *
 * Installed after `connect`, because `Protocol.connect()` assigns `transport.onclose`
 * itself. The server's own `onclose` is the hook that survives it.
 */
export function installStdioShutdown(server: McpServer, opts: StdioOptions = {}): void {
  const startedAt = Date.now();
  const stdin = opts.stdin ?? process.stdin;
  let ending = false;

  const finish = async (exitCode: number | undefined): Promise<void> => {
    // A timer holds the loop open across the flush: with stdin already at EOF there may be
    // nothing else left alive to keep the process running long enough to finish it.
    const keepAlive = setInterval(() => {}, 1_000);
    try {
      await withDeadline(opts.flush?.() ?? Promise.resolve(), FLUSH_DEADLINE_MS);
    } catch (e) {
      opts.logger?.error(`Shutdown flush failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Releases stdin, which is what lets the loop drain when nothing calls exit.
    await server.close().catch(() => {});
    clearInterval(keepAlive);
    if (exitCode !== undefined) (opts.exit ?? ((c: number) => process.exit(c)))(exitCode);
  };

  /** `exitCode` undefined means stand down and let the loop drain. */
  const end = (reason: string, exitCode?: number): void => {
    if (ending) return;
    ending = true;
    opts.logger?.info(`${reason} ${Date.now() - startedAt}ms after startup. Shutting down.`);
    void finish(exitCode);
  };

  // `close` follows `end` on a pipe, and arrives alone if the far side is torn down rather
  // than closed, so whichever comes first is the one that runs and the guard drops the rest.
  stdin.once('end', () => end('The host closed the stdio connection (EOF on stdin)'));
  stdin.once('close', () => end('The host closed the stdio connection (stdin closed)'));
  server.server.onclose = () => end('The stdio transport closed');
  if (opts.ownsProcess ?? ownsSignals()) {
    process.on('SIGTERM', () => end('Received SIGTERM', 0));
    process.on('SIGINT', () => end('Received SIGINT', 0));
  }
}

export async function startStdio(server: McpServer, opts: StdioOptions = {}): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installStdioShutdown(server, opts);
}
