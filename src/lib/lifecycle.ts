import type { Server } from 'node:http';
import type { Logger } from './logger.js';

export interface ShutdownTasks {
  server: Pick<Server, 'close'>;
  /** Close active MCP sessions/transports within the timeout. */
  drainSessions?: (timeoutMs: number) => Promise<void>;
  /** Persist durable state (OAuth store, search indexes). */
  flush?: () => Promise<void>;
  logger?: Logger;
  /** Overall deadline; the process resolves even if a step hangs. */
  timeoutMs?: number;
}

/** Resolve when `p` does, or when `ms` elapses, whichever comes first. */
export const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
  Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())]);

/** Stop accepting new connections → drain sessions → flush state, all under one deadline. */
export async function gracefulShutdown(tasks: ShutdownTasks): Promise<void> {
  const deadline = tasks.timeoutMs ?? 25_000;
  const run = (async () => {
    // Stop accepting NEW connections first so the drain below isn't racing freshly-created
    // sessions during a redeploy. close() does NOT terminate in-flight connections; we don't
    // await its callback (it only fires once every existing connection ends) — the deadline
    // plus the explicit process.exit in installShutdownHandlers guarantees termination.
    tasks.server.close();
    try {
      if (tasks.drainSessions) await tasks.drainSessions(deadline);
      if (tasks.flush) await tasks.flush();
    } catch (e) {
      tasks.logger?.error('shutdown task failed', e instanceof Error ? e.message : String(e));
    }
  })();
  await withDeadline(run, deadline);
}

/** Trap SIGTERM/SIGINT once and run gracefulShutdown, exiting 0 on success / 1 on failure. */
export function installShutdownHandlers(tasks: ShutdownTasks): void {
  let started = false;
  const handle = (sig: string): void => {
    if (started) return;
    started = true;
    tasks.logger?.info(`received ${sig}, shutting down gracefully`);
    gracefulShutdown(tasks)
      .then(() => process.exit(0))
      .catch((e) => {
        tasks.logger?.error('graceful shutdown error', e instanceof Error ? e.message : String(e));
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}
