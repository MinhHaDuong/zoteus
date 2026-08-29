/**
 * Text extraction for EPUB attachments, with no dependency beyond Node itself.
 *
 * An EPUB is a zip of XHTML documents plus a package file that puts them in reading order,
 * so the whole job is a zip reader and a tag stripper. Both live here rather than in a
 * dependency: the zip subset an EPUB uses is small (stored and deflated entries, no
 * encryption, no zip64), `node:zlib` already inflates a raw deflate stream, and a parser
 * pulled in for this would be a second archive stack sitting next to `pdfjs-dist` for a
 * format that needs a fraction of it.
 *
 * Nothing here throws: a file that is not a readable EPUB comes back as null, the same
 * degrade the PDF path makes, because the caller's job is to explain the miss and move on.
 */

import { inflateRawSync } from 'node:zlib';

/**
 * Default cap on EPUB bytes. Well above any real book (a heavily illustrated EPUB is a
 * few tens of MB, and its text is a small part of that) and the same order as the PDF
 * parsing cap, so one oversized attachment cannot take the process down with it.
 */
export const DEFAULT_EPUB_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Ceiling on the bytes an archive is allowed to inflate to. Deflate reaches ratios above
 * 1000:1 on repetitive input, so an archive well under the byte cap can still ask for
 * gigabytes of memory. Extraction stops at this point and keeps what it has.
 */
const MAX_INFLATED_BYTES = 128 * 1024 * 1024; // 128 MB

/** The parts of an EPUB a reader cares about: its documents, in reading order. */
export interface EpubText {
  /** Every section joined, blank line separated, in spine order. */
  text: string;
  /** One entry per document in the spine (chapters, front matter, notes). */
  sections: string[];
}

const decoder = new TextDecoder('utf-8');

/**
 * The EPUB's text, in reading order, or null when the file cannot be read as one.
 *
 * The spine in the package document is the reading order the book itself declares, which
 * is not the alphabetical order of the files inside the archive: taking the archive's
 * order puts chapter 10 before chapter 2 and scatters the front matter. Where the package
 * cannot be parsed, every XHTML document in the archive is used in name order, which at
 * least returns the text.
 */
export function extractEpubText(bytes: Uint8Array, opts: { maxBytes?: number } = {}): EpubText | null {
  const maxBytes = opts.maxBytes ?? DEFAULT_EPUB_MAX_BYTES;
  if (bytes.byteLength > maxBytes) return null;
  let archive: ZipArchive | null;
  try {
    archive = readZip(bytes);
  } catch {
    return null;
  }
  if (!archive) return null;

  const order = spineOrder(archive) ?? htmlEntriesByName(archive);
  const sections: string[] = [];
  for (const name of order) {
    const raw = archive.read(name);
    if (!raw) continue;
    const text = htmlToText(decoder.decode(raw));
    if (text) sections.push(text);
  }
  if (!sections.length) return null;
  return { text: sections.join('\n\n'), sections };
}

/** Whether these bytes are a zip container at all (an EPUB always is). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

// ---------------------------------------------------------------------------
// Reading order
// ---------------------------------------------------------------------------

/** The path of the package document (`.opf`), named by `META-INF/container.xml`. */
function packagePath(archive: ZipArchive): string | undefined {
  const container = archive.read('META-INF/container.xml');
  if (!container) return undefined;
  const match = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(decoder.decode(container));
  return match?.[1];
}

/**
 * Document names in spine order: the `<spine>` lists manifest ids, and the manifest maps
 * each id to a file. Returns undefined (not an empty list) when the package is missing or
 * unparseable, so the caller can tell "no spine" from "an empty spine".
 */
