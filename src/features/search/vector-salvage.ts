import { createRequire } from 'node:module';
import type { DatabaseSync as Database, StatementSync } from 'node:sqlite';
import { describeLibraryToken } from './backend.js';
import type { Logger } from '../../lib/logger.js';

/**
 * Required the same way the SQLite backend requires it, and for the same reason: `sqlite`
 * is absent from `module.builtinModules` while it is experimental, so a bare import is
 * resolved from disk by bundlers and test runners and fails. This module is only ever
 * imported from sqlite-index.ts, which the factory loads after confirming the runtime.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * Vectors read back out of an index this build had to move aside.
 *
 * A schema stamp this build does not understand costs the user a rebuild, and the
 * expensive half of a rebuild is not the crawl but the embedding: 255k passages is five
 * and a half hours on the local model, or real money on a hosted one (#34). None of that
 * cost is inherent. An embedding is a function of exactly two things, the text and the
 * model, and a table-layout change touches neither — so the vectors in the moved-aside
 * file are still the right vectors for whatever the rebuild re-reads.
 *
 * This hands them back under four conditions, all of which must hold together:
 *
 *  - the moved-aside index was written by the SAME embedder (its `embedderId`, which
 *    names provider and model, is what the caller compares before opening this at all);
 *  - it holds the same LIBRARY the rebuild is indexing, where it says which one it held
 *    (`refusalFor`, and see the note there on files that do not say);
 *  - the rebuilt passage has the same id, i.e. it is the same chunk of the same item;
 *  - and the same TEXT, byte for byte, so an item whose abstract was edited in the
 *    meantime is re-embedded rather than given the vector of what it used to say.
 *
 * Read-only, and it never writes to or deletes the file it reads: the sidelined database
 * stays exactly what the sideline promised it would be, a complete index nothing removed.
 */
export class VectorSalvage {
  private db: Database | undefined;
  private lookup: StatementSync | undefined;
  private reusedCount = 0;
  private readonly logger: Logger | undefined;
  readonly path: string;
  /**
   * The library the sidelined index was built for (`canonicalLibraryToken`), or undefined
   * when the file carries no stamp. Read once, at open: the file is never written to and
   * its stamp cannot change under us.
   */
  readonly library: string | undefined;

  private constructor(
    path: string,
    db: Database,
    lookup: StatementSync,
    library: string | undefined,
    logger?: Logger,
  ) {
    this.path = path;
    this.db = db;
    this.lookup = lookup;
    this.library = library;
    this.logger = logger;
  }

  /**
   * Open a sidelined database as a vector source, or answer undefined when it cannot serve
   * as one. Never throws: a salvage that does not work costs a re-embed, which is exactly
   * what would have happened anyway, so nothing here is worth failing an open over.
   *
   * The columns are inspected rather than assumed. The file this reads was written by a
   * build whose schema this one does not know — that is the whole reason it was moved
   * aside — so `passages` may have a different shape, or not exist at all.
   */
  static openIfUsable(path: string, logger?: Logger): VectorSalvage | undefined {
    let db: Database | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const columns = new Set(
        (db.prepare('PRAGMA table_info(passages)').all() as Array<{ name: string }>).map((c) => c.name),
      );
      if (!columns.has('id') || !columns.has('text') || !columns.has('vector')) {
        db.close();
        return undefined;
      }
      // Both halves of the identity in one point lookup: `id` is UNIQUE, so this is an
      // index seek, and the text comparison rejects a passage whose words have moved on.
      const lookup = db.prepare('SELECT vector FROM passages WHERE id = ? AND text = ? AND vector IS NOT NULL');
      return new VectorSalvage(path, db, lookup, libraryStamp(db), logger);
    } catch (e) {
      db?.close();
      logger?.debug(`Vectors could not be salvaged from ${path}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  /** The stored vector for this exact passage text, or undefined when there is none. */
  vectorFor(id: string, text: string): Uint8Array | undefined {
    if (!this.lookup) return undefined;
    try {
      const row = this.lookup.get(id, text) as { vector?: Uint8Array } | undefined;
      if (!row?.vector) return undefined;
      this.reusedCount++;
      return row.vector;
    } catch (e) {
      // One unreadable row must not take a rebuild down: the passage is embedded instead,
      // and a file that has gone bad under us stops being consulted at all.
      this.logger?.debug(`Vector salvage stopped at ${id}: ${e instanceof Error ? e.message : String(e)}`);
      this.close();
      return undefined;
    }
  }

  /**
   * Why these vectors must not serve a build of `library`, or undefined when they may.
   *
   * A passage id is an item key and a chunk number, and an item key is unique within a
   * library, not across libraries (#44). So the id-plus-text match above is an identity
   * only once both sides are known to be the same library's, and nothing else in the
   * salvage path establishes that: the file is opened inside `sideline()`, at open, long
   * before a build says which library it is crawling, and the fresh index that replaces it
   * is deliberately unstamped. Two gates, and only this one knows about libraries.
   *
   * Both unknowns are permissive, and for the same reason `assertLibrary` exempts them: an
   * unstamped file (written before the stamp existed, or by a build that never reached its
   * first row) says nothing about whose rows it holds, and a caller with no library of its
   * own has asserted nothing to contradict. Refusing on an unknown would strand every
   * pre-stamp index behind a full re-embed to protect against a collision nobody can show.
   */
  refusalFor(library: string | undefined): string | undefined {
    if (!library || !this.library || this.library === library) return undefined;
    return (
      `Vectors were not reused from ${this.path}: it was built for ${describeLibraryToken(this.library)} and ` +
      `this build indexes ${describeLibraryToken(library)}. Item keys repeat across libraries, so a passage id ` +
      'that matches there is not the same passage here. These passages are embedded instead.'
    );
  }

  /** Vectors handed back so far, i.e. passages this rebuild did not have to embed. */
  get reused(): number {
    return this.reusedCount;
  }

  close(): void {
    this.lookup = undefined;
    try {
      this.db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything, so a failure here is not news.
    }
    this.db = undefined;
  }
}

/**
 * The library stamp of a sidelined database, or undefined when it does not carry one.
 *
 * As defensive as the column probe above and for the same reason: `meta` is this build's
 * table, and the file was written by a build whose schema this one does not know, so the
 * table may be shaped differently or absent entirely. An empty value is the same as no
 * value: that is what an index with no library writes.
 */
function libraryStamp(db: Database): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'library'").get() as { value?: string } | undefined;
    return row?.value || undefined;
  } catch {
    return undefined;
  }
}
