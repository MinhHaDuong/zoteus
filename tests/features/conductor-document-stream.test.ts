import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  ContentScanner,
  MAX_ENVELOPE_CHARS,
  streamFullText,
  WINDOW_CHARS,
} from '../../src/features/search/conductor/document-stream.js';
import type { DocumentWindow } from '../../src/features/search/conductor/document-stream.js';
import { ManualClock } from '../fixtures/clock.js';
import { ReplayLocalApi } from '../fixtures/local-api-replay.js';

/**
 * The whole-document GET, decoded incrementally (SPEC.md §5.2.4, §5.2.5).
 *
 * Everything worth testing here is a *chunk boundary*. A scanner that buffers the whole
 * response and parses it would pass every content assertion below and fail the one property
 * the design needs, which is that no step holds the document; a scanner that streams passes
 * the content assertions too, right up until a network chunk lands in the middle of a
 * `\uXXXX` escape or between the halves of a surrogate pair. So the load-bearing test is
 * not "does it decode this document" — it is "does it decode this document identically at
 * every one of its split points", which is what `everySplit` asserts.
 */

const sha256 = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** Run one envelope through the scanner, split at `at`, and report what came out. */
function scanSplitAt(envelope: string, at: number, windowChars = 1024): { text: string; hash: string; windows: number } {
  const scanner = new ContentScanner(windowChars);
  const out: DocumentWindow[] = [];
  out.push(...scanner.push(envelope.slice(0, at)));
  out.push(...scanner.push(envelope.slice(at)));
  out.push(...scanner.end());
  return { text: out.map((w) => w.text).join(''), hash: scanner.textHash(), windows: out.length };
}

/** The same envelope split at every single position. Any boundary bug shows up as a diff. */
function everySplit(envelope: string, windowChars = 1024): Set<string> {
  const seen = new Set<string>();
  for (let at = 0; at <= envelope.length; at++) {
    const r = scanSplitAt(envelope, at, windowChars);
    seen.add(`${r.hash}|${r.text}`);
  }
  return seen;
}

function envelopeOf(content: string, meta: { indexedPages?: number; totalPages?: number } = {}): string {
  return JSON.stringify({ content, indexedPages: meta.indexedPages ?? 2, totalPages: meta.totalPages ?? 2 });
}

describe('the whole-document GET: incremental decode', () => {
  it('decodes a plain document, and the hash is over the text rather than the envelope', () => {
    const text = 'The estimator is consistent under the stated moment conditions.';
    const r = scanSplitAt(envelopeOf(text), 0);
    expect(r.text).toBe(text);
    // The positive control for the whole file: the streamed hash equals the hash of the
    // same text read whole. Without this every assertion above is satisfied by a scanner
    // that hashes something plausible and wrong.
    expect(r.hash).toBe(sha256(text));
  });

  it('gives the same text and the same hash wherever the chunks happen to break', () => {
    // Every escape class in one document, so a boundary lands inside each of them in turn.
    const text = 'a\nb\tc"d\\e/fég\u{1f600}hi';
    expect(everySplit(envelopeOf(text)).size).toBe(1);
    expect(scanSplitAt(envelopeOf(text), 0).text).toBe(text);
  });

  it('carries a surrogate pair across a chunk boundary and across a window boundary', () => {
    // The window is sized so the emoji lands exactly on the cut. Splitting it would encode
    // each half as a replacement sequence, so the text survives and the hash does not —
    // which is why the hash is asserted rather than only the text.
    const emoji = '\u{1f600}';
    for (const windowChars of [4, 5, 6, 7, 8]) {
      const text = `${'ab'.repeat(2)}${emoji}${'cd'.repeat(4)}`;
      const r = scanSplitAt(envelopeOf(text), 0, windowChars);
      expect(r.text).toBe(text);
      expect(r.hash).toBe(sha256(text));
    }
  });

  it('never emits a window larger than the budget, however the chunks arrive', () => {
    const text = 'x'.repeat(5_000);
    const scanner = new ContentScanner(256);
    const windows: DocumentWindow[] = [];
    const envelope = envelopeOf(text);
    for (let i = 0; i < envelope.length; i += 37) windows.push(...scanner.push(envelope.slice(i, i + 37)));
    windows.push(...scanner.end());

    expect(Math.max(...windows.map((w) => w.text.length))).toBeLessThanOrEqual(256);
    expect(windows.length).toBeGreaterThan(1);
    // Offsets are contiguous and indexes are in order: a consumer reassembling the document
    // from windows must not have to sort or seek.
    let offset = 0;
    windows.forEach((w, i) => {
      expect(w.index).toBe(i);
      expect(w.offset).toBe(offset);
      offset += w.text.length;
    });
    expect(scanner.chars).toBe(text.length);
    expect(scanner.textHash()).toBe(sha256(text));
  });

  it('passes Zotero cache bytes through unchanged, blank lines and form feeds included', () => {
    // The ruling of 2026-08-30: structure is lost in the chunker if it is lost at all,
    // never in transport. A scanner that trimmed or collapsed would read as tidier and
    // would have thrown away the page boundaries the segmenter is going to want.
    const text = 'page one\n\n\fpage two\n\n\n   trailing spaces   \f';
    expect(scanSplitAt(envelopeOf(text), 0).text).toBe(text);
    expect(everySplit(envelopeOf(text)).size).toBe(1);
  });

  it('reads the page counts from either side of the content field', () => {
    const before = '{"indexedPages":3,"totalPages":40,"content":"body"}';
    const after = '{"content":"body","indexedPages":3,"totalPages":40}';
    for (const envelope of [before, after]) {
      const scanner = new ContentScanner();
      scanner.push(envelope);
      scanner.end();
      expect(scanner.envelope()).toEqual({ indexedPages: 3, totalPages: 40 });
    }
  });

  it('refuses an envelope that would have to be buffered whole', () => {
    // The one door the window discipline does not cover. A response with no `content` field
    // would otherwise accumulate without bound, which is exactly the materialization this
    // file exists to prevent — so it fails rather than growing.
    const scanner = new ContentScanner();
    expect(() => scanner.push(`{"junk":"${'x'.repeat(MAX_ENVELOPE_CHARS + 1)}"}`)).toThrow(/envelope exceeded/);
  });

  it('the default window is the budgeted one', () => {
    expect(WINDOW_CHARS).toBe(64 * 1024);
  });
});

