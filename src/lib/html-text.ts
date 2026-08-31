/**
 * HTML to readable text, with no dependency beyond Node itself.
 *
 * Written for EPUB chapters and used by the search index for Zotero notes, which are HTML
 * documents too: a note indexed with its markup still in it matches `div` and `strong` and
 * pushes real words out of every snippet it appears in. One implementation for both, so
 * the two never disagree about what a paragraph break is.
 */

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
