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

const withDeadline = <T>(p: Promise<T>, ms: number): Promise<T | void> =>
  Promise.race([p, new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())]);

/** Drain sessions → flush state → stop accepting connections, all under one deadline. */
export async function gracefulShutdown(tasks: ShutdownTasks): Promise<void> {
  const deadline = tasks.timeoutMs ?? 25_000;
  const run = (async () => {
    try {
      if (tasks.drainSessions) await tasks.drainSessions(deadline);
      if (tasks.flush) await tasks.flush();
    } catch (e) {
      tasks.logger?.error('shutdown task failed', e instanceof Error ? e.message : String(e));
    }
    await new Promise<void>((resolve) => tasks.server.close(() => resolve()));
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
