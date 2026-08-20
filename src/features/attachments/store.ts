import { readFile } from 'node:fs/promises';
import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import { guessContentType, uploadAttachmentBytes } from '../../api/attachments.js';

/**
 * Shared plumbing for storing a file as a child attachment: resolve the bytes (from a
 * local path or a URL), create the attachment item under a parent, then push the bytes
 * with the 3-phase upload both Zotero backends implement.
 *
 * Two destinations live here, and callers pick one per request:
 *   - `storeLocalAttachment` writes through the Zotero 10+ desktop local API. Preferred
 *     when the app is reachable: no cloud key, no storage quota, bytes stay on the box.
 *   - `storeCloudAttachment` writes through the Web API's File Storage protocol. The
 *     only option when Zoteus runs somewhere the user's desktop is not, which is every
 *     hosted/remote deployment.
 *
 * Used by `zotero_attach_file`, `zotero_attachment`, and `zotero_import`'s `attach_url`,
 * which would otherwise each duplicate the same dance. The connector protocol has its
 * own equivalent (a single saveAttachment call inside the save session), so it is the
 * one path that does not route through here.
 */

const GENERIC_TYPE = 'application/octet-stream';

/** Extensions worth appending when a URL carries none (arXiv PDF URLs do not). */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/html': '.html',
  'application/epub+zip': '.epub',
};

/**
 * Zotero rejects anything that is not a bare file name, since it joins the value onto
 * the storage directory path when the upload lands.
 */
export function bareFilename(name: string, fallback = 'attachment'): string {
  return name.split(/[\\/]/).pop()?.trim() || fallback;
}

