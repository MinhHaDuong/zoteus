import { createRequire } from 'node:module';
import { CorruptSearchIndex, SearchIndexCorruptError, SearchIndexUnreadableError } from './corruption.js';
import { MemorySearchIndex } from './index-manager.js';
import { loadIndex } from './persistence.js';
import type { SearchIndex, SearchIndexOptions } from './backend.js';

/** ZOTEUS_INDEX_BACKEND. `auto` takes SQLite whenever the runtime provides it. */
export type IndexBackendSetting = 'auto' | 'sqlite' | 'memory';

export interface CreateSearchIndexOptions extends SearchIndexOptions {
  backend: IndexBackendSetting;
  /**
   * Path of the legacy JSON artifact. The SQLite database sits beside it under the same
   * name, so both stay keyed by the data dir and, in multi-tenant mode, by the user.
   * Empty means "no artifact": an index that lives only for this process.
   */
  jsonPath: string;
  /**
   * Two-stage vector search and its candidate pool (ZOTEUS_INDEX_ANN and friends). Only
   * the SQLite backend has two ways to rank vectors; the JSON one holds every vector
   * resident already, so it has nothing to choose between and is not given the choice.
   */
  annEnabled?: boolean;
  annOversample?: number;
  annMinCandidates?: number;
}

/** The SQLite database that pairs with a given search-index.json path. */
export function sqliteIndexPath(jsonPath: string): string {
  return `${jsonPath.replace(/\.json$/i, '')}.sqlite`;
}

/**
 * Whether this runtime has Node's built-in SQLite. It landed unflagged in Node 22.13;
 * earlier versions either lack the module or need --experimental-sqlite, and both refuse
 * to load it. Probed with require rather than import(): `sqlite` is absent from
 * `module.builtinModules` while experimental, so bundlers and test runners fail to resolve
 * the specifier even where Node itself provides it.
 */
export function nodeSqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the search index this context will use, and open its store.
 *
 * `auto` prefers SQLite because it is the only backend a large library survives (a JSON
 * index cannot be written past ~512 MB, nor re-read anywhere near it), and falls back to
 * the JSON one when the runtime has no `node:sqlite`. `sqlite` demands it: an operator who
 * asked for the durable backend must not be quietly given the one with the ceiling.
 */
export async function createSearchIndex(opts: CreateSearchIndexOptions): Promise<SearchIndex> {
  const { backend, jsonPath, annEnabled, annOversample, annMinCandidates, ...indexOpts } = opts;
  if (backend !== 'memory') {
    if (nodeSqliteAvailable()) {
      const { SqliteSearchIndex } = await import('./sqlite-index.js');
      const index = new SqliteSearchIndex({
        ...indexOpts,
        path: jsonPath ? sqliteIndexPath(jsonPath) : ':memory:',
        ...(jsonPath ? { migrateFrom: jsonPath } : {}),
        ...(annEnabled === undefined ? {} : { annEnabled }),
        ...(annOversample === undefined ? {} : { annOversample }),
        ...(annMinCandidates === undefined ? {} : { annMinCandidates }),
      });
      try {
        await index.open();
      } catch (e) {
        // An unreadable index must not take the server with it. Everything that does not
        // read the index — item lookups, bibliographies, attachments, citations — is
        // unaffected by a bad cache file and keeps working; search alone refuses, and says
        // why. Anything else still throws: a permission error or a full disk is not a
        // reason to tell someone their index is beyond saving, and the store is the only
        // thing that knows which is which.
        // SearchIndexUnreadableError joins the degradation for one path: a migration that
        // failed for a transient, non-corruption reason (a full disk, a size limit) now
        // leaves the database untouched at its old stamp and refuses instead of sidelining
        // it. That refusal must not take the server down either — the retry it prescribes
        // is the next open.
        if (!(e instanceof SearchIndexCorruptError) && !(e instanceof SearchIndexUnreadableError)) throw e;
        opts.logger?.error(e.message);
        return new CorruptSearchIndex(e, indexOpts);
      }
      return index;
    }
    if (backend === 'sqlite') {
      throw new Error(
        `ZOTEUS_INDEX_BACKEND=sqlite requires Node's built-in node:sqlite module, which ${process.version} does ` +
          'not provide (it is available unflagged from Node 22.13). Upgrade Node, or set ' +
          'ZOTEUS_INDEX_BACKEND=auto to fall back to the JSON index backend.',
      );
    }
    opts.logger?.info(
      `node:sqlite is unavailable on ${process.version}, so the search index uses the JSON backend. ` +
        'A library past roughly 250k passages needs Node 22.13+: a JSON index cannot be saved beyond ~512 MB.',
    );
  }
  const index = new MemorySearchIndex({ ...indexOpts, ...(jsonPath ? { path: jsonPath } : {}) });
  if (jsonPath) {
    try {
      await loadIndex(index, jsonPath);
    } catch (e) {
      // Same contract as the SQLite branch above: an artifact that cannot be read must not
      // take the server down, and must not quietly become an empty index either. The fault
      // makes every read and every write refuse and say why, and `zotero_index
      // action:"build"` is what clears it, by replacing the file (#21).
      const fault = e instanceof SearchIndexUnreadableError ? e : new SearchIndexUnreadableError(jsonPath, e);
      index.markStoreFault(fault);
      opts.logger?.error(fault.message);
    }
  }
  return index;
}
