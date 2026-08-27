import { unlink } from 'node:fs/promises';
import type { ToolContext } from '../../registry/registry.js';
import type { StorageBackend } from './backend.js';

/** What a repair did, so the caller can say it rather than claim a plain rebuild. */
export interface RepairReport {
  /** Files actually removed, in the order they were removed. */
  removed: string[];
  storage: StorageBackend;
}

/**
 * Delete an unreadable search index and open a fresh one in its place.
 *
 * Only ever called for an explicit `zotero_index action:"build"`, and that restriction is
 * the whole policy. A build is the one call where the caller has already asked for the
 * expensive thing and knows it, which makes deleting a derived cache on their behalf
 * something they consented to. The two places this must NOT happen are startup — a server
 * that silently takes ten minutes to start is worse than one that explains why it will not
 * search — and inside an ordinary query, for the same reason at smaller scale.
 *
 * The files come from the fault, never recomputed from the data dir, so a repair can only
 * remove what the refusal named. Sidecars go before the database itself: a fresh database
 * beside an orphaned write-ahead log is the one arrangement that turns a repair into a
 * second corruption.
 */
export async function repairSearchIndex(ctx: ToolContext): Promise<RepairReport> {
  const fault = ctx.search.storeFault as (Error & { files?: string[] }) | undefined;
  if (!fault) throw new Error('The search index reports no fault, so there is nothing to repair.');
  const files = fault.files ?? [];
  if (!files.length) {
    throw new Error(`${fault.message}\n\nThe fault names no file to remove, so it cannot be repaired automatically.`);
  }
  // Checked BEFORE anything is deleted, not inside the reopen. A fault can be recorded
  // while a build is running — a concurrent query that meets corruption records one — and
  // a running build holds the index object rather than reading the field, so it cannot be
  // swapped under. Discovering that after the files are gone would leave the user with no
  // index and a refusal, which is worse than either outcome on its own.
  if (ctx.search.isBuilding) {
    throw new Error(
      'The search index cannot be repaired while a build is running, and nothing has been deleted. ' +
        'Stop it first with zotero_index action:"stop", then call action:"build" again.',
    );
  }
  // Released before the files go. On Windows an open handle refuses the unlink outright, so
  // a fault recorded mid-flight — where this process still holds the database open — would
  // otherwise be exactly the case the in-product repair could not fix. `reopenSearchIndex`
  // closes again and a second close is a no-op on both backends.
  await ctx.search.close().catch(() => {});

  const removed: string[] = [];
  for (const file of files) {
    try {
      await unlink(file);
      removed.push(file);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // Already gone is the outcome we wanted.
      if (err.code === 'ENOENT') continue;
      // Anything else stops the repair before a single file is opened, rather than part
      // way through: another process on a shared data dir may hold the database, and on
      // Windows an open handle refuses the unlink outright. A half-deleted index is worse
      // than the one we started with.
      throw new Error(
        `The search index could not be repaired: ${file} could not be deleted (${err.code ?? 'unknown error'}: ${err.message}). ` +
          'Another process may be holding it (a second Zoteus sharing this data dir), or it may be read-only. ' +
          `Close anything else using it and try again, or delete it by hand and restart.${
            removed.length ? ` Already removed: ${removed.join(', ')}.` : ''
          }`,
      );
    }
  }

  const fresh = await ctx.reopenSearchIndex();
  // One attempt, never a loop: if a brand-new file is unreadable the problem is not the
  // file, and trying again would only delete whatever the second open produced.
  if (fresh.storeFault) throw fresh.storeFault;
  return { removed, storage: fresh.storage };
}