/** File name implied by a URL: last path segment, query/fragment stripped, decoded. */
export function filenameFromUrl(url: string, fallback = 'attachment'): string {
  const path = url.split(/[?#]/)[0] ?? url;
  const last = path.split('/').pop() ?? '';
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A malformed percent-escape is not worth failing the attachment over.
  }
  return bareFilename(decoded, fallback);
}

/** Append the extension implied by the content type when the name has none. */
export function withExtensionFor(filename: string, contentType: string): string {
  const ext = EXTENSION_BY_TYPE[contentType];
  if (!ext || filename.toLowerCase().endsWith(ext)) return filename;
  return `${filename}${ext}`;
}

/**
 * Settle on a MIME type: a caller-supplied override wins, then a type actually served
 * over HTTP, then the file name's extension, then `fallback`.
 */
export function resolveContentType(
  filename: string,
  opts: { explicit?: string; served?: string; fallback?: string } = {},
): string {
  if (opts.explicit) return opts.explicit;
  if (opts.served && opts.served !== GENERIC_TYPE) return opts.served;
  const guessed = guessContentType(filename);
  if (guessed !== GENERIC_TYPE) return guessed;
  return opts.fallback ?? GENERIC_TYPE;
}

/** A file URL that answered with a non-2xx status; callers decide how loudly to fail. */
export class AttachmentDownloadError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Download failed (${status}) for ${url}`);
    this.name = 'AttachmentDownloadError';
  }
}

/** Fetch the bytes to attach, with the generous deadline a full-text PDF needs. */
export async function downloadAttachment(
  ctx: Pick<ToolContext, 'fetcher'>,
  url: string,
): Promise<{ bytes: Uint8Array; contentType?: string; filename: string }> {
  const res = await ctx.fetcher.fetch(url, { method: 'GET' }, { maxRetries: 2, deadlineMs: 300_000 });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new AttachmentDownloadError(res.status, url);
  }
  const served = res.headers.get('content-type')?.split(';')[0]?.trim();
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: served || undefined,
    filename: filenameFromUrl(url),
  };
}

/**
 * Resolve everything a store needs from either a local path or a URL: the bytes, a bare
 * file name Zotero will accept, and a settled MIME type. Shared so `path` and `url`
 * behave identically whichever backend the attachment ends up on.
 *
 * `titleHint` names the file when the URL yields nothing usable (a trailing-slash URL),
 * and the extension implied by the content type is appended when the name carries none,
 * since arXiv-style PDF URLs do not carry one.
 */
export async function readAttachmentSource(
  ctx: Pick<ToolContext, 'fetcher'>,
  src: {
    path?: string;
    url?: string;
    filename?: string;
    contentType?: string;
    titleHint?: string;
    fallbackType?: string;
  },
): Promise<{ bytes: Uint8Array; filename: string; contentType: string }> {
  let bytes: Uint8Array;
  let inferredName: string;
  let served: string | undefined;
  if (src.path) {
    bytes = new Uint8Array(await readFile(src.path));
    inferredName = bareFilename(src.path);
  } else if (src.url) {
    const file = await downloadAttachment(ctx, src.url);
    ({ bytes, contentType: served } = file);
    inferredName = file.filename === 'attachment' && src.titleHint ? bareFilename(src.titleHint) : file.filename;
  } else {
    throw new Error('Provide `path` or `url`.');
  }
  const name = bareFilename(src.filename ?? inferredName, inferredName);
  const contentType = resolveContentType(name, {
    explicit: src.contentType,
    served,
    fallback: src.fallbackType,
  });
  return { bytes, filename: withExtensionFor(name, contentType), contentType };
}

/**
 * The attachment item was created but its bytes never landed. Kept distinct from a
 * failure before creation, so callers know that retrying elsewhere would leave an empty
 * attachment behind rather than being a clean second attempt.
 */
export class AttachmentUploadError extends Error {
  constructor(
    readonly attachmentKey: string,
    readonly reason: unknown,
  ) {
    super(
      `Attachment ${attachmentKey} was created, but storing its bytes failed: ` +
        (reason instanceof Error ? reason.message : String(reason)),
    );
    this.name = 'AttachmentUploadError';
  }
}

/**
 * Create an `imported_file` attachment under `parent` and store the bytes on it
 * (authorize -> POST bytes -> register). Returns the new attachment key; throws with a
 * human-readable reason when Zotero refuses the item or the upload.
 */
export async function storeLocalAttachment(
  ctx: Pick<ToolContext, 'localWrites'>,
  file: { parent: string; bytes: Uint8Array; filename: string; contentType: string; title?: string; url?: string },
): Promise<string> {
  if (!ctx.localWrites) throw new Error('Zotero desktop local-API writes are not available.');
  const item: Record<string, unknown> = {
    itemType: 'attachment',
    parentItem: file.parent,
    linkMode: 'imported_file',
    title: file.title ?? file.filename,
    contentType: file.contentType,
    tags: [],
  };
  // Keep the provenance of a downloaded file on the attachment itself.
  if (file.url) item.url = file.url;
  const result = await ctx.localWrites.writeItems([item]);
  if (result.failed.length || !result.successful.length) {
    throw new Error(`Could not create attachment item: ${JSON.stringify(result.failed)}`);
  }
  const attachmentKey = result.successful[0]?.key;
  if (!attachmentKey) throw new Error('Local write returned no attachment key.');
  try {
    await ctx.localWrites.uploadFile(attachmentKey, {
      bytes: file.bytes,
      filename: file.filename,
      contentType: file.contentType,
    });
  } catch (e) {
    throw new AttachmentUploadError(attachmentKey, e);
  }
  return attachmentKey;
}

/**
 * Cloud sibling of `storeLocalAttachment`: create the attachment under `parent` and push
 * the bytes through the Web API's File Storage protocol. Needs an API key with file
 * access and consumes the account's storage quota, but requires nothing running on the
 * user's machine, so it is what remote deployments and group libraries use.
 *
 * Returns the new key plus whether Zotero already had those exact bytes in storage, in
 * which case the upload short-circuits and only the item is new.
 */
export async function storeCloudAttachment(
  ctx: Pick<ToolContext, 'web'>,
  lib: LibraryRef,
  file: { parent?: string; bytes: Uint8Array; filename: string; contentType: string; title?: string; url?: string },
): Promise<{ key: string; exists: boolean }> {
  const result = await uploadAttachmentBytes(ctx.web, lib, {
    bytes: file.bytes,
    filename: file.filename,
    contentType: file.contentType,
    parentItem: file.parent,
    title: file.title ?? file.filename,
    url: file.url,
  });
  return { key: result.key, exists: result.exists };
}
