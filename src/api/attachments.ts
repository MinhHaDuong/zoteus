import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { WebApiClient, LibraryRef } from './web-client.js';

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.epub': 'application/epub+zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

export function guessContentType(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export interface UploadOptions {
  filePath: string;
  parentItem?: string;
  title?: string;
  contentType?: string;
  linkMode?: string;
}

export interface UploadBytesOptions {
  bytes: Uint8Array;
  /** Bare file name to store under; Zotero joins it onto the storage directory. */
  filename: string;
  parentItem?: string;
  title?: string;
  contentType?: string;
  linkMode?: string;
  /** Where the bytes came from. Kept on the attachment, and implies `imported_url`. */
  url?: string;
  /** Modification time in ms since the epoch; defaults to now for in-memory bytes. */
  mtime?: number;
}

export interface UploadResult {
  key: string;
  exists: boolean;
  filename: string;
}

/**
 * Run the full 5-step Zotero File Storage upload for bytes already in memory.
 *
 * This is the only file-write path that works without the Zotero desktop app, so it is
 * what a remote/hosted Zoteus uses: the desktop local API listens on the *user's*
 * loopback interface, which a server elsewhere has no route to.
 */
export async function uploadAttachmentBytes(
  web: WebApiClient,
  lib: LibraryRef,
  opts: UploadBytesOptions,
): Promise<UploadResult> {
  const { bytes, filename } = opts;
  const md5 = createHash('md5').update(bytes).digest('hex');
  const mtime = opts.mtime ?? Date.now();
  const contentType = opts.contentType ?? guessContentType(filename);

  // Step 1: create the attachment item. A file fetched from the web is an
  // `imported_url` (what Zotero itself records for a downloaded PDF), which keeps the
  // source URL on the attachment; bytes read off disk stay `imported_file`.
  const itemObj: Record<string, unknown> = {
    itemType: 'attachment',
    linkMode: opts.linkMode ?? (opts.url ? 'imported_url' : 'imported_file'),
    title: opts.title ?? filename,
    filename,
    contentType,
  };
  if (opts.parentItem) itemObj.parentItem = opts.parentItem;
  if (opts.url) itemObj.url = opts.url;
  const created = await web.writeItems(lib, [itemObj]);
  if (!created.successful.length) {
    throw new Error(`Failed to create attachment item: ${JSON.stringify(created.failed)}`);
  }
  const key = created.successful[0]!.key;

  // Step 2: request upload authorization.
  const auth = await web.requestUpload(lib, key, { md5, filename, filesize: bytes.byteLength, mtime });

  // Step 3: short-circuit if the file already exists in storage.
  if (auth.exists === 1) return { key, exists: true, filename };

  // Step 4: upload prefix + bytes + suffix to the storage URL.
  const enc = new TextEncoder();
  const body = concatBytes(enc.encode(auth.prefix ?? ''), bytes, enc.encode(auth.suffix ?? ''));
  await web.uploadBytes(auth.url, auth.contentType, body);

  // Step 5: register the completed upload.
  await web.registerUpload(lib, key, auth.uploadKey);
  return { key, exists: false, filename };
}

/** Run the full 5-step Zotero File Storage upload for a local file. */
export async function uploadFile(
  web: WebApiClient,
  lib: LibraryRef,
  opts: UploadOptions,
): Promise<UploadResult> {
  const bytes = new Uint8Array(await readFile(opts.filePath));
  const st = await stat(opts.filePath);
  return uploadAttachmentBytes(web, lib, {
    bytes,
    filename: basename(opts.filePath),
    mtime: Math.floor(st.mtimeMs),
    parentItem: opts.parentItem,
    title: opts.title,
    contentType: opts.contentType,
    linkMode: opts.linkMode,
  });
}

export async function downloadFile(
  web: WebApiClient,
  lib: LibraryRef,
  key: string,
  savePath: string,
): Promise<{ savePath: string; bytes: number; contentType?: string }> {
  const { bytes, contentType } = await web.downloadFileBytes(lib, key);
  await writeFile(savePath, bytes);
  return { savePath, bytes: bytes.byteLength, contentType };
}
