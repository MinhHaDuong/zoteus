/**
 * Optional exact-page support for W1 `precise_pages`. Lazily imports the optional
 * `pdfjs-dist` dependency; if it is absent or extraction fails, returns null so the
 * caller degrades to approximate pages. Never throws for missing-dependency reasons.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[] | null> {
  let pdfjs: any;
  try {
    // Legacy build runs under Node without a DOM.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
  } catch {
    return null; // dependency not installed — degrade
  }
  try {
    const loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false });
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
