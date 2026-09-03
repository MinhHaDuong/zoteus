/**
 * Opening the usage log, and the one place that decides what a caller is called.
 *
 * Nothing here runs unless an operator sets ZOTEUS_USAGE_LOG=true. That default is not
 * timidity: Zoteus is installed mostly as a local desktop server, PRIVACY.md promises no
 * analytics, and a log nobody asked for would make that promise false even though the file
 * never leaves the machine.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Logger } from '../logger.js';
import { NULL_RECORDER, type UsageEvent, type UsageRecorder } from './event.js';
import { scheduleMaintenance } from './rollup.js';
import type { SqliteUsageStore } from './store.js';

/** How a caller is identified in the log. */
export type IdentifyMode = 'user' | 'hash' | 'none';

export interface OpenUsageOptions {
  enabled: boolean;
  /** Absolute path of the database (`<dataDir>/usage.sqlite`). */
  path: string;
  retentionDays: number;
  identify: IdentifyMode;
  logger?: Logger;
  /** Overridable for tests; a day in production. */
  maintenanceIntervalMs?: number;
}

export interface UsageHandle {
  recorder: UsageRecorder;
  /** The open store, for the endpoints and the report that read it back. */
  store: SqliteUsageStore;
  /** Stop the maintenance timer. Flushing is `recorder.close()`. */
  stop(): void;
}

const DAY_MS = 86_400_000;

/**
 * Whether this runtime has Node's built-in SQLite. Same probe, and the same reasoning, as
 * `nodeSqliteAvailable` in the search factory: `require` rather than `import()`, because
 * `sqlite` is missing from `module.builtinModules` while it is experimental and bundlers
 * therefore fail to resolve the specifier on runtimes that do provide it.
 */
function nodeSqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the usage log, or explain in one line why there is none and carry on.
 *
 * Every failure here is non-fatal by design. A server that refused to start because it
 * could not write a usage row would be trading the product for the telemetry about it.
 */
export async function openUsage(opts: OpenUsageOptions): Promise<UsageHandle | undefined> {
  if (!opts.enabled) return undefined;
  if (!nodeSqliteAvailable()) {
    opts.logger?.warn(
      `ZOTEUS_USAGE_LOG is on but ${process.version} has no node:sqlite (unflagged from Node 22.13), ` +
        'so no usage log is being kept.',
    );
    return undefined;
  }
  try {
    const { SqliteUsageStore } = await import('./store.js');
    const store = SqliteUsageStore.open({
      path: opts.path,
      logger: opts.logger,
      retentionDays: opts.retentionDays,
    });
    // Catches up whatever accumulated while the process was down, and prunes before the
    // first request rather than a day after it.
    store.maintain();
    const stopTimer = scheduleMaintenance(
      () => store.maintain(),
      opts.maintenanceIntervalMs ?? DAY_MS,
    );
    const recorder = identifying(store, opts.identify, opts.logger);
    const { events, daily } = store.counts();
    opts.logger?.info('usage log open', {
      path: opts.path,
      events,
      daily,
      identify: opts.identify,
    });
    return { recorder, store, stop: stopTimer };
  } catch (err) {
    opts.logger?.warn(
      `Usage log could not be opened at ${opts.path} — ${err instanceof Error ? err.message : String(err)}. ` +
        'Continuing without one.',
    );
    return undefined;
  }
}

/**
 * The identity policy, applied once on the way in rather than at each call site.
 *
 * Put here so that no instrumentation anywhere can record a raw user id after an operator
 * has asked for `hash` or `none` — the call sites hand over what they know, and this is the
 * only thing that decides what is kept. `hash` is pseudonymisation and not anonymisation,
 * and the salt lives in the same file, so it defends against someone reading the log, not
 * against whoever holds it.
 */
function identifying(store: SqliteUsageStore, mode: IdentifyMode, logger?: Logger): UsageRecorder {
  if (mode === 'user') return store;
  if (mode === 'none') {
    return {
      record: (ev: UsageEvent) => store.record({ ...ev, userId: undefined, sessionId: undefined }),
      flush: () => store.flush(),
      close: () => store.close(),
    };
  }
  let salt: string | undefined;
  const saltOf = (): string => {
    salt ??= store.identitySalt(() => randomBytes(16).toString('hex'));
    return salt;
  };
  return {
    record: (ev: UsageEvent) => {
      try {
        const userId = ev.userId === undefined ? undefined : pseudonym(saltOf(), ev.userId);
        store.record({ ...ev, userId });
      } catch (err) {
        logger?.debug(`usage identity hashing failed: ${String(err)}`);
      }
    },
    flush: () => store.flush(),
    close: () => store.close(),
  };
}

/** A stable 48-bit integer standing in for a Zotero user id, so the column stays numeric. */
function pseudonym(salt: string, userId: number): number {
  return createHash('sha256').update(`${salt}:${userId}`).digest().readUIntBE(0, 6);
}

export { NULL_RECORDER };
export type { UsageEvent, UsageRecorder };