function spineOrder(archive: ZipArchive): string[] | undefined {
  const opfPath = packagePath(archive);
  if (!opfPath) return undefined;
  const opfBytes = archive.read(opfPath);
  if (!opfBytes) return undefined;
  const opf = decoder.decode(opfBytes);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const hrefById = new Map<string, string>();
  for (const item of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = item[0];
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const type = /\bmedia-type\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    if (!id || !href) continue;
    // Images, fonts and stylesheets are in the manifest too; only documents carry text.
    if (type && !/html/i.test(type)) continue;
    hrefById.set(id, resolveHref(base, href));
  }

  const order: string[] = [];
  for (const ref of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = /\bidref\s*=\s*["']([^"']*)["']/i.exec(ref[0])?.[1];
    const href = idref ? hrefById.get(idref) : undefined;
    if (href) order.push(href);
  }
  return order.length ? order : undefined;
}

/** Every XHTML/HTML entry in the archive, in name order. The fallback reading order. */
function htmlEntriesByName(archive: ZipArchive): string[] {
  return archive
    .names()
    .filter((n) => /\.(x?html?|htm)$/i.test(n))
    .sort();
}

/** Resolve a manifest href against the package document's own directory. */
function resolveHref(base: string, href: string): string {
  let path = href.split(/[?#]/)[0] ?? href;
  try {
    path = decodeURIComponent(path);
  } catch {
    // A malformed escape is not worth dropping the chapter over; use it verbatim.
  }
  const segments = (base + path).split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

// ---------------------------------------------------------------------------
// XHTML to text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '-',
  ndash: '-',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Tags that end a line of prose, so stripping them does not run two paragraphs together. */
const BLOCK_TAG = /^\/?(?:p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|table|ul|ol|dd|dt|figure|figcaption|hr|header|footer|nav|aside)\b/i;

/**
 * Readable text from one XHTML document: scripts and styles dropped whole, block tags
 * turned into line breaks so paragraphs stay apart, everything else removed, entities
 * decoded, and runs of blank space collapsed.
 */
export function htmlToText(html: string): string {
  const withoutHead = html
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const withBreaks = withoutHead.replace(/<([^>]*)>/g, (_whole, inner: string) =>
    BLOCK_TAG.test(inner.trim()) ? '\n' : ' ',
  );
  return decodeEntities(withBreaks)
    // Non-breaking spaces are what `&nbsp;` decoded to, and they collapse like any other.
    .replace(/[ \t\u00a0\u2007\u202f]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// The zip subset an EPUB uses
// ---------------------------------------------------------------------------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface ZipArchive {
  names(): string[];
  /** The entry's bytes, or undefined when it is absent or cannot be inflated. */
  read(name: string): Uint8Array | undefined;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record plus the largest comment that can follow it. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

/**
 * Index a zip archive from its central directory, which is the only place the entry sizes
 * can be trusted: a local header may declare zeroes and defer the real numbers to a data
 * descriptor after the entry, and streaming writers routinely do.
 */
function readZip(bytes: Uint8Array): ZipArchive | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  // 0xFFFFFFFF is the zip64 marker: the real offset lives in an extra field this reader
  // does not implement. No EPUB is that large, so this is a clean "not readable here".
  if (offset === 0xffffffff) return null;

  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, {
      name,
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries.size) return null;

  let inflated = 0;
  const read = (name: string): Uint8Array | undefined => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const start = entry.localHeaderOffset;
    if (start + 30 > bytes.byteLength || view.getUint32(start, true) !== LOCAL_SIGNATURE) return undefined;
    // Only the local header's own name/extra lengths locate the data; the central
    // directory's extra field is a different one and is routinely a different length.
    const dataStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.byteLength) return undefined;
    if (inflated + entry.uncompressedSize > MAX_INFLATED_BYTES) return undefined;
    const raw = bytes.subarray(dataStart, dataEnd);
    if (entry.method === 0) {
      inflated += raw.byteLength;
      return raw;
    }
    if (entry.method !== 8) return undefined; // deflate and stored are all an EPUB may use
    try {
      const out = new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES - inflated }));
      inflated += out.byteLength;
      return out;
    } catch {
      return undefined;
    }
  };

  return { names: () => [...entries.keys()], read };
}

/** Locate the end-of-central-directory record, scanning back from the end of the file. */
function findEocd(view: DataView, length: number): number {
  const floor = Math.max(0, length - MAX_EOCD_SEARCH);
  for (let i = length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}
