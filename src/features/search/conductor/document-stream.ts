import { createHash } from 'node:crypto';
import type { LibraryRef } from '../../../api/web-client.js';

/**
 * The extract shim's one reading duty: the whole-document GET (SPEC.md §5.2.4, §5.2.5).
 *
 * The local API answers with the document's whole extracted text inside one JSON object.
 * Reading it with `res.json()` puts a 44,9 MB attachment in the process that asked for it,
 * and §5.2.9's arithmetic says that does not fit — which is why the fetch is the *worker's*
 * and not the conductor's, and why the decode is incremental rather than a parse. The
 * conductor, which holds the query embedder and answers queries, never sees more than one
 * window at a time.
 *
 * So this is a scanner, not a parser. It walks the response body as it arrives, finds the
 * `content` string, decodes its JSON escapes and hands the text out in bounded windows,
 * holding one window plus the envelope. The envelope — `indexedPages` and `totalPages`,
 * whichever side of `content` they land on — is read from the small remainder, and it is
 * what the per-attachment truncation flag is computed from.
 *
 * **`text_hash` is computed over the stream as it passes** (§5.2.1: the extract stage's key
 * is `text_hash` over the streamed bytes), so nothing has to hold the document to identify
 * it. The hash is over the UTF-8 bytes of the *decoded* text, which is the thing downstream
 * stages chunk — not over the JSON envelope, whose whitespace and field order are Zotero's
 * business and would make an unchanged document hash differently between releases.
 *
 * **The bytes pass through unchanged** (§5.2.4, ruling 2026-08-30): blank lines and
 * form-feed page boundaries are Zotero's cache as it stands, and the extract stage carries
 * those signals through rather than tidying them, so structure is lost in the chunker if it
 * is lost at all, never in transport.
 */

/**
 * One window's worth of decoded text. 64k characters, sized against C3's 750 MB ceiling:
 * the conductor's peak is one window plus the segmenter's state, so the window is what has
 * to stay small, and a window far below the ceiling costs only the per-window bookkeeping.
 */
export const WINDOW_CHARS = 64 * 1024;

/**
 * The envelope is three fields, two of them numbers, so anything approaching a megabyte
 * outside `content` is a response this scanner does not understand. Failing there is the
 * point: an unbounded envelope buffer is the materialization this whole file exists to
 * avoid, arriving through the one door the window discipline does not cover.
 */
export const MAX_ENVELOPE_CHARS = 1 << 20;

/**
 * The tool-identity half of the extract key (§5.2.1). It is the *shim* that is versioned
 * here, not Zotero's extractor: what this stage stores is the cache as served, so a change
 * to how the shim reads or normalises it is what makes stored text stale. A later extractor
 * replaces the shim under the same ledger boundary and bumps this.
 */
export const EXTRACTOR_ID = 'zotero-local-cache/1';

/**
 * What the worker needs from a Zotero client, and no more. `LocalApiClient` satisfies it
 * structurally, as `ZoteroSignals` is satisfied on the tick's side: the shim is written
 * against the one question it asks, never against a transport.
 */
export interface DocumentSource {
  /** The raw response for one attachment's cached text, or null when Zotero has none. */
  fetchFullTextStream(key: string, lib?: LibraryRef): Promise<Response | null>;
}

export interface DocumentWindow {
  /** Decoded text. Never split across a surrogate pair. */
  text: string;
  /** 0-based window number within this document. */
  index: number;
  /** Character offset of this window's first character in the whole document. */
  offset: number;
}

export interface StreamedDocument {
  attachmentKey: string;
  /** sha256 over the UTF-8 bytes of the decoded text, computed as it passed. */
  textHash: string;
  chars: number;
  windows: number;
  indexedPages: number | null;
  totalPages: number | null;
  /**
   * Zotero indexed fewer pages than the document has. The cap is Zotero's own, so the text
   * is faithful but partial, and saying so is what stops a partial extraction being counted
   * as complete coverage.
   */
  truncated: boolean;
  /** The attachment exists in the census and its cached text is empty. */
  empty: boolean;
}

