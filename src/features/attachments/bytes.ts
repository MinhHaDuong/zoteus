import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ToolContext } from '../../registry/registry.js';
import { ensureLocalApi } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';

/**
 * Reading an attachment's bytes, from whichever side of Zoteus can reach them.
 *
 * Three sources, tried in the order of what they cost and what they can see:
 *
 *   1. `local-api`: the running Zotero desktop app reads the file off its own disk
 *      (`/items/<key>/file` answers a `file://` redirect). Free, and it reaches PDFs the
 *      cloud has no copy of: an unsynced attachment, a local-only library, a library whose
 *      storage quota was never bought.
 *   2. `storage`: the same file read straight out of `<Zotero data dir>/storage/<key>/`.
 *      This is what closes the gap the local API leaves: Zotero does not have to be
 *      RUNNING for its files to be on the disk, and a machine that shares them can open an
 *      attachment added minutes ago while the app is closed.
 *   3. `cloud`: the Web API file download. The only route a hosted Zoteus has, and it
 *      needs the file to have synced and the key to carry file access.
 *
 * Never throws: every source that cannot answer is recorded as a reason, so a caller can
 * tell the user which doors were tried and why each was shut.
 */

/** Which of the three sources produced the bytes; surfaced to callers as provenance. */
export type AttachmentByteSource = 'local-api' | 'storage' | 'cloud';

export interface LoadedAttachmentBytes {
  bytes: Uint8Array;
  source: AttachmentByteSource;
}

export interface LoadAttachmentBytesOptions {
  /** The attachment item key. */
  key: string;
  /** Target library; undefined means the default (personal) library. */
  library?: LibraryRef;
  /** The attachment's `filename`, when known: names the file inside `storage/<key>/`. */
  filename?: string;
  /**
   * Refuse a file larger than this without reading it into memory. Only the `storage`
   * source can check before reading; the others are already streamed into a buffer by the
   * client that fetched them.
   */
  maxBytes?: number;
}

export interface LoadAttachmentBytesResult {
  bytes?: Uint8Array;
  source?: AttachmentByteSource;
  /** The file exists here but exceeds `maxBytes`, so no source was allowed to read it. */
  tooLarge?: boolean;
  /** Why each source that was tried could not answer (in the order they were tried). */
  reasons: string[];
}

/** Zotero's own bookkeeping inside a storage folder; never the attachment itself. */
const STORAGE_SIDECARS = new Set(['.zotero-ft-cache', '.zotero-ft-info', '.zotero-reader-state']);

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The attachment file, from the first source that can produce it. Returns
 * `{ reasons }` with no bytes when none can, rather than throwing: the callers all have a
 * better error to write than any single source's failure.
 */
export async function loadAttachmentBytes(
  ctx: ToolContext,
  opts: LoadAttachmentBytesOptions,
): Promise<LoadAttachmentBytesResult> {
  const reasons: string[] = [];
  const { key } = opts;

  // 1. The running desktop app. Only for the default library: an explicit group library
  //    may well be one the app does not hold, and the cloud is the answer for those.
  if (!opts.library && ctx.local && (await ensureLocalApi(ctx))) {
    try {
      const bytes = await ctx.local.downloadFileBytes(key);
      if (bytes.byteLength) return { bytes, source: 'local-api', reasons };
      reasons.push('the Zotero desktop app returned an empty file');
    } catch (e) {
      reasons.push(`the Zotero desktop app could not read it (${why(e)})`);
    }
  }

  // 2. The storage folder on this machine, which does not need Zotero to be running.
  const fromDisk = await readFromStorage(ctx, opts);
  if (fromDisk.bytes) return { bytes: fromDisk.bytes, source: 'storage', reasons };
  if (fromDisk.reason) reasons.push(fromDisk.reason);
  // The local copy IS the file: once it is known to be too large, downloading the same
  // bytes from the cloud only spends the transfer to arrive at the same refusal.
  if (fromDisk.tooLarge) return { tooLarge: true, reasons };

  // 3. The cloud. A context that never probed capabilities still tries (that is a
  //    hand-built one, e.g. a test); a probed one that found no key does not.
  if (ctx.capabilities?.cloud === null) {
    reasons.push('no cloud API key is configured, so it could not be downloaded');
    return { reasons };
  }
  try {
    const lib = opts.library ?? ctx.router.defaultLibrary();
    const { bytes } = await ctx.web.downloadFileBytes(lib, key);
    if (bytes.byteLength) return { bytes, source: 'cloud', reasons };
    reasons.push('Zotero storage returned an empty file');
  } catch (e) {
    reasons.push(`it could not be downloaded from Zotero storage (${why(e)})`);
  }
  return { reasons };
}

/**
 * The attachment file read out of `<Zotero data dir>/storage/<key>/`.
 *
 * Zotero names the folder after the attachment key and puts the file inside it under its
 * own name, beside the extraction sidecars it writes (`.zotero-ft-cache` and friends).
 * With a `filename` from the item metadata the file is addressed directly; without one the
 * folder is listed and the single non-sidecar entry taken, which is what a stored
 * attachment always holds.
 *
 * `filename` is reduced to its base name before being joined: it comes from library data,
 * and a value with a path in it must not be able to address a file outside the folder.
 */
async function readFromStorage(
  ctx: ToolContext,
  opts: LoadAttachmentBytesOptions,
): Promise<{ bytes?: Uint8Array; reason?: string; tooLarge?: boolean }> {
  const dataDir = ctx.config?.zoteroDataDir;
  if (!dataDir) return {};
  const dir = join(dataDir, 'storage', basename(opts.key));
  let name = opts.filename ? basename(opts.filename) : undefined;
  if (!name) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // No folder for this key: the file was never stored on this machine. Not worth a
      // reason of its own, since a hosted Zoteus has no storage folder at all.
      return {};
    }
    name = entries.find((e) => !e.startsWith('.') && !STORAGE_SIDECARS.has(e));
    if (!name) return { reason: `the Zotero storage folder for ${opts.key} holds no file` };
  }
  const path = join(dir, name);
  try {
    if (opts.maxBytes != null) {
      const st = await stat(path);
      if (st.size > opts.maxBytes) {
        return {
          tooLarge: true,
          reason: `the file in Zotero's storage folder is larger than the ${opts.maxBytes}-byte parsing limit`,
        };
      }
    }
    return { bytes: new Uint8Array(await readFile(path)) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // ENOENT here means the folder exists but not that file: a linked-file attachment, or
    // one whose bytes have not synced down to this machine yet.
    if (code === 'ENOENT') return {};
    return { reason: `the file in Zotero's storage folder could not be read (${why(e)})` };
  }
}
