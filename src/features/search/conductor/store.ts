import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from './clock.js';
import { Ledger } from './ledger.js';

/**
 * Where `search-index-v2.sqlite` lives, and how it is opened in production.
 *
 * The file sits beside v1's `search-index.sqlite` in the same data directory and is opened
 * by the same rules, deliberately: SPEC.md §5.1 gives v2 a new filename precisely so the
 * two can exist at once, and so a binary that does not understand the new protocol can
 * never be handed the new file. Nothing here reads or writes v1.
 */

export interface ConductorLedgerOptions {
  /** `config.dataDir`. The directory is created if it does not exist. */
  dataDir: string;
  /**
   * Multi-tenant mode's per-user suffix, exactly as v1 keys `search-index-<id>.json`.
   *
   * Inside one file, C1's partition is `origins`/`libraries` and not the filename — but
   * two tenants of one server are two *credential* scopes, not two Zotero servers, and
   * nothing in the schema separates them. Until something does, they get separate files,
   * which is what v1 already does and what this must not silently diverge from.
   */
  zoteroUserId?: number | string;
  clock?: Clock;
}

/** The v2 ledger that pairs with a data directory (and, in multi-tenant mode, a user). */
export function conductorLedgerPath(dataDir: string, zoteroUserId?: number | string): string {
  return join(dataDir, zoteroUserId === undefined ? 'search-index-v2.sqlite' : `search-index-v2-${zoteroUserId}.sqlite`);
}

/**
 * Open the conductor's store, creating the data directory and the file if needed.
 *
 * Thin on purpose. Every pragma and every ordering constraint §5.2.2 states lives in
 * `Ledger.open`, so a test fixture on a temporary path and the server's own startup go
 * through identical code — the alternative is a production path whose pragmas nothing
 * exercises, which is the shape this ticket exists to avoid.
 */
export function openConductorLedger(opts: ConductorLedgerOptions): Ledger {
  const path = conductorLedgerPath(opts.dataDir, opts.zoteroUserId);
  mkdirSync(dirname(path), { recursive: true });
  return opts.clock ? Ledger.open(path, opts.clock) : Ledger.open(path);
}