describe('the whole-document GET: over the wire', () => {
  const replay = (): ReplayLocalApi => new ReplayLocalApi();

  it('streams one attachment through the real client and reports its shape', async () => {
    const api = replay();
    const text = 'Block one.\n\nBlock two.';
    api.put('/users/0/items/ATTA0001/fulltext', {
      body: { content: text, indexedPages: 12, totalPages: 40 },
    });

    const windows: DocumentWindow[] = [];
    const { document: doc } = await streamFullText({
      source: api.client(),
      attachmentKey: 'ATTA0001',
      windowChars: 8,
      onWindow: (w) => {
        windows.push(w);
      },
    });

    expect(doc).not.toBeNull();
    expect(doc!.textHash).toBe(sha256(text));
    expect(doc!.chars).toBe(text.length);
    expect(doc!.windows).toBe(windows.length);
    expect(windows.map((w) => w.text).join('')).toBe(text);
    // 12 of 40 pages: faithful and partial. Counting this as complete coverage is how a
    // status sentence overstates itself, so the flag is derived here and stored by the stage.
    expect(doc!.truncated).toBe(true);
    expect(doc!.empty).toBe(false);
  });

  it('is not truncated when Zotero indexed the whole document', async () => {
    const api = replay();
    api.put('/users/0/items/ATTA0002/fulltext', { body: { content: 'all of it', indexedPages: 40, totalPages: 40 } });
    const { document: doc } = await streamFullText({ source: api.client(), attachmentKey: 'ATTA0002' });
    expect(doc!.truncated).toBe(false);
  });

  it('answers null when Zotero has no text, and raises when the app is unreachable', async () => {
    const api = replay();
    api.strict = false; // an unregistered route answers 404, which is "nothing extracted"
    expect((await streamFullText({ source: api.client(), attachmentKey: 'NOSUCH' })).document).toBeNull();

    api.silent = true;
    // The two must not collapse into each other: a 404 is a settled empty state, where an
    // unreachable app is a retry. Reading the second as the first would quietly mark a
    // whole library metadata-only the next time Zotero was closed during a build.
    await expect(streamFullText({ source: api.client(), attachmentKey: 'ATTA0001' })).rejects.toThrow();
  });

  it('raises on a stream that stopped inside the document rather than storing the prefix', async () => {
    // Review round 1's first blocker. This is the one way the streaming design can lie that
    // the buffering one cannot: `JSON.parse` over a cut body throws, where a scanner has
    // already handed out every window it decoded and would hash the prefix and call it the
    // text — a `done` row whose `text_hash` is over half a document, which is a wrong index
    // rather than a partial one. Note that `truncated` cannot see this: it is Zotero's page
    // cap, read from an envelope that on a cut stream never arrived.
    const api = replay();
    const whole = JSON.stringify({ content: 'a'.repeat(400), indexedPages: 4, totalPages: 4 });
    api.put('/users/0/items/ATTACUT1/fulltext', { text: whole.slice(0, 200) });

    await expect(streamFullText({ source: api.client(), attachmentKey: 'ATTACUT1' })).rejects.toThrow(
      /ended inside the document/,
    );

    // Control: the same document served whole goes through. Without this the assertion above
    // is satisfied by a reader that rejects everything.
    api.put('/users/0/items/ATTAFULL/fulltext', { text: whole });
    const read = await streamFullText({ source: api.client(), attachmentKey: 'ATTAFULL' });
    expect(read.document!.chars).toBe(400);
  });

  it('times the response, not the read', async () => {
    // The pacer's whole input. Timing the read instead would measure the corpus: the
    // near-empty snapshot and the 44,9 MB dictionary differ by orders of magnitude on a
    // Zotero behaving identically, so a back-off built on it would fire on a big document.
    const clock = new ManualClock(1_000);
    const api = new ReplayLocalApi({ clock });
    api.latencyMs = 250;
    api.put('/users/0/items/ATTA0009/fulltext', { body: { content: 'x'.repeat(50_000) } });

    const read = await streamFullText({
      source: api.client(),
      attachmentKey: 'ATTA0009',
      windowChars: 64,
      clock,
      // Reading the body costs time the measurement must not include.
      onWindow: () => {
        clock.advance(10);
      },
    });

    expect(read.document!.windows).toBeGreaterThan(700);
    expect(read.ttfbMs).toBe(250);
  });

  it('reports an empty document as empty rather than as absent', async () => {
    const api = replay();
    api.put('/users/0/items/ATTA0003/fulltext', { body: { content: '', indexedPages: 0, totalPages: 3 } });
    const { document: doc } = await streamFullText({ source: api.client(), attachmentKey: 'ATTA0003' });
    expect(doc).not.toBeNull();
    expect(doc!.empty).toBe(true);
    expect(doc!.chars).toBe(0);
  });
});