export interface StreamFullTextOptions {
  source: DocumentSource;
  attachmentKey: string;
  lib?: LibraryRef;
  /** Called once per window, in order. Awaited, so a slow sink paces the read. */
  onWindow?: (window: DocumentWindow) => void | Promise<void>;
  windowChars?: number;
}

/**
 * Fetch one attachment's cached text and stream it out in windows.
 *
 * Returns null when Zotero has no text for the attachment at all — a 404, which the local
 * API uses for "nothing extracted" rather than for "the app is unreachable". That
 * distinction is the client's (`LocalApiError` carries the status); an unreachable app
 * raises here rather than being read as an empty document, because the two lead to opposite
 * bookkeeping.
 */
export async function streamFullText(opts: StreamFullTextOptions): Promise<StreamedDocument | null> {
  const res = await opts.source.fetchFullTextStream(opts.attachmentKey, opts.lib);
  if (res === null) return null;

  const scanner = new ContentScanner(opts.windowChars ?? WINDOW_CHARS);
  const emit = async (window: DocumentWindow): Promise<void> => {
    if (opts.onWindow) await opts.onWindow(window);
  };

  if (res.body) {
    const decoder = new TextDecoder('utf-8');
    // A byte reader rather than `res.text()`: the whole point is that no step holds the
    // document. `stream: true` is what carries a UTF-8 sequence split across two network
    // chunks, which is the failure a naive per-chunk decode produces on exactly one
    // document in a corpus and never on the fixtures.
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      for (const window of scanner.push(decoder.decode(chunk, { stream: true }))) {
        await emit(window);
      }
    }
    for (const window of scanner.push(decoder.decode())) await emit(window);
  }
  for (const window of scanner.end()) await emit(window);

  const envelope = scanner.envelope();
  const indexedPages = envelope.indexedPages;
  const totalPages = envelope.totalPages;
  return {
    attachmentKey: opts.attachmentKey,
    textHash: scanner.textHash(),
    chars: scanner.chars,
    windows: scanner.windowCount,
    indexedPages,
    totalPages,
    truncated: indexedPages !== null && totalPages !== null && indexedPages < totalPages,
    empty: scanner.chars === 0,
  };
}

/** `"content"` may be preceded or followed by the two page counts; both sides are kept. */
const CONTENT_OPEN = /"content"\s*:\s*"/;

type ScanState = 'envelope-head' | 'content' | 'envelope-tail';

/**
 * The incremental decoder, exported for its own tests.
 *
 * It is a hand-written scanner because the alternative — buffer, then `JSON.parse` — is the
 * defect. Everything it has to get right is a chunk boundary: a boundary inside a `\uXXXX`
 * escape, a boundary between the two halves of a surrogate pair, a boundary between the
 * backslash and what it escapes.
 */
export class ContentScanner {
  chars = 0;
  windowCount = 0;

  private readonly windowChars: number;
  private readonly hash = createHash('sha256');
  private state: ScanState = 'envelope-head';
  private head = '';
  private tail = '';
  private buffer = '';
  private offset = 0;
  /** A backslash arrived at the end of a chunk; what it escapes is in the next one. */
  private escaped = false;
  /** Partial `\uXXXX` payload, 0–3 hex digits, carried across a chunk boundary. */
  private unicode: string | null = null;

  constructor(windowChars: number = WINDOW_CHARS) {
    this.windowChars = Math.max(1, windowChars);
  }

  /** Feed one decoded chunk; returns whatever windows it completed. */
  push(chunk: string): DocumentWindow[] {
    if (chunk === '') return [];
    const out: DocumentWindow[] = [];
    let rest = chunk;

    if (this.state === 'envelope-head') {
      this.head += rest;
      if (this.head.length > MAX_ENVELOPE_CHARS) {
        throw new Error(`full-text envelope exceeded ${MAX_ENVELOPE_CHARS} chars before "content"`);
      }
      const match = CONTENT_OPEN.exec(this.head);
      if (!match) return out;
      rest = this.head.slice(match.index + match[0].length);
      this.head = this.head.slice(0, match.index);
      this.state = 'content';
    }

    if (this.state === 'content') {
      const decoded = this.decodeInto(rest, out);
      if (!decoded.closed) return out;
      this.state = 'envelope-tail';
      rest = decoded.rest;
    }

    this.tail += rest;
    if (this.tail.length > MAX_ENVELOPE_CHARS) {
      throw new Error(`full-text envelope exceeded ${MAX_ENVELOPE_CHARS} chars after "content"`);
    }
    return out;
  }

