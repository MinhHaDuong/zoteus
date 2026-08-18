import type { ToolContext } from '../../registry/registry.js';
import { guessContentType } from '../../api/attachments.js';

/**
 * Shared plumbing for storing a file as an `imported_file` attachment through the
 * Zotero 10+ desktop local API: download the bytes, create the attachment item under
 * a parent, then push the bytes with the local API's 3-phase upload.
 *
 * Used by `zotero_attach_file` and by `zotero_import`'s local-API save path
 * (`attach_url`), which would otherwise duplicate the same dance. The connector
 * protocol has its own equivalent (a single saveAttachment call inside the save
 * session), so only the local-API side lives here.
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
  await ctx.localWrites.uploadFile(attachmentKey, {
    bytes: file.bytes,
    filename: file.filename,
    contentType: file.contentType,
  });
  return attachmentKey;
}
