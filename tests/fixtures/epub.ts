import { deflateRawSync } from 'node:zlib';

/**
 * Zip and EPUB builders for the tests, so the EPUB fixtures are real archives rather than
 * checked-in binaries: a hand-built one can be varied per test (stored vs deflated entries,
 * a spine out of alphabetical order, a missing package document) in a way a fixture file
 * cannot.
 */

export interface ZipFile {
  name: string;
  data: string | Uint8Array;
  /** Deflate the entry (the default); false stores it, as an EPUB's `mimetype` must be. */
  deflate?: boolean;
  /**
   * Bytes of an extra field to put in the LOCAL header only. Real zip writers do this (a
   * timestamp field in the local header, a shorter one in the central directory), so an
   * entry's data cannot be located from the central directory's lengths alone.
   */
  localExtra?: number;
}

const enc = new TextEncoder();

/** A zip archive holding exactly these entries, in this order. */
export function buildZip(files: ZipFile[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const raw = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const deflate = file.deflate ?? true;
    const body = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = deflate ? 8 : 0;

    const extra = file.localExtra ?? 0;
    const local = new Uint8Array(30 + name.length + extra + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, extra, true);
    local.set(name, 30);
    local.set(body, 30 + name.length + extra);
    locals.push(local);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    offset += local.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let at = 0;
  for (const part of [...locals, ...central, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface EpubChapter {
  /** Manifest id, referenced by the spine. */
  id: string;
  /** File name inside `OEBPS/`. */
  href: string;
  /** Body markup of the chapter. */
  html: string;
}

const CHAPTERS: EpubChapter[] = [
  { id: 'c2', href: 'ch2.xhtml', html: '<h1>Chapter Two</h1><p>The Hessian is decomposed &amp; reused.</p>' },
  { id: 'c10', href: 'ch10.xhtml', html: '<p>Chapter Ten talks about robot-centric elevation maps.</p>' },
];

/**
 * A minimal but structurally real EPUB. The spine deliberately lists `ch2` before `ch10`,
 * which is the opposite of the archive's alphabetical order, so a reader that ignores the
 * spine is visible in the output.
 */
export function buildEpub(chapters: EpubChapter[] = CHAPTERS): Uint8Array {
  const manifest = chapters
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join('');
  const spine = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('');
  return buildZip([
    { name: 'mimetype', data: 'application/epub+zip', deflate: false },
    {
      name: 'META-INF/container.xml',
      data:
        '<?xml version="1.0"?><container><rootfiles>' +
        '<rootfile full-path="OEBPS/book.opf" media-type="application/oebps-package+xml"/>' +
        '</rootfiles></container>',
    },
    {
      name: 'OEBPS/book.opf',
      data:
        '<?xml version="1.0"?><package><manifest>' +
        manifest +
        '<item id="css" href="style.css" media-type="text/css"/>' +
        `</manifest><spine>${spine}</spine></package>`,
    },
    ...chapters.map((c) => ({
      name: `OEBPS/${c.href}`,
      data: `<html><head><style>p { color: red }</style></head><body>${c.html}</body></html>`,
    })),
    { name: 'OEBPS/style.css', data: 'p { color: red }' },
  ]);
}
