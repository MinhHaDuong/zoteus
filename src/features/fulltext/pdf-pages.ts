/**
 * Default cap on PDF bytes for exact-page re-extraction. pdfjs decodes the whole document
 * (objects + images) into memory and can balloon to many× the file size — on a small host
 * (e.g. a 1 GB free-tier VM) a large PDF OOM-kills the process. Above this we degrade to
 * approximate pages; the indexed cloud full text is still returned, so grounding still works.
 */
export const DEFAULT_PRECISE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Optional exact-page support for W1 `precise_pages`. Lazily imports the optional
 * `pdfjs-dist` dependency; if it is absent, the PDF is too large (`maxBytes`), or extraction
 * fails, returns null so the caller degrades to approximate pages. Never throws.
 */
export async function extractPdfPages(
  bytes: Uint8Array,
  opts: { maxBytes?: number } = {},
): Promise<string[] | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  // Refuse before importing/parsing: a large PDF would OOM pdfjs on a small host.
  if (bytes.byteLength > maxBytes) return null;
  let pdfjs: any;
  try {
    // Legacy build runs under Node without a DOM.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
  } catch {
    return null; // dependency not installed — degrade
  }
  try {
    // pdfjs transfers (detaches) the buffer it is given; hand it a copy so the
    // caller's bytes stay intact (matters when the same buffer is re-extracted).
    const data = bytes.slice();
    const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
    const doc = await loadingTask.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push((content.items as any[]).map((it) => it.str ?? '').join(' '));
    }
    return pages;
  } catch {
    return null; // corrupt PDF / parse failure — degrade
  }
}

/** Join extracted page texts into one document text (pages separated by a blank line). */
export function pdfPagesToText(pages: string[]): string {
  return pages.join('\n\n');
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 1-based page whose text contains the passage's leading window, or undefined. */
export function locatePage(pages: string[], passage: string, headChars = 60): number | undefined {
  const needle = normalize(passage).slice(0, headChars);
  if (!needle) return undefined;
  for (let i = 0; i < pages.length; i++) {
    if (normalize(pages[i]!).includes(needle)) return i + 1;
  }
  return undefined;
}
