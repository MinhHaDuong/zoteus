import { describe, it, expect } from 'vitest';
import { extractEpubText, htmlToText, looksLikeZip, DEFAULT_EPUB_MAX_BYTES } from '../../src/features/fulltext/epub.js';
import { buildEpub, buildZip } from '../fixtures/epub.js';

describe('extractEpubText', () => {
  it('reads the documents in spine order, not the archive order', () => {
    // The spine lists ch2 before ch10; sorting the archive by name would swap them.
    const result = extractEpubText(buildEpub());
    expect(result).not.toBeNull();
    expect(result!.sections).toHaveLength(2);
    expect(result!.sections[0]).toContain('Chapter Two');
    expect(result!.sections[1]).toContain('Chapter Ten');
    expect(result!.text.indexOf('Chapter Two')).toBeLessThan(result!.text.indexOf('Chapter Ten'));
  });

  it('leaves stylesheets and other non-document manifest entries out of the text', () => {
    const result = extractEpubText(buildEpub());
    expect(result!.text).not.toContain('color: red');
  });

  it('decodes entities and keeps block elements apart', () => {
    const result = extractEpubText(buildEpub());
    expect(result!.text).toContain('The Hessian is decomposed & reused.');
    // The heading must not run into the paragraph that follows it.
    expect(result!.sections[0]).toMatch(/Chapter Two\n+The Hessian/);
  });

  it('reads stored (uncompressed) entries as well as deflated ones', () => {
    const zip = buildZip([
      { name: 'a.xhtml', data: '<p>stored alpha</p>', deflate: false },
      { name: 'b.xhtml', data: '<p>deflated beta</p>' },
    ]);
    const result = extractEpubText(zip);
    expect(result!.sections).toEqual(['stored alpha', 'deflated beta']);
  });

  it("locates entry data from the local header's own extra field, not the central directory's", () => {
    // Real zip writers put a longer extra field in the local header than in the central
    // directory; reading the central directory's length would land mid-entry.
    const zip = buildZip([
      { name: 'a.xhtml', data: '<p>alpha</p>', localExtra: 9 },
      { name: 'b.xhtml', data: '<p>beta</p>', localExtra: 21 },
    ]);
    expect(extractEpubText(zip)!.sections).toEqual(['alpha', 'beta']);
  });

  it('falls back to every XHTML entry in name order when there is no package document', () => {
    const zip = buildZip([
      { name: 'b.xhtml', data: '<p>beta</p>' },
      { name: 'a.xhtml', data: '<p>alpha</p>' },
      { name: 'cover.png', data: new Uint8Array([1, 2, 3]) },
    ]);
    expect(extractEpubText(zip)!.sections).toEqual(['alpha', 'beta']);
  });

  it('returns null for bytes that are not a readable archive (degrade, not throw)', () => {
    expect(extractEpubText(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(extractEpubText(new Uint8Array(0))).toBeNull();
  });

  it('returns null for an archive with no documents in it', () => {
    expect(extractEpubText(buildZip([{ name: 'cover.png', data: new Uint8Array([1, 2, 3]) }]))).toBeNull();
  });

  it('refuses above the byte cap without unpacking anything', () => {
    expect(extractEpubText(buildEpub(), { maxBytes: 10 })).toBeNull();
  });

  it('DEFAULT_EPUB_MAX_BYTES is a sane cap (1MB..64MB)', () => {
    expect(DEFAULT_EPUB_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_EPUB_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

describe('looksLikeZip', () => {
  it('recognises a zip container and nothing else', () => {
    expect(looksLikeZip(buildEpub())).toBe(true);
    expect(looksLikeZip(new TextEncoder().encode('%PDF-1.4 ...'))).toBe(false);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b]))).toBe(false);
  });
});

describe('htmlToText', () => {
  it('drops script and style blocks whole rather than emitting their source', () => {
    const text = htmlToText('<p>keep</p><script>var drop = 1;</script><style>.drop{}</style><p>keep too</p>');
    expect(text).toContain('keep');
    expect(text).toContain('keep too');
    expect(text).not.toContain('var drop');
    expect(text).not.toContain('.drop');
  });

  it('decodes named and numeric character references', () => {
    expect(htmlToText('<p>caf&#233; &amp; cr&egrave;me &#x41;</p>')).toBe('café & cr&egrave;me A');
  });

  it('collapses runs of blank space without welding words together', () => {
    expect(htmlToText('<p>one</p>\n\n\n<p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('<span>one</span><span>two</span>')).toBe('one two');
  });
});