  /** Flush the partial window. Call once, after the last chunk. */
  end(): DocumentWindow[] {
    const out: DocumentWindow[] = [];
    if (this.buffer.length > 0) out.push(this.flush(this.buffer.length));
    return out;
  }

  textHash(): string {
    return this.hash.digest('hex');
  }

  envelope(): { indexedPages: number | null; totalPages: number | null } {
    const both = `${this.head}${this.tail}`;
    return {
      indexedPages: numberField(both, 'indexedPages'),
      totalPages: numberField(both, 'totalPages'),
    };
  }

  /**
   * Decode the JSON string body until its closing quote.
   *
   * `closed` says whether the string ended inside this chunk, and `rest` is whatever
   * followed it. Reported rather than written straight into `this.state` so the caller owns
   * the transition — the state machine has one place that advances it, which is also what
   * keeps the narrowing honest for a reader.
   */
  private decodeInto(chunk: string, out: DocumentWindow[]): { rest: string; closed: boolean } {
    let i = 0;
    let plain = '';
    const take = (s: string): void => {
      plain += s;
    };

    while (i < chunk.length) {
      const ch = chunk[i]!;

      if (this.unicode !== null) {
        const want = 4 - this.unicode.length;
        const got = chunk.slice(i, i + want);
        this.unicode += got;
        i += got.length;
        if (this.unicode.length < 4) break;
        take(String.fromCharCode(parseInt(this.unicode, 16)));
        this.unicode = null;
        continue;
      }

      if (this.escaped) {
        this.escaped = false;
        i++;
        if (ch === 'u') {
          this.unicode = '';
          continue;
        }
        take(unescapeOne(ch));
        continue;
      }

      if (ch === '\\') {
        this.escaped = true;
        i++;
        continue;
      }

      if (ch === '"') {
        this.append(plain, out);
        return { rest: chunk.slice(i + 1), closed: true };
      }

      // The common path: run to the next character that needs deciding, in one slice.
      let j = i;
      while (j < chunk.length && chunk[j] !== '\\' && chunk[j] !== '"') j++;
      take(chunk.slice(i, j));
      i = j;
    }

    this.append(plain, out);
    return { rest: '', closed: false };
  }

  private append(text: string, out: DocumentWindow[]): void {
    if (text === '') return;
    this.buffer += text;
    while (this.buffer.length >= this.windowChars) {
      let cut = this.windowChars;
      // Never cut between the halves of a surrogate pair: the two windows would each
      // encode to a UTF-8 replacement sequence, so the text would round-trip wrong and
      // `text_hash` would not match the hash of the same document read whole.
      const last = this.buffer.charCodeAt(cut - 1);
      if (last >= 0xd800 && last <= 0xdbff) cut--;
      if (cut === 0) break;
      out.push(this.flush(cut));
    }
  }

  private flush(count: number): DocumentWindow {
    const text = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    this.hash.update(Buffer.from(text, 'utf8'));
    const window = { text, index: this.windowCount, offset: this.offset };
    this.windowCount++;
    this.offset += text.length;
    this.chars += text.length;
    return window;
  }
}

function unescapeOne(ch: string): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    // `"`, `\` and `/` escape to themselves, and so does anything else Zotero emits: a
    // scanner that threw on an unknown escape would refuse a document over a byte nobody
    // reads, where passing it through loses nothing the chunker can see.
    default:
      return ch;
  }
}

function numberField(source: string, name: string): number | null {
  const match = new RegExp(`"${name}"\\s*:\\s*(-?\\d+)`).exec(source);
  return match ? Number(match[1]) : null;
}
